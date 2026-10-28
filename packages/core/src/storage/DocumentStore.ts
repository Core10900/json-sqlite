import fs from 'node:fs/promises';
import { decryptLine, encryptLine, isEncryptedLine } from '../crypto/aes.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document, FieldDef, SchemaMode, SyncMode } from '../types/index.js';
import { generateId } from '../utils/id.js';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { coldDocsFile, docsFile, pageFile, pagesManifest } from '../utils/path.js';
import type { Catalog } from './Catalog.js';
import { compressLine, decompressLine } from './compress.js';
import type { Wal, WalEntry } from './Wal.js';

export interface TierSnapshot {
  enabled: boolean;
  hot: number;
  cold: number;
  delayedLoads: number;
}

export interface PageStats {
  pageSize: number;
  maxResidentDocs: number;
  residentDocs: number;
  pageReads: number;
}

export interface IndexStampStats {
  docCount: number;
  revisionSum: number;
}

interface PageMeta {
  id: number;
  count: number;
}

interface PageDirectory {
  pageSize: number;
  nextPageId: number;
  pages: PageMeta[];
  idToPage: Record<string, number>;
  docCount: number;
  revisionSum: number;
}

/**
 * Format 2 primary store: documents live in page files.
 * `pages.json` (id → page) stays resident. Document bodies are cached
 * up to `maxResidentDocs` and evicted LRU. Dirty pages are not evicted.
 */
export class DocumentStore {
  private readonly dirs = new Map<string, PageDirectory>();
  private readonly pages = new Map<string, Map<number, Map<string, Document>>>();
  private readonly dirtyPages = new Map<string, Set<number>>();
  private readonly lru = new Map<string, number[]>();
  /** Cold docs not yet promoted (tiering on). */
  private readonly coldPending = new Map<string, Map<string, Document>>();
  private readonly coldRev = new Map<string, number>();
  private readonly access = new Map<string, Map<string, number>>();
  private readonly coldOrigin = new Set<string>();
  private readonly walReplay = new Map<string, boolean>();
  private delayedLoads = 0;
  private pageReads = 0;
  private compression = false;
  private compressionThreshold = 1024;
  private tiering = false;
  private tierColdAfter = 0;
  private pageSize = 32;
  private maxResidentDocs = 256;

  /** Test hook: after writing WAL, skip snapshot persist (simulates crash). */
  crashAfterWal = false;

