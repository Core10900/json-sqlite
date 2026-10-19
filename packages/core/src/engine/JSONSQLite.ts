import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {
  resolveEncryptionKey,
  resolveOptions,
  type ResolvedOptions,
} from '../config/defaults.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { L1Cache } from '../cache/L1Cache.js';
import { IndexManager } from '../index/IndexManager.js';
import type { IndexType } from '../index/types.js';
import { planAndExecute } from '../query/Planner.js';
import {
  executeAggregate,
  type AggregateStage,
} from '../query/Aggregate.js';
import { selectJsonPath } from '../query/JsonPath.js';
import { Catalog } from '../storage/Catalog.js';
import { ChangeLog } from '../storage/ChangeLog.js';
import { DocumentStore } from '../storage/DocumentStore.js';
import { FileLock } from '../storage/FileLock.js';
import { Wal } from '../storage/Wal.js';
import { TransactionManager } from '../transaction/TransactionManager.js';
import { BackupManager, type BackupInfo } from '../backup/BackupManager.js';
import { Monitor } from '../monitor/Monitor.js';
import {
  diffDocs,
  queryAtTime,
  reconstructAtTime,
} from '../features/TimeTravel.js';
import { adviseQuery, profileStages } from '../features/QueryAdvisor.js';
import { analyzeQuality } from '../features/DataQuality.js';
import { startHttpServer, type HttpServerOptions } from '../api/httpServer.js';
import type {
  CollectionInfo,
  Document,
  IsolationLevel,
  JsonQuery,
  JSONSQLiteOptions,
} from '../types/index.js';

export class JSONSQLite extends EventEmitter {
  private readonly options: ResolvedOptions;
  private readonly encKey: Buffer | null;
  private lock: FileLock | null = null;
  private catalog: Catalog | null = null;
  private wal: Wal | null = null;
  private store: DocumentStore | null = null;
  private tx: TransactionManager | null = null;
  private indexes: IndexManager | null = null;
  private cache: L1Cache<Document[]> | null = null;
  private changelog: ChangeLog | null = null;
  private backup: BackupManager | null = null;
  private monitor = new Monitor();
  private httpServer: http.Server | null = null;
  private ready = false;
  private lastBackupTs = 0;

  constructor(options: JSONSQLiteOptions) {
    super();
    this.options = resolveOptions(options);
    this.encKey = resolveEncryptionKey(this.options.encryptionKey);
  }

  get isReady(): boolean {
    return this.ready;
  }

  get storagePath(): string {
    return path.resolve(this.options.storagePath);
  }

  /** @internal test hook */
  get _store(): DocumentStore {
    this.assertReady();
    return this.store!;
  }

  async open(): Promise<this> {
    if (this.ready) {
      throw new JSONSQLiteError(ErrorCode.ALREADY_OPEN, 'Database already open');
    }

    const root = this.storagePath;
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(root, 'meta'), { recursive: true });
    await fs.mkdir(path.join(root, 'collections'), { recursive: true });
    await fs.mkdir(path.join(root, 'wal'), { recursive: true });
    await fs.mkdir(path.join(root, 'deltas'), { recursive: true });
    await fs.mkdir(path.join(root, 'backups'), { recursive: true });

    this.lock = new FileLock(root);
    await this.lock.acquire();

    this.catalog = new Catalog(root);
    await this.catalog.load();

    this.wal = new Wal(root, this.options.walMode);
    await this.wal.initialize();

    this.store = new DocumentStore(root, this.catalog, this.wal);
    this.tx = new TransactionManager(this.store);
    this.changelog = new ChangeLog(root);
    this.cache = new L1Cache(this.options.cacheSize);
    this.indexes = new IndexManager(root);
    this.backup = new BackupManager(root, this.encKey);

    for (const info of this.catalog.list()) {
      await this.store.loadCollection(info.name);
    }

    await this.indexes.load((name) => this.store!.getAll(name));

