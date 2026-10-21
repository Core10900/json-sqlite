import fs from 'node:fs/promises';
import { decryptLine, encryptLine, isEncryptedLine } from '../crypto/aes.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document, FieldDef, SchemaMode, SyncMode } from '../types/index.js';
import { generateId } from '../utils/id.js';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { docsFile } from '../utils/path.js';
import type { Catalog } from './Catalog.js';
import type { Wal } from './Wal.js';

export class DocumentStore {
  /** In-memory primary store: collection → id → doc */
  private readonly mem = new Map<string, Map<string, Document>>();

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
        if (isEncryptedLine(line) && !this.encKey) {
          throw new JSONSQLiteError(
            ErrorCode.ENCRYPTION,
            'Encrypted collection data requires encryptionKey / JSONSQLITE_KEY',
          );
        }
        const plain = decryptLine(line, this.encKey);
        const doc = JSON.parse(plain) as Document;
        map.set(doc._id, doc);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const walEntries = await this.wal.readCommitted(name);
    for (const entry of walEntries) {
      if (entry.op === 'delete') {
        const id = (entry.payload as { _id: string })._id;
        map.delete(id);
      } else {
        const doc = entry.payload as Document;
        map.set(doc._id, doc);
      }
    }

    this.mem.set(name, map);
    this.catalog.setDocumentCount(name, map.size);
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
    const map = this.mem.get(name);
    return map ? Array.from(map.values()) : [];
  }

  getById(name: string, id: string): Document | undefined {
    return this.mem.get(name)?.get(id);
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

  async persistCollection(name: string): Promise<void> {
    const map = this.mem.get(name);
    if (!map) return;
    const file = docsFile(this.storagePath, name);
    const encrypt = this.catalog.encryption && !!this.encKey;
    const lines = Array.from(map.values())
      .map((d) => {
        const json = JSON.stringify(d);
        return encrypt ? encryptLine(json, this.encKey!) : json;
      })
      .join('\n');
    await writeFileAtomic(file, lines ? `${lines}\n` : '', this.syncMode);
    this.catalog.setDocumentCount(name, map.size);
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
  }

  /** Move in-memory map to a new collection name. */
  renameInMemory(from: string, to: string): void {
    const map = this.mem.get(from);
    if (map) {
      this.mem.set(to, map);
      this.mem.delete(from);
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
