import fs from 'node:fs/promises';
import { decryptLine, encryptLine, isEncryptedLine } from '../crypto/aes.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document, FieldDef, SchemaMode, SyncMode } from '../types/index.js';
import { generateId } from '../utils/id.js';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { coldDocsFile, docsFile } from '../utils/path.js';
import type { Catalog } from './Catalog.js';
import { compressLine, decompressLine } from './compress.js';
import type { Wal } from './Wal.js';

export interface TierSnapshot {
  enabled: boolean;
  hot: number;
  cold: number;
  delayedLoads: number;
}

export class DocumentStore {
  /** In-memory primary store: collection → id → doc */
  private readonly mem = new Map<string, Map<string, Document>>();
  /** Cold docs not yet promoted into `mem` (tiering on). */
  private readonly coldPending = new Map<string, Map<string, Document>>();
  private readonly access = new Map<string, Map<string, number>>();
  private readonly coldOrigin = new Set<string>();
  private readonly walReplay = new Map<string, boolean>();
  private delayedLoads = 0;
  private compression = false;
  private compressionThreshold = 1024;
  private tiering = false;
  private tierColdAfter = 0;

  /** Test hook: after writing WAL, skip snapshot persist (simulates crash). */
  crashAfterWal = false;

  constructor(
    private readonly storagePath: string,
    private readonly catalog: Catalog,
    private readonly wal: Wal,
    private readonly syncMode: SyncMode = 'normal',
    private readonly schemaMode: SchemaMode = 'off',
    private readonly encKey: Buffer | null = null,
    private readonly onCollectionLoaded?: (
      name: string,
      loadMs: number,
    ) => void,
  ) {}

  configure(opts: {
    compression: boolean;
    compressionThreshold: number;
    tiering: boolean;
    tierColdAfter: number;
  }): void {
    this.compression = opts.compression;
    this.compressionThreshold = opts.compressionThreshold;
    this.tiering = opts.tiering;
    this.tierColdAfter = opts.tierColdAfter;
  }

  /** Turn compression on for subsequent persists (vacuum --compress). */
  setCompression(enabled: boolean): void {
    this.compression = enabled;
  }

  compressionEnabled(): boolean {
    return this.compression;
  }

  isLoaded(name: string): boolean {
    return this.mem.has(name);
  }

  loadedCollections(): string[] {
    return [...this.mem.keys()];
  }