    this.ready = true;
    this.emit('ready');
    return this;
  }

  async close(opts?: { flush?: boolean }): Promise<void> {
    if (!this.ready) return;
    if (this.tx?.active) await this.tx.rollback();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
    if (opts?.flush !== false) {
      await this.store?.flushAll();
      await this.catalog?.save();
      await this.indexes?.save();
    }
    await this.lock?.release();
    this.ready = false;
    this.store = null;
    this.catalog = null;
    this.wal = null;
    this.tx = null;
    this.indexes = null;
    this.cache = null;
    this.changelog = null;
    this.backup = null;
    this.lock = null;
    this.emit('close');
  }

  async createCollection(name: string): Promise<CollectionInfo> {
    this.assertReady();
    return this.catalog!.create(name);
  }

  async listCollections(): Promise<CollectionInfo[]> {
    this.assertReady();
    return this.catalog!.list();
  }

  async createIndex(
    collection: string,
    field: string,
    type: IndexType = 'object',
  ) {
    this.assertReady();
    await this.store!.ensureLoaded(collection);
    const meta = await this.indexes!.createIndex(
      collection,
      field,
      type,
      this.store!.getAll(collection),
    );
    this.cache!.invalidateCollection(collection);
    return meta;
  }

  async listIndexes() {
    this.assertReady();
    return this.indexes!.list();
  }

  async dropIndex(collection: string, field: string) {
    this.assertReady();
    await this.indexes!.dropIndex(collection, field);
    this.cache!.invalidateCollection(collection);
  }

  async insert(
    collection: string,
    data: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<Document | Document[]> {
    this.assertReady();
    const inTx = !!this.tx!.active;
    if (inTx) await this.tx!.touch(collection);

    if (Array.isArray(data)) {
      const out: Document[] = [];
      for (const item of data) {
        const doc = await this.store!.insert(collection, item, {
          durable: !inTx,
        });
        if (!inTx) {
          this.indexes!.onInsert(collection, doc);
          await this.changelog!.append({
            ts: Date.now(),
            op: 'insert',
            collection,
            id: doc._id,
            before: null,
            after: doc,
          });
        }
        out.push(doc);
      }
      if (!inTx) {
        this.cache!.invalidateCollection(collection);
        this.monitor.recordWrite();
      }
      this.emit('dataChanged', { op: 'insert', collection, count: out.length });
      return out;
    }

    const doc = await this.store!.insert(collection, data, { durable: !inTx });
    if (!inTx) {
      this.indexes!.onInsert(collection, doc);
      await this.changelog!.append({
        ts: Date.now(),
        op: 'insert',
        collection,
        id: doc._id,
        before: null,
        after: doc,
      });
      this.cache!.invalidateCollection(collection);
      this.monitor.recordWrite();
    }
    this.emit('dataChanged', { op: 'insert', collection, id: doc._id });
    return doc;
  }

  async update(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    opts?: { expectedVersion?: number },
  ): Promise<Document> {
    this.assertReady();
    const inTx = !!this.tx!.active;
    if (inTx) await this.tx!.touch(collection);
    const prev = this.store!.getById(collection, id);
    const doc = await this.store!.update(collection, id, patch, {
      ...opts,
      durable: !inTx,
    });
    if (!inTx) {
      this.indexes!.onUpdate(collection, prev, doc);
      await this.changelog!.append({
        ts: Date.now(),
        op: 'update',
        collection,
        id,
        before: prev ?? null,
        after: doc,
      });
      this.cache!.invalidateCollection(collection);
      this.monitor.recordWrite();
    }
    this.emit('dataChanged', { op: 'update', collection, id });
    return doc;
  }

  async delete(collection: string, id: string): Promise<boolean> {
    this.assertReady();
    const inTx = !!this.tx!.active;
    if (inTx) await this.tx!.touch(collection);
    const prev = this.store!.getById(collection, id);
    const ok = await this.store!.delete(collection, id, { durable: !inTx });
    if (ok && !inTx && prev) {
      this.indexes!.onDelete(collection, prev);
      await this.changelog!.append({
        ts: Date.now(),
        op: 'delete',
        collection,
        id,
        before: prev,
        after: null,
      });
      this.cache!.invalidateCollection(collection);
      this.monitor.recordWrite();
    }
    if (ok) this.emit('dataChanged', { op: 'delete', collection, id });
    return ok;
  }

  async upsert(
    collection: string,
    data: Record<string, unknown>,
  ): Promise<Document> {
    this.assertReady();
    const id = typeof data._id === 'string' ? data._id : undefined;
    if (id && this.store!.getById(collection, id)) {
      return this.update(collection, id, data);
    }
    return this.insert(collection, data) as Promise<Document>;
  }

  async findById(collection: string, id: string): Promise<Document | null> {
    this.assertReady();
    await this.store!.ensureLoaded(collection);
    return this.store!.getById(collection, id) ?? null;
  }

  async query(query: JsonQuery): Promise<Document[]> {
    this.assertReady();
    const start = Date.now();
    const cacheKey = `${query.collection}::${JSON.stringify(query)}`;
    const cached = this.cache!.get(cacheKey);
    if (cached) {
      this.monitor.recordQuery({
        ts: Date.now(),
        collection: query.collection,
        durationMs: Date.now() - start,
        resultCount: cached.length,
        usedIndex: 'cache',
      });
      return cached.map((d) => ({ ...d }));
    }

    await this.store!.ensureLoaded(query.collection);
    const all = this.store!.getAll(query.collection);
    const indexes = this.indexes!.findForCollection(query.collection);
    const planned = planAndExecute(all, query, indexes, (ids) =>
      ids
        .map((id) => this.store!.getById(query.collection, id))
        .filter((d): d is Document => !!d),
    );

    this.cache!.set(cacheKey, planned.docs);
    const durationMs = Date.now() - start;
    this.monitor.recordQuery({
      ts: Date.now(),
      collection: query.collection,
      durationMs,
      resultCount: planned.docs.length,
      usedIndex: planned.usedIndex
        ? `${planned.usedIndex.type}:${planned.usedIndex.field}`
        : undefined,
    });
    return planned.docs;
  }

  async aggregate(
    collection: string,
    pipeline: AggregateStage[],
  ): Promise<unknown[]> {
    this.assertReady();
    await this.store!.ensureLoaded(collection);
    return executeAggregate(this.store!.getAll(collection), pipeline);
  }

  async jsonPath(collection: string, pathExpr: string): Promise<unknown[]> {
    this.assertReady();
    await this.store!.ensureLoaded(collection);
    return selectJsonPath(this.store!.getAll(collection), pathExpr);
  }

  async beginTransaction(
    isolationLevel: IsolationLevel = this.options.defaultIsolation,
  ): Promise<number> {
    this.assertReady();
    return this.tx!.begin(isolationLevel);
  }

  async commitTransaction(txId?: number): Promise<void> {
    this.assertReady();
    const touched = this.tx!.active ? [...this.tx!.active.touched] : [];
    await this.tx!.commit(txId);
    for (const c of touched) this.cache!.invalidateCollection(c);
    // Rebuild indexes for touched collections (simple & correct for v1 tx)
    for (const c of touched) {
      for (const idx of this.indexes!.findForCollection(c)) {
        idx.build(this.store!.getAll(c));
      }
    }
    this.monitor.recordWrite();
  }

  async rollbackTransaction(txId?: number): Promise<void> {
    this.assertReady();
    await this.tx!.rollback(txId);
  }

  async backupFull(): Promise<BackupInfo> {
    this.assertReady();
    const collections: Record<string, Document[]> = {};
    for (const info of this.catalog!.list()) {
      await this.store!.ensureLoaded(info.name);
      collections[info.name] = this.store!.getAll(info.name);
    }
    const info = await this.backup!.fullBackup(collections);
    this.lastBackupTs = info.timestamp;
    return info;
  }

  async backupIncremental(): Promise<BackupInfo | null> {
    this.assertReady();
    const since = this.lastBackupTs;
    const changes = [];
    for (const info of this.catalog!.list()) {
      changes.push(...(await this.changelog!.readSince(info.name, since)));
    }
    const info = await this.backup!.incrementalBackup(changes, since);
    if (info) this.lastBackupTs = info.timestamp;
    return info;
  }

  async restoreBackup(file: string): Promise<void> {
    this.assertReady();
    const collections = await this.backup!.restoreFull(file);
    for (const [name, docs] of Object.entries(collections)) {
      await this.catalog!.ensure(name);
      this.store!.replaceAll(name, docs);
      await this.store!.persistCollection(name);
      for (const idx of this.indexes!.findForCollection(name)) {
        idx.build(docs);
      }
      this.cache!.invalidateCollection(name);
    }
  }

  async queryAtTime(
    collection: string,
    timestamp: number,
    query: Omit<JsonQuery, 'collection'> = {},
  ): Promise<Document[]> {
    this.assertReady();
    await this.store!.ensureLoaded(collection);
    const changes = await this.changelog!.readSince(collection, 0);
    const at = reconstructAtTime(
      this.store!.getAll(collection),
      changes,
      timestamp,
    );
    return queryAtTime(at, query);
  }

  async diffBetweenTimes(collection: string, from: number, to: number) {
    this.assertReady();
    const a = await this.queryAtTime(collection, from);
    const b = await this.queryAtTime(collection, to);
    return diffDocs(a, b);
  }

  async rollbackToTime(collection: string, timestamp: number): Promise<void> {
    this.assertReady();
    const docs = await this.queryAtTime(collection, timestamp);
    this.store!.replaceAll(collection, docs);
    await this.store!.persistCollection(collection);
    for (const idx of this.indexes!.findForCollection(collection)) {
      idx.build(docs);
    }
    this.cache!.invalidateCollection(collection);
    this.emit('dataChanged', { op: 'rollback', collection, timestamp });
  }

  advise(query: JsonQuery) {
    this.assertReady();
    return adviseQuery(query, this.indexes!.list());
  }

  profileQuery(usedIndex?: string, planMs = 0, executeMs = 0) {
    return profileStages({
      planMs,
      executeMs,
      totalMs: planMs + executeMs,
      usedIndex,
    });
  }

  analyzeQuality(collection: string, requiredFields: string[] = []) {
    this.assertReady();
    return analyzeQuality(this.store!.getAll(collection), requiredFields);
  }

  getMetrics() {
    this.assertReady();
    return this.monitor.metrics(
      this.cache!.stats.hitRate,
      this.catalog!.list().length,
    );
  }

  async health() {
    this.assertReady();
    let writable = true;
    try {
      const probe = path.join(this.storagePath, 'meta', '.health');
      await fs.writeFile(probe, String(Date.now()), 'utf8');
    } catch {
      writable = false;
    }
    return this.monitor.health(
      this.ready,
      writable,
      this.cache!.stats.hitRate,
      this.catalog!.list().length,
    );
  }

  async startServer(opts?: HttpServerOptions): Promise<http.Server> {
    this.assertReady();
    if (this.httpServer) return this.httpServer;
    this.httpServer = await startHttpServer(this, opts);
    return this.httpServer;
  }

  /** Subscribe to data changes (stream-like). */
  subscribe(handler: (event: unknown) => void): () => void {
    this.on('dataChanged', handler);
    return () => this.off('dataChanged', handler);
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new JSONSQLiteError(
        ErrorCode.NOT_READY,
        'Database is not open. Call open() first.',
      );
    }
  }
}

export async function open(options: JSONSQLiteOptions): Promise<JSONSQLite> {
  const db = new JSONSQLite(options);
  await db.open();
  return db;
}