  /** Serializes mutations so concurrent autocommit writes cannot clobber a page. */
  private mutation: Promise<void> = Promise.resolve();

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(fn, fn);
    this.mutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

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
    ) => void | Promise<void>,
  ) {}

  configure(opts: {
    compression: boolean;
    compressionThreshold: number;
    tiering: boolean;
    tierColdAfter: number;
    pageSize: number;
    maxResidentDocs: number;
  }): void {
    this.compression = opts.compression;
    this.compressionThreshold = opts.compressionThreshold;
    this.tiering = opts.tiering;
    this.tierColdAfter = opts.tierColdAfter;
    this.pageSize = opts.pageSize;
    this.maxResidentDocs = opts.maxResidentDocs;
  }

  setCompression(enabled: boolean): void {
    this.compression = enabled;
  }

  compressionEnabled(): boolean {
    return this.compression;
  }

  isLoaded(name: string): boolean {
    return this.dirs.has(name);
  }

  loadedCollections(): string[] {
    return [...this.dirs.keys()];
  }

  pagingSnapshot(): PageStats {
    return {
      pageSize: this.pageSize,
      maxResidentDocs: this.maxResidentDocs,
      residentDocs: this.residentDocumentCount(),
      pageReads: this.pageReads,
    };
  }

  residentDocumentCount(name?: string): number {
    const names = name ? [name] : [...this.pages.keys()];
    let n = 0;
    for (const nm of names) {
      const pages = this.pages.get(nm);
      if (!pages) continue;
      for (const map of pages.values()) n += map.size;
    }
    return n;
  }

  indexStats(name: string): IndexStampStats {
    const dir = this.dirs.get(name);
    const coldN = this.coldPending.get(name)?.size ?? 0;
    return {
      docCount: (dir?.docCount ?? 0) + coldN,
      revisionSum: (dir?.revisionSum ?? 0) + (this.coldRev.get(name) ?? 0),
    };
  }

  async loadCollection(name: string): Promise<void> {
    const t0 = Date.now();
    const dir = await this.readDirectory(name);
    this.dirs.set(name, dir);
    this.pages.set(name, this.pages.get(name) ?? new Map());
    this.dirtyPages.set(name, this.dirtyPages.get(name) ?? new Set());

    const walEntries = await this.wal.readCommitted(name);
    this.walReplay.set(name, walEntries.length > 0);
    for (const entry of walEntries) {
      await this.applyWal(name, entry);
    }

    const coldDocs = await this.readDocFile(coldDocsFile(this.storagePath, name));
    this.coldPending.delete(name);
    this.coldRev.set(name, 0);
    for (const key of [...this.coldOrigin]) {
      if (key.startsWith(`${name}:`)) this.coldOrigin.delete(key);
    }
    if (this.tiering) {
      const pending = new Map<string, Document>();
      let rev = 0;
      for (const doc of coldDocs) {
        if (dir.idToPage[doc._id] !== undefined) continue;
        pending.set(doc._id, doc);
        rev += doc._version;
        this.coldOrigin.add(`${name}:${doc._id}`);
      }
      this.coldPending.set(name, pending);
      this.coldRev.set(name, rev);
    } else if (coldDocs.length > 0) {
      for (const doc of coldDocs) {
        if (dir.idToPage[doc._id] !== undefined) continue;
        await this.putExact(name, doc);
      }
    }

    this.catalog.setDocumentCount(name, this.indexStats(name).docCount);
    await this.evictToBudget(name);
    await this.onCollectionLoaded?.(name, Date.now() - t0);
  }

  async ensureLoaded(name: string): Promise<void> {
    if (!this.dirs.has(name)) {
      await this.catalog.ensure(name);
      await this.loadCollection(name);
    }
  }

  /** Scan every document. The page cache is evicted back to the budget. */
  async readAll(name: string): Promise<Document[]> {
    await this.ensureLoaded(name);
    const dir = this.dirs.get(name)!;
    const out: Document[] = [];
    for (const page of dir.pages) {
      const map = await this.loadPage(name, page.id);
      for (const doc of map.values()) out.push({ ...doc });
    }
    const cold = this.coldPending.get(name);
    if (cold) {
      for (const doc of cold.values()) out.push({ ...doc });
    }
    await this.evictToBudget(name);
    return out;
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
    let cold = 0;
    for (const pending of this.coldPending.values()) cold += pending.size;
    let promoted = 0;
    for (const key of this.coldOrigin) {
      const sep = key.indexOf(':');
      const name = key.slice(0, sep);
      const id = key.slice(sep + 1);
      if (this.dirs.get(name)?.idToPage[id] !== undefined) promoted += 1;
    }
    cold += promoted;
    let total = 0;
    for (const name of this.dirs.keys()) total += this.indexStats(name).docCount;
    const hot = Math.max(0, total - cold);
    return { enabled: true, hot, cold, delayedLoads: this.delayedLoads };
  }

  async getById(name: string, id: string): Promise<Document | undefined> {
    const dir = this.dirs.get(name);
    if (!dir) return undefined;
    const pageId = dir.idToPage[id];
    if (pageId !== undefined) {
      const map = await this.loadPage(name, pageId);
      const hit = map.get(id);
      if (hit) {
        this.noteAccess(name, id);
        return hit;
      }
    }
    const pending = this.coldPending.get(name);
    const cold = pending?.get(id);
    if (!cold) return undefined;
    pending!.delete(id);
    this.coldRev.set(name, (this.coldRev.get(name) ?? 0) - cold._version);
    await this.putExact(name, cold);
    this.coldOrigin.add(`${name}:${id}`);
    this.delayedLoads += 1;
    this.noteAccess(name, id);
    return cold;
  }

  /** Replace entire collection contents in memory (restore / time-travel). */
  replaceAll(name: string, docs: Document[]): void {
    const dir = this.emptyDir();
    this.dirs.set(name, dir);
    this.pages.set(name, new Map());
    this.dirtyPages.set(name, new Set());
    this.lru.set(name, []);
    this.coldPending.delete(name);
    this.coldRev.set(name, 0);
    for (const key of [...this.coldOrigin]) {
      if (key.startsWith(`${name}:`)) this.coldOrigin.delete(key);
    }
    for (const src of docs) {
      const doc = { ...src };
      const pageId = this.allocPage(name);
      const map = this.pageMap(name, pageId);
      map.set(doc._id, doc);
      dir.idToPage[doc._id] = pageId;
      dir.docCount += 1;
      dir.revisionSum += doc._version;
      const meta = dir.pages.find((p) => p.id === pageId)!;
      meta.count += 1;
      this.markDirty(name, pageId);
    }
    this.catalog.setDocumentCount(name, dir.docCount);
  }

  /**
   * Drop in-memory pages and reload from disk.
   * Used when a write transaction rolls back (its writes were not persisted).
   */
  async reloadFromDisk(name: string): Promise<void> {
    return this.enqueue(async () => {
      this.unload(name);
      if (!this.catalog.has(name)) return;
      await this.loadCollection(name);
    });
  }

  async insert(
    name: string,
    data: Record<string, unknown>,
    opts?: { durable?: boolean },
  ): Promise<Document> {
    return this.enqueue(() => this.insertNow(name, data, opts));
  }

  private async insertNow(
    name: string,
    data: Record<string, unknown>,
    opts?: { durable?: boolean },
  ): Promise<Document> {
    await this.ensureLoaded(name);
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
    const dir = this.dirs.get(name)!;
    if (dir.idToPage[doc._id] !== undefined || this.coldPending.get(name)?.has(doc._id)) {
      throw new JSONSQLiteError(
        ErrorCode.VERSION_CONFLICT,
        `Document already exists: ${doc._id}`,
      );
    }
    await this.putExact(name, doc);
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
    return this.enqueue(() => this.updateNow(name, id, patch, opts));
  }

  private async updateNow(
    name: string,
    id: string,
    patch: Record<string, unknown>,
    opts?: { expectedVersion?: number; durable?: boolean },
  ): Promise<Document> {
    await this.ensureLoaded(name);
    const existing = await this.getById(name, id);
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
    const dir = this.dirs.get(name)!;
    dir.revisionSum += 1;
    const pageId = dir.idToPage[id];
    if (pageId === undefined) {
      throw new JSONSQLiteError(ErrorCode.DOCUMENT_NOT_FOUND, `Document not found: ${id}`);
    }
    const map = await this.loadPage(name, pageId);
    map.set(id, doc);
    this.markDirty(name, pageId);

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
    return this.enqueue(() => this.deleteNow(name, id, opts));
  }

  private async deleteNow(
    name: string,
    id: string,
    opts?: { durable?: boolean },
  ): Promise<boolean> {
    await this.ensureLoaded(name);
    const existing = await this.getById(name, id);
    if (!existing) return false;
    this.removeExact(name, id, existing._version);
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
    return this.enqueue(() => this.upsertNow(name, data, opts));
  }

  private async upsertNow(
    name: string,
    data: Record<string, unknown>,
    opts?: { durable?: boolean },
  ): Promise<Document> {
    const id = typeof data._id === 'string' ? data._id : undefined;
    if (id) {
      await this.ensureLoaded(name);
      if (await this.getById(name, id)) {
        return this.updateNow(name, id, data, opts);
      }
    }
    return this.insertNow(name, data, opts);
  }

  async commitCollections(names: string[]): Promise<void> {
    return this.enqueue(async () => {
      for (const name of new Set(names)) {
        if (!this.dirs.has(name)) continue;
        await this.persistNow(name);
      }
    });
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
    await this.persistNow(name);
  }

  async sweepTiers(): Promise<void> {
    return this.enqueue(() => this.sweepTiersNow());
  }

  private async sweepTiersNow(): Promise<void> {
    if (!this.tiering) return;
    const names = new Set<string>([
      ...this.dirs.keys(),
      ...this.coldPending.keys(),
    ]);
    for (const name of names) {
      await this.ensureLoaded(name);
      const docs = await this.readAll(name);
      const hot: Document[] = [];
      const cold: Document[] = [];
      const counts = this.access.get(name);
      for (const doc of docs) {
        const n = counts?.get(doc._id) ?? 0;
        if (n <= this.tierColdAfter) cold.push(doc);
        else hot.push(doc);
      }
      this.replaceAll(name, hot);
      const pending = new Map<string, Document>();
      let rev = 0;
      for (const doc of cold) {
        pending.set(doc._id, doc);
        rev += doc._version;
        this.coldOrigin.add(`${name}:${doc._id}`);
      }
      this.coldPending.set(name, pending);
      this.coldRev.set(name, rev);
      this.catalog.setDocumentCount(name, hot.length + cold.length);
      await this.persistNow(name);
    }
  }

  async persistCollection(name: string): Promise<void> {
    return this.enqueue(() => this.persistNow(name));
  }

  async replaceAllDurable(name: string, docs: Document[]): Promise<void> {
    return this.enqueue(async () => {
      this.replaceAll(name, docs);
      await this.persistNow(name);
    });
  }

  private async persistNow(name: string): Promise<void> {
    const dir = this.dirs.get(name);
    if (!dir) return;
    const dirty = this.dirtyPages.get(name) ?? new Set<number>();
    for (const pageId of dirty) {
      const map = this.pages.get(name)?.get(pageId) ?? new Map<string, Document>();
      await this.writePage(name, pageId, map);
    }
    dirty.clear();
    await writeFileAtomic(
      pagesManifest(this.storagePath, name),
      JSON.stringify(dir),
      this.syncMode,
    );
    if (this.tiering) {
      await this.writeColdFile(name, this.coldPending.get(name) ?? new Map());
    } else {
      await fs.rm(coldDocsFile(this.storagePath, name), { force: true });
    }
    this.catalog.setDocumentCount(name, this.indexStats(name).docCount);
    await this.catalog.save();
    await this.wal.truncate(name);
    this.walReplay.set(name, false);
    await this.evictToBudget(name);
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
    return this.enqueue(async () => {
      for (const name of this.dirs.keys()) {
        await this.persistNow(name);
      }
    });
  }

  unload(name: string): void {
    this.dirs.delete(name);
    this.pages.delete(name);
    this.dirtyPages.delete(name);
    this.lru.delete(name);
    this.coldPending.delete(name);
    this.coldRev.delete(name);
    this.access.delete(name);
    this.walReplay.delete(name);
    for (const key of [...this.coldOrigin]) {
      if (key.startsWith(`${name}:`)) this.coldOrigin.delete(key);
    }
  }

  renameInMemory(from: string, to: string): void {
    moveKey(this.dirs, from, to);
    moveKey(this.pages, from, to);
    moveKey(this.dirtyPages, from, to);
    moveKey(this.lru, from, to);
    moveKey(this.coldPending, from, to);
    moveKey(this.coldRev, from, to);
    moveKey(this.access, from, to);
    const replay = this.walReplay.get(from);
    if (replay !== undefined) {
      this.walReplay.set(to, replay);
      this.walReplay.delete(from);
    }
    for (const key of [...this.coldOrigin]) {
      if (key.startsWith(`${from}:`)) {
        this.coldOrigin.delete(key);
        this.coldOrigin.add(`${to}:${key.slice(from.length + 1)}`);
      }
    }
  }

  private async applyWal(name: string, entry: WalEntry): Promise<void> {
    if (entry.op === 'delete') {
      const id = (entry.payload as { _id: string })._id;
      const existing = await this.getById(name, id);
      if (!existing) return;
      this.removeExact(name, id, existing._version);
      return;
    }
    await this.putExact(name, entry.payload as Document);
  }

  private async putExact(name: string, doc: Document): Promise<void> {
    const dir = this.dirs.get(name)!;
    const existingPage = dir.idToPage[doc._id];
    if (existingPage !== undefined) {
      const map = await this.loadPage(name, existingPage);
      const prev = map.get(doc._id);
      if (prev) dir.revisionSum -= prev._version;
      else dir.docCount += 1;
      map.set(doc._id, doc);
      dir.revisionSum += doc._version;
      this.markDirty(name, existingPage);
      this.catalog.setDocumentCount(name, this.indexStats(name).docCount);
      return;
    }
    const pageId = this.allocPage(name);
    const map = await this.loadPage(name, pageId);
    map.set(doc._id, doc);
    dir.idToPage[doc._id] = pageId;
    const meta = dir.pages.find((p) => p.id === pageId)!;
    meta.count += 1;
    dir.docCount += 1;
    dir.revisionSum += doc._version;
    this.markDirty(name, pageId);
    this.catalog.setDocumentCount(name, this.indexStats(name).docCount);
  }

  private removeExact(name: string, id: string, version: number): void {
    const dir = this.dirs.get(name)!;
    const cold = this.coldPending.get(name);
    if (cold?.has(id)) {
      cold.delete(id);
      this.coldRev.set(name, (this.coldRev.get(name) ?? 0) - version);
      this.coldOrigin.delete(`${name}:${id}`);
      this.catalog.setDocumentCount(name, this.indexStats(name).docCount);
      return;
    }
    const pageId = dir.idToPage[id];
    if (pageId === undefined) return;
    const map = this.pages.get(name)?.get(pageId);
    map?.delete(id);
    delete dir.idToPage[id];
    const meta = dir.pages.find((p) => p.id === pageId);
    if (meta) meta.count = Math.max(0, meta.count - 1);
    dir.docCount = Math.max(0, dir.docCount - 1);
    dir.revisionSum -= version;
    this.coldOrigin.delete(`${name}:${id}`);
    this.markDirty(name, pageId);
    this.catalog.setDocumentCount(name, this.indexStats(name).docCount);
  }

  private emptyDir(): PageDirectory {
    return {
      pageSize: this.pageSize,
      nextPageId: 1,
      pages: [],
      idToPage: {},
      docCount: 0,
      revisionSum: 0,
    };
  }

  private allocPage(name: string): number {
    const dir = this.dirs.get(name)!;
    const last = dir.pages[dir.pages.length - 1];
    if (last && last.count < dir.pageSize) return last.id;
    const id = dir.nextPageId++;
    dir.pages.push({ id, count: 0 });
    return id;
  }

  private pageMap(name: string, pageId: number): Map<string, Document> {
    let pages = this.pages.get(name);
    if (!pages) {
      pages = new Map();
      this.pages.set(name, pages);
    }
    let map = pages.get(pageId);
    if (!map) {
      map = new Map();
      pages.set(pageId, map);
    }
    return map;
  }

  private markDirty(name: string, pageId: number): void {
    let dirty = this.dirtyPages.get(name);
    if (!dirty) {
      dirty = new Set();
      this.dirtyPages.set(name, dirty);
    }
    dirty.add(pageId);
    this.touchLru(name, pageId);
  }

  private touchLru(name: string, pageId: number): void {
    let list = this.lru.get(name);
    if (!list) {
      list = [];
      this.lru.set(name, list);
    }
    const i = list.indexOf(pageId);
    if (i >= 0) list.splice(i, 1);
    list.push(pageId);
  }

  private async loadPage(name: string, pageId: number): Promise<Map<string, Document>> {
    const existing = this.pages.get(name)?.get(pageId);
    if (existing) {
      this.touchLru(name, pageId);
      return existing;
    }
    const map = new Map<string, Document>();
    const file = pageFile(this.storagePath, name, pageId);
    try {
      const raw = await fs.readFile(file, 'utf8');
      this.pageReads += 1;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const doc = this.decodeStoredLine(line);
        map.set(doc._id, doc);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.pageMap(name, pageId);
    this.pages.get(name)!.set(pageId, map);
    this.touchLru(name, pageId);
    await this.evictToBudget(name, pageId);
    return map;
  }

  private async evictToBudget(name: string, pin?: number): Promise<void> {
    const dirty = this.dirtyPages.get(name);
    const lru = this.lru.get(name);
    const pages = this.pages.get(name);
    if (!lru || !pages) return;
    while (this.residentDocumentCount(name) > this.maxResidentDocs) {
      const victim = lru.find((id) => id !== pin && !dirty?.has(id));
      if (victim === undefined) break;
      pages.delete(victim);
      const idx = lru.indexOf(victim);
      if (idx >= 0) lru.splice(idx, 1);
    }
  }

  private async readDirectory(name: string): Promise<PageDirectory> {
    const file = pagesManifest(this.storagePath, name);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as PageDirectory;
      if (!parsed || !Array.isArray(parsed.pages) || typeof parsed.idToPage !== 'object') {
        throw new JSONSQLiteError(
          ErrorCode.INTERNAL,
          `pages.json is corrupt for collection ${name}`,
        );
      }
      return parsed;
    } catch (err) {
      if (err instanceof JSONSQLiteError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new JSONSQLiteError(
          ErrorCode.INTERNAL,
          `pages.json is corrupt for collection ${name}`,
        );
      }
    }

    const legacy = await this.readDocFile(docsFile(this.storagePath, name));
    if (legacy.length === 0) return this.emptyDir();
    const dir = this.emptyDir();
    this.dirs.set(name, dir);
    this.pages.set(name, new Map());
    this.dirtyPages.set(name, new Set());
    for (const doc of legacy) {
      const pageId = this.allocPage(name);
      const map = this.pageMap(name, pageId);
      map.set(doc._id, doc);
      dir.idToPage[doc._id] = pageId;
      dir.docCount += 1;
      dir.revisionSum += doc._version;
      dir.pages.find((p) => p.id === pageId)!.count += 1;
      this.markDirty(name, pageId);
    }
    return dir;
  }

  private async writePage(
    name: string,
    pageId: number,
    docs: Map<string, Document>,
  ): Promise<void> {
    const lines = Array.from(docs.values())
      .map((d) => this.encodeStored(JSON.stringify(d)))
      .join('\n');
    await writeFileAtomic(
      pageFile(this.storagePath, name, pageId),
      lines ? `${lines}\n` : '',
      this.syncMode,
    );
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
}

function moveKey<V>(map: Map<string, V>, from: string, to: string): void {
  if (!map.has(from)) return;
  map.set(to, map.get(from)!);
  map.delete(from);
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