  async loadCollection(name: string): Promise<void> {
    const t0 = Date.now();
    const map = new Map<string, Document>();
    const file = docsFile(this.storagePath, name);
    try {
      const raw = await fs.readFile(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const doc = this.decodeStoredLine(line);
        map.set(doc._id, doc);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const walEntries = await this.wal.readCommitted(name);
    const walTouched = new Set<string>();
    for (const entry of walEntries) {
      if (entry.op === 'delete') {
        const id = (entry.payload as { _id: string })._id;
        map.delete(id);
        walTouched.add(id);
      } else {
        const doc = entry.payload as Document;
        map.set(doc._id, doc);
        walTouched.add(doc._id);
      }
    }
    this.walReplay.set(name, walEntries.length > 0);

    const coldDocs = await this.readDocFile(coldDocsFile(this.storagePath, name));
    this.coldPending.delete(name);
    for (const key of [...this.coldOrigin]) {
      if (key.startsWith(`${name}:`)) this.coldOrigin.delete(key);
    }
    if (this.tiering) {
      const pending = new Map<string, Document>();
      for (const doc of coldDocs) {
        if (walTouched.has(doc._id) || map.has(doc._id)) continue;
        pending.set(doc._id, doc);
        this.coldOrigin.add(`${name}:${doc._id}`);
      }
      this.coldPending.set(name, pending);
    } else {
      for (const doc of coldDocs) {
        if (walTouched.has(doc._id) || map.has(doc._id)) continue;
        map.set(doc._id, doc);
      }
    }

    this.mem.set(name, map);
    const coldN = this.coldPending.get(name)?.size ?? 0;
    this.catalog.setDocumentCount(name, map.size + coldN);
    this.onCollectionLoaded?.(name, Date.now() - t0);
  }

  async ensureLoaded(name: string): Promise<Map<string, Document>> {
    if (!this.mem.has(name)) {
      await this.catalog.ensure(name);
      await this.loadCollection(name);
    }
    return this.mem.get(name)!;
  }

  getAll(name: string): Document[] {
    this.materializeCold(name);
    const map = this.mem.get(name);
    return map ? Array.from(map.values()) : [];
  }

  /**
   * Hot docs plus cold docs still on the side file, without promoting them.
   * Index rebuild / segment stamps use this so a scan does not hide tiering.
   */
  docsForIndex(name: string): Document[] {
    const hot = this.mem.get(name);
    const cold = this.coldPending.get(name);
    if (!hot && !cold) return [];
    return [...(hot ? hot.values() : []), ...(cold ? cold.values() : [])];
  }

  hadWalReplay(name: string): boolean {
    return this.walReplay.get(name) === true;
  }

  noteAccess(name: string, id: string): void {
    if (!this.tiering) return;
    let counts = this.access.get(name);
    if (!counts) {
      counts = new Map();
      this.access.set(name, counts);
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  tierSnapshot(): TierSnapshot {
    if (!this.tiering) {
      return { enabled: false, hot: 0, cold: 0, delayedLoads: 0 };
    }
    let hot = 0;
    let cold = 0;
    for (const [name, map] of this.mem) {
      for (const id of map.keys()) {
        if (this.coldOrigin.has(`${name}:${id}`)) cold += 1;
        else hot += 1;
      }
    }
    for (const pending of this.coldPending.values()) cold += pending.size;
    return { enabled: true, hot, cold, delayedLoads: this.delayedLoads };
  }

  getById(name: string, id: string): Document | undefined {
    const hit = this.mem.get(name)?.get(id);
    if (hit) {
      this.noteAccess(name, id);
      return hit;
    }
    const pending = this.coldPending.get(name);
    const cold = pending?.get(id);
    if (!cold) return undefined;
    pending!.delete(id);
    let map = this.mem.get(name);
    if (!map) {
      map = new Map();
      this.mem.set(name, map);
    }
    map.set(id, cold);
    this.coldOrigin.add(`${name}:${id}`);
    this.delayedLoads += 1;
    this.noteAccess(name, id);
    return cold;
  }

  /** Replace entire collection contents in memory (restore / time-travel). */
  replaceAll(name: string, docs: Document[]): void {
    const map = new Map<string, Document>();
    for (const d of docs) map.set(d._id, { ...d });
    this.mem.set(name, map);
    this.catalog.setDocumentCount(name, map.size);
  }

  /** Replace in-memory maps (transaction rollback). */
  restoreSnapshot(collections: Map<string, Map<string, Document>>): void {
    for (const [name, map] of collections) {
      const clone = new Map<string, Document>();
      for (const [id, doc] of map) clone.set(id, { ...doc });
      this.mem.set(name, clone);
      this.catalog.setDocumentCount(name, clone.size);
    }
  }

  async insert(
    name: string,
    data: Record<string, unknown>,
    opts?: { durable?: boolean },
  ): Promise<Document> {
    const map = await this.ensureLoaded(name);
    const stripped = stripSystemFields(data);
    this.applySchema(name, stripped);
    const now = Date.now();
    const doc: Document = {
      ...stripped,
      _id: typeof data._id === 'string' ? data._id : generateId(),
      _version: 1,
      _createdAt: now,
      _updatedAt: now,
    };
    if (map.has(doc._id)) {
      throw new JSONSQLiteError(
        ErrorCode.VERSION_CONFLICT,
        `Document already exists: ${doc._id}`,
      );
    }
    map.set(doc._id, doc);
    this.catalog.setDocumentCount(name, map.size);

    if (opts?.durable !== false) {
      await this.durableWrite(name, 'insert', doc);
    }
    return { ...doc };
  }

  async update(
    name: string,
    id: string,
    patch: Record<string, unknown>,
    opts?: { expectedVersion?: number; durable?: boolean },
  ): Promise<Document> {
    const map = await this.ensureLoaded(name);
    const existing = map.get(id);
    if (!existing) {
      throw new JSONSQLiteError(
        ErrorCode.DOCUMENT_NOT_FOUND,
        `Document not found: ${id}`,
      );
    }
    if (
      opts?.expectedVersion !== undefined &&
      existing._version !== opts.expectedVersion
    ) {
      throw new JSONSQLiteError(
        ErrorCode.VERSION_CONFLICT,
        `Version conflict for ${id}: expected ${opts.expectedVersion}, got ${existing._version}`,
      );
    }
    const now = Date.now();
    const merged = { ...stripSystemFields(existing), ...stripSystemFields(patch) };
    this.applySchema(name, merged);
    const doc: Document = {
      ...existing,
      ...stripSystemFields(patch),
      _id: existing._id,
      _version: existing._version + 1,
      _createdAt: existing._createdAt,
      _updatedAt: now,
    };
    map.set(id, doc);

    if (opts?.durable !== false) {
      await this.durableWrite(name, 'update', doc);
    }
    return { ...doc };
  }

  async delete(
    name: string,
    id: string,
    opts?: { durable?: boolean },
  ): Promise<boolean> {
    const map = await this.ensureLoaded(name);
    if (!map.has(id)) return false;
    map.delete(id);
    this.catalog.setDocumentCount(name, map.size);

    if (opts?.durable !== false) {
      await this.durableWrite(name, 'delete', { _id: id } as Document);
    }
    return true;
  }

  async upsert(
    name: string,
    data: Record<string, unknown>,
    opts?: { durable?: boolean },
  ): Promise<Document> {
    const id = typeof data._id === 'string' ? data._id : undefined;
    if (id) {
      const map = await this.ensureLoaded(name);
      if (map.has(id)) {
        return this.update(name, id, data, opts);
      }
    }
    return this.insert(name, data, opts);
  }

  /** Persist all touched collections (transaction commit). */
  async commitCollections(names: string[]): Promise<void> {
    for (const name of new Set(names)) {
      const map = this.mem.get(name);
      if (!map) continue;
      // Write a compact WAL checkpoint of current state via full persist
      await this.persistCollection(name);
    }
  }

  private async durableWrite(
    name: string,
    op: 'insert' | 'update' | 'delete',
    payload: Document | { _id: string },
  ): Promise<void> {
    await this.wal.append({
      ts: Date.now(),
      txId: null,
      committed: true,
      op,
      collection: name,
      payload,
    });
    if (this.crashAfterWal) {
      throw new JSONSQLiteError(
        ErrorCode.INTERNAL,
        'Simulated crash after WAL write',
      );
    }
    await this.persistCollection(name);
  }

  /**
   * Move rarely read docs to cold.jsonl. No-op when tiering is off, so
   * close() keeps the 1.7 layout.
   */
  async sweepTiers(): Promise<void> {
    if (!this.tiering) return;
    const names = new Set<string>([
      ...this.mem.keys(),
      ...this.coldPending.keys(),
    ]);
    for (const name of names) {
      const hot = new Map<string, Document>();
      const cold = new Map<string, Document>();
      const counts = this.access.get(name);
      const place = (id: string, doc: Document) => {
        const n = counts?.get(id) ?? 0;
        if (n <= this.tierColdAfter) {
          cold.set(id, doc);
          this.coldOrigin.add(`${name}:${id}`);
        } else {
          hot.set(id, doc);
          this.coldOrigin.delete(`${name}:${id}`);
        }
      };
      for (const [id, doc] of this.mem.get(name) ?? []) place(id, doc);
      for (const [id, doc] of this.coldPending.get(name) ?? []) place(id, doc);
      this.mem.set(name, hot);
      this.coldPending.set(name, cold);
      await this.persistCollection(name);
    }
  }

  async persistCollection(name: string): Promise<void> {
    const map = this.mem.get(name);
    if (!map) return;
    const file = docsFile(this.storagePath, name);
    const lines = Array.from(map.values())
      .map((d) => this.encodeStored(JSON.stringify(d)))
      .join('\n');
    await writeFileAtomic(file, lines ? `${lines}\n` : '', this.syncMode);
    if (this.tiering) {
      await this.writeColdFile(name, this.coldPending.get(name) ?? new Map());
    } else {
      await fs.rm(coldDocsFile(this.storagePath, name), { force: true });
    }
    const coldN = this.tiering ? (this.coldPending.get(name)?.size ?? 0) : 0;
    this.catalog.setDocumentCount(name, map.size + coldN);
    await this.catalog.save();
    await this.wal.truncate(name);
  }

  private applySchema(name: string, data: Record<string, unknown>): void {
    if (this.schemaMode === 'off') return;
    const fields = this.catalog.get(name)?.fields;
    if (!fields || fields.length === 0) return;
    const issues = validateAgainstSchema(data, fields);
    if (issues.length === 0) return;
    const msg = `Schema violation on ${name}: ${issues.join('; ')}`;
    if (this.schemaMode === 'strict') {
      throw new JSONSQLiteError(ErrorCode.SCHEMA_VIOLATION, msg, issues);
    }
    console.warn(`[jsonsqlite] ${msg}`);
  }

  async flushAll(): Promise<void> {
    for (const name of this.mem.keys()) {
      await this.persistCollection(name);
    }
  }

  /** Remove collection from memory (after drop). */
  unload(name: string): void {
    this.mem.delete(name);
    this.coldPending.delete(name);
    this.access.delete(name);
    this.walReplay.delete(name);
    for (const key of [...this.coldOrigin]) {
      if (key.startsWith(`${name}:`)) this.coldOrigin.delete(key);
    }
  }

  private materializeCold(name: string): void {
    const pending = this.coldPending.get(name);
    if (!pending || pending.size === 0) return;
    let map = this.mem.get(name);
    if (!map) {
      map = new Map();
      this.mem.set(name, map);
    }
    for (const [id, doc] of pending) {
      map.set(id, doc);
      this.coldOrigin.add(`${name}:${id}`);
      this.delayedLoads += 1;
    }
    pending.clear();
  }

  private async readDocFile(file: string): Promise<Document[]> {
    const docs: Document[] = [];
    try {
      const raw = await fs.readFile(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        docs.push(this.decodeStoredLine(line));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return docs;
  }

  private async writeColdFile(
    name: string,
    docs: Map<string, Document>,
  ): Promise<void> {
    const lines = Array.from(docs.values())
      .map((d) => this.encodeStored(JSON.stringify(d)))
      .join('\n');
    await writeFileAtomic(
      coldDocsFile(this.storagePath, name),
      lines ? `${lines}\n` : '',
      this.syncMode,
    );
  }

  private encodeStored(json: string): string {
    let payload = json;
    if (this.compression) {
      payload = compressLine(payload, this.compressionThreshold);
    }
    if (this.catalog.encryption && this.encKey) {
      payload = encryptLine(payload, this.encKey);
    }
    return payload;
  }

  private decodeStoredLine(line: string): Document {
    if (isEncryptedLine(line) && !this.encKey) {
      throw new JSONSQLiteError(
        ErrorCode.ENCRYPTION,
        'Encrypted collection data requires encryptionKey / JSONSQLITE_KEY',
      );
    }
    const plain = decompressLine(decryptLine(line, this.encKey));
    return JSON.parse(plain) as Document;
  }

  /** Move in-memory map to a new collection name. */
  renameInMemory(from: string, to: string): void {
    const map = this.mem.get(from);
    if (map) {
      this.mem.set(to, map);
      this.mem.delete(from);
    }
    const cold = this.coldPending.get(from);
    if (cold) {
      this.coldPending.set(to, cold);
      this.coldPending.delete(from);
    }
    const counts = this.access.get(from);
    if (counts) {
      this.access.set(to, counts);
      this.access.delete(from);
    }
  }
}

export function validateAgainstSchema(
  data: Record<string, unknown>,
  fields: FieldDef[],
): string[] {
  const issues: string[] = [];
  for (const f of fields) {
    const v = data[f.name];
    if (f.required && (v === undefined || v === null)) {
      issues.push(`missing required field '${f.name}'`);
      continue;
    }
    if (v === undefined || v === null) continue;
    if (f.type === 'any' || f.type === 'json') continue;
    if (f.type === 'string' && typeof v !== 'string') {
      issues.push(`field '${f.name}' expected string`);
    } else if (f.type === 'number' && typeof v !== 'number') {
      issues.push(`field '${f.name}' expected number`);
    } else if (f.type === 'boolean' && typeof v !== 'boolean') {
      issues.push(`field '${f.name}' expected boolean`);
    }
  }
  return issues;
}

function stripSystemFields(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...data };
  delete rest._id;
  delete rest._version;
  delete rest._createdAt;
  delete rest._updatedAt;
  return rest;
}
