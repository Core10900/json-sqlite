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
import { DdlJournal } from '../storage/DdlJournal.js';
import { DocumentStore } from '../storage/DocumentStore.js';
import { FileLock } from '../storage/FileLock.js';
import { Wal } from '../storage/Wal.js';
import {
  compareByOrder,
  getPath,
  matchFilter,
  normalizeOrderBy,
} from '../query/JsonQuery.js';
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
import { parseSql } from '../sql/parse.js';
import type { SelectStmt, SqlStatement } from '../sql/ast.js';
import { generateId } from '../utils/id.js';
import { collectionDir, walFile } from '../utils/path.js';
import type {
  AlterTableSpec,
  CollectionInfo,
  CreateTableOptions,
  Document,
  FieldDef,
  ImportCollectionOptions,
  IsolationLevel,
  JsonQuery,
  JSONSQLiteOptions,
  OrderBySpec,
  QueryCursorOptions,
  QueryCursorResult,
  SqlResult,
  TableInfo,
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
  private ddlJournal: DdlJournal | null = null;
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

    const sync = this.options.syncMode;
    this.catalog = new Catalog(root, sync);
    await this.catalog.load();

    if (this.catalog.encryption && !this.encKey) {
      throw new JSONSQLiteError(
        ErrorCode.ENCRYPTION,
        'This database uses encrypted storage; provide encryptionKey or JSONSQLITE_KEY',
      );
    }

    // New/empty DB + key → enable main-store encryption (plaintext DBs with data stay plain)
    if (this.encKey && !this.catalog.encryption) {
      const empty = this.catalog.list().length === 0;
      if (empty) {
        await this.catalog.setEncryption(true);
      }
    }

    this.wal = new Wal(root, this.options.walMode, sync, this.encKey);
    this.wal.setEncryption(this.catalog.encryption);
    await this.wal.initialize();

    this.store = new DocumentStore(
      root,
      this.catalog,
      this.wal,
      sync,
      this.options.schemaMode,
      this.encKey,
    );
    this.tx = new TransactionManager(this.store);
    this.changelog = new ChangeLog(root);
    this.cache = new L1Cache(this.options.cacheSize);
    this.indexes = new IndexManager(root, sync);
    this.backup = new BackupManager(root, this.encKey);
    this.ddlJournal = new DdlJournal(root, sync);

    await this.recoverDdlJournal();

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
    this.ddlJournal = null;
    this.changelog = null;
    this.backup = null;
    this.lock = null;
    this.emit('close');
  }

  async createCollection(
    name: string,
    options?: CreateTableOptions,
  ): Promise<CollectionInfo> {
    this.assertReady();
    return this.catalog!.create(name, options?.fields);
  }

  /** Alias of createCollection with soft-schema fields (CLI「表」). */
  async createTable(
    name: string,
    options?: CreateTableOptions,
  ): Promise<TableInfo> {
    return this.createCollection(name, options);
  }

  async listCollections(): Promise<CollectionInfo[]> {
    this.assertReady();
    return this.catalog!.list();
  }

  /** Alias of listCollections. */
  async listTables(): Promise<TableInfo[]> {
    return this.listCollections();
  }

  async describeTable(name: string): Promise<TableInfo> {
    this.assertReady();
    const info = this.catalog!.get(name);
    if (!info) {
      throw new JSONSQLiteError(
        ErrorCode.COLLECTION_NOT_FOUND,
        `Collection not found: ${name}`,
      );
    }
    await this.store!.ensureLoaded(name);
    return {
      ...info,
      documentCount: this.store!.getAll(name).length,
    };
  }

  async dropTable(name: string): Promise<void> {
    this.assertReady();
    if (!this.catalog!.has(name)) {
      throw new JSONSQLiteError(
        ErrorCode.COLLECTION_NOT_FOUND,
        `Collection not found: ${name}`,
      );
    }
    if (this.tx?.active) {
      throw new JSONSQLiteError(
        ErrorCode.TX_ACTIVE,
        'Cannot drop table while a transaction is active',
      );
    }

    await this.ddlJournal!.write({ op: 'drop', name, phase: 'started' });
    await this.indexes!.dropAllForCollection(name);
    this.store!.unload(name);
    this.cache!.invalidateCollection(name);

    const root = this.storagePath;
    await fs.rm(collectionDir(root, name), { recursive: true, force: true });
    await fs.rm(walFile(root, name), { force: true });
    await fs.rm(path.join(root, 'deltas', `${name}.delta`), { force: true });
    await this.ddlJournal!.write({ op: 'drop', name, phase: 'files_removed' });

    await this.catalog!.drop(name);
    await this.ddlJournal!.clear();
    this.emit('dataChanged', { op: 'dropTable', collection: name });
  }

  /** @deprecated Prefer dropTable */
  async dropCollection(name: string): Promise<void> {
    return this.dropTable(name);
  }

  async alterTable(name: string, spec: AlterTableSpec): Promise<TableInfo> {
    this.assertReady();
    const current = await this.describeTable(name);
    let fields: FieldDef[] = [...(current.fields ?? [])];

    if (spec.dropFields?.length) {
      const drop = new Set(spec.dropFields);
      fields = fields.filter((f) => !drop.has(f.name));
    }
    if (spec.addFields?.length) {
      const existing = new Set(fields.map((f) => f.name));
      for (const f of spec.addFields) {
        if (existing.has(f.name)) {
          throw new JSONSQLiteError(
            ErrorCode.INVALID_CONFIG,
            `Field already exists: ${f.name}`,
          );
        }
        fields.push(f);
        existing.add(f.name);
      }
    }

    let tableName = name;
    if (spec.renameTo && spec.renameTo !== name) {
      await this.renameTable(name, spec.renameTo);
      tableName = spec.renameTo;
    }

    await this.catalog!.setFields(tableName, fields);
    return this.describeTable(tableName);
  }

  async renameTable(from: string, to: string): Promise<TableInfo> {
    this.assertReady();
    if (!this.catalog!.has(from)) {
      throw new JSONSQLiteError(
        ErrorCode.COLLECTION_NOT_FOUND,
        `Collection not found: ${from}`,
      );
    }
    if (this.catalog!.has(to)) {
      throw new JSONSQLiteError(
        ErrorCode.COLLECTION_EXISTS,
        `Collection already exists: ${to}`,
      );
    }
    if (this.tx?.active) {
      throw new JSONSQLiteError(
        ErrorCode.TX_ACTIVE,
        'Cannot rename table while a transaction is active',
      );
    }

    await this.store!.ensureLoaded(from);
    await this.store!.persistCollection(from);

    await this.ddlJournal!.write({
      op: 'rename',
      from,
      to,
      phase: 'started',
    });

    const root = this.storagePath;
    const fromDir = collectionDir(root, from);
    const toDir = collectionDir(root, to);
    await fs.rename(fromDir, toDir);
    try {
      await fs.rename(walFile(root, from), walFile(root, to));
    } catch {
      /* wal may not exist */
    }
    try {
      await fs.rename(
        path.join(root, 'deltas', `${from}.delta`),
        path.join(root, 'deltas', `${to}.delta`),
      );
    } catch {
      /* delta may not exist */
    }
    await this.ddlJournal!.write({
      op: 'rename',
      from,
      to,
      phase: 'files_moved',
    });

    const indexMetas = this.indexes!
      .list()
      .filter((m) => m.collection === from);
    await this.indexes!.dropAllForCollection(from);

    this.store!.renameInMemory(from, to);
    await this.catalog!.rename(from, to);
    this.cache!.invalidateCollection(from);
    this.cache!.invalidateCollection(to);

    await this.store!.ensureLoaded(to);
    const docs = this.store!.getAll(to);
    for (const meta of indexMetas) {
      await this.indexes!.createIndex(to, meta.field, meta.type, docs);
    }

    await this.ddlJournal!.clear();
    this.emit('dataChanged', { op: 'renameTable', from, to });
    return this.describeTable(to);
  }

  async count(
    collection: string,
    filter?: JsonQuery['filter'],
  ): Promise<number> {
    this.assertReady();
    await this.store!.ensureLoaded(collection);
    const all = this.store!.getAll(collection);
    if (!filter || Object.keys(filter).length === 0) return all.length;
    return all.filter((doc) => matchFilter(doc, filter)).length;
  }

  /**
   * Execute a SQL subset statement.
   * Compiles to JsonQuery / CRUD / DDL — see docs for supported syntax.
   */
  async run(sql: string): Promise<SqlResult> {
    this.assertReady();
    const stmt = parseSql(sql);
    return this.executeSql(stmt);
  }

  private async executeSql(stmt: SqlStatement): Promise<SqlResult> {
    switch (stmt.kind) {
      case 'select': {
        if (stmt.join) {
          return this.executeJoinSelect(stmt);
        }
        const rows = await this.query({
          collection: stmt.table,
          filter: stmt.filter,
          projection: stmt.columns === '*' ? undefined : stmt.columns,
          orderBy: stmt.orderBy,
          limit: stmt.limit,
          offset: stmt.offset,
        });
        const columns =
          stmt.columns === '*'
            ? inferColumns(rows)
            : stmt.columns;
        const needsTotal =
          stmt.limit !== undefined || (stmt.offset !== undefined && stmt.offset > 0);
        const total = needsTotal
          ? await this.count(stmt.table, stmt.filter)
          : rows.length;
        return {
          type: 'rows',
          rows,
          columns,
          rowCount: rows.length,
          total,
        };
      }
      case 'insert': {
        let lastId: string | undefined;
        let changes = 0;
        for (const row of stmt.values) {
          const data: Record<string, unknown> = {};
          if (stmt.columns) {
            if (stmt.columns.length !== row.length) {
              throw new JSONSQLiteError(
                ErrorCode.SQL_PARSE,
                'INSERT column count does not match VALUES',
              );
            }
            stmt.columns.forEach((c, i) => {
              data[c] = row[i];
            });
          } else {
            throw new JSONSQLiteError(
              ErrorCode.SQL_UNSUPPORTED,
              'INSERT requires an explicit column list: INSERT INTO t (a,b) VALUES (...)',
            );
          }
          const doc = (await this.insert(stmt.table, data)) as Document;
          lastId = doc._id;
          changes += 1;
        }
        return { type: 'ok', changes, lastId, message: 'INSERT' };
      }
      case 'update': {
        const matches = await this.query({
          collection: stmt.table,
          filter: stmt.filter,
        });
        let changes = 0;
        for (const doc of matches) {
          await this.update(stmt.table, doc._id, stmt.set);
          changes += 1;
        }
        return { type: 'ok', changes, message: 'UPDATE' };
      }
      case 'delete': {
        const matches = await this.query({
          collection: stmt.table,
          filter: stmt.filter,
        });
        let changes = 0;
        for (const doc of matches) {
          if (await this.delete(stmt.table, doc._id)) changes += 1;
        }
        return { type: 'ok', changes, message: 'DELETE' };
      }
      case 'create_table': {
        await this.createTable(stmt.table, { fields: stmt.fields });
        return {
          type: 'ok',
          changes: 0,
          message: `CREATE TABLE ${stmt.table}`,
        };
      }
      case 'drop_table': {
        await this.dropTable(stmt.table);
        return { type: 'ok', changes: 0, message: `DROP TABLE ${stmt.table}` };
      }
      case 'alter_table': {
        await this.alterTable(stmt.table, {
          renameTo: stmt.renameTo,
          addFields: stmt.addField ? [stmt.addField] : undefined,
          dropFields: stmt.dropField ? [stmt.dropField] : undefined,
        });
        return { type: 'ok', changes: 0, message: `ALTER TABLE ${stmt.table}` };
      }
      case 'show_tables': {
        return { type: 'tables', tables: await this.listTables() };
      }
      case 'describe': {
        const info = await this.describeTable(stmt.table);
        return {
          type: 'schema',
          table: info.name,
          fields: info.fields ?? [],
          documentCount: info.documentCount,
        };
      }
      default: {
        const _exhaustive: never = stmt;
        throw new JSONSQLiteError(
          ErrorCode.SQL_UNSUPPORTED,
          `Unsupported SQL: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
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
    this.checkQueryTimeout(durationMs);
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

  /** Export all documents in a collection (plain array). */
  async exportCollection(name: string): Promise<Document[]> {
    this.assertReady();
    await this.store!.ensureLoaded(name);
    return this.store!.getAll(name).map((d) => ({ ...d }));
  }

  /**
   * Import documents into a collection.
   * - `append` (default): upsert by `_id`
   * - `replace`: replace entire collection contents
   */
  async importCollection(
    name: string,
    docs: Record<string, unknown>[],
    opts?: ImportCollectionOptions,
  ): Promise<{ imported: number }> {
    this.assertReady();
    const mode = opts?.mode ?? 'append';
    await this.catalog!.ensure(name);
    await this.store!.ensureLoaded(name);

    if (mode === 'replace') {
      const prepared: Document[] = [];
      const now = Date.now();
      for (const raw of docs) {
        const id =
          typeof raw._id === 'string' && raw._id ? raw._id : undefined;
        const { _id, _version, _createdAt, _updatedAt, ...rest } = raw;
        void _id;
        void _version;
        void _createdAt;
        void _updatedAt;
        prepared.push({
          ...rest,
          _id: id ?? generateId(),
          _version: 1,
          _createdAt: typeof raw._createdAt === 'number' ? raw._createdAt : now,
          _updatedAt: typeof raw._updatedAt === 'number' ? raw._updatedAt : now,
        } as Document);
      }
      this.store!.replaceAll(name, prepared);
      await this.store!.persistCollection(name);
      for (const idx of this.indexes!.findForCollection(name)) {
        idx.build(this.store!.getAll(name));
      }
      this.cache!.invalidateCollection(name);
      this.emit('dataChanged', {
        op: 'import',
        collection: name,
        mode,
        count: prepared.length,
      });
      return { imported: prepared.length };
    }

    let imported = 0;
    for (const raw of docs) {
      await this.upsert(name, raw);
      imported += 1;
    }
    this.emit('dataChanged', {
      op: 'import',
      collection: name,
      mode,
      count: imported,
    });
    return { imported };
  }

  /**
   * Cursor-based pagination. Stable when `orderBy` includes a unique key
   * (defaults to `_id` asc).
   */
  async queryCursor(opts: QueryCursorOptions): Promise<QueryCursorResult> {
    this.assertReady();
    const limit = opts.limit ?? 50;
    const orderBy: OrderBySpec = opts.orderBy
      ? { ...opts.orderBy }
      : { _id: 'asc' };
    if (!('_id' in orderBy)) {
      orderBy._id = 'asc';
    }
    const specs = normalizeOrderBy(orderBy);

    await this.store!.ensureLoaded(opts.collection);
    let docs = this.store!.getAll(opts.collection);
    if (opts.filter && Object.keys(opts.filter).length > 0) {
      docs = docs.filter((d) => matchFilter(d, opts.filter!));
    }
    docs = [...docs].sort((a, b) => compareByOrder(a, b, specs));

    if (opts.cursor) {
      const cursorDoc = decodeCursor(opts.cursor);
      docs = docs.filter((d) => compareByOrder(d, cursorDoc, specs) > 0);
    }

    const page = docs.slice(0, limit);
    const hasMore = docs.length > page.length;
    return {
      docs: page.map((d) => ({ ...d })),
      nextCursor:
        hasMore && page.length > 0
          ? encodeCursor(page[page.length - 1]!, orderBy)
          : null,
    };
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

  private async executeJoinSelect(stmt: SelectStmt): Promise<SqlResult> {
    const join = stmt.join!;
    const leftAlias = stmt.alias ?? stmt.table;
    const rightAlias = join.alias ?? join.table;

    await this.store!.ensureLoaded(stmt.table);
    await this.store!.ensureLoaded(join.table);
    const leftDocs = this.store!.getAll(stmt.table);
    const rightDocs = this.store!.getAll(join.table);

    const onLeft = qualifyJoinField(join.onLeft, leftAlias, rightAlias, 'left');
    const onRight = qualifyJoinField(
      join.onRight,
      leftAlias,
      rightAlias,
      'right',
    );

    const rightIndex = new Map<string, Document[]>();
    for (const r of rightDocs) {
      const key = joinKey(getPath(r, stripAlias(onRight, rightAlias)));
      const list = rightIndex.get(key) ?? [];
      list.push(r);
      rightIndex.set(key, list);
    }

    let rows: Document[] = [];
    for (const left of leftDocs) {
      const key = joinKey(getPath(left, stripAlias(onLeft, leftAlias)));
      const matches = rightIndex.get(key) ?? [];
      if (matches.length === 0) {
        if (join.type === 'left') {
          rows.push(mergeJoinRow(left, null, leftAlias, rightAlias));
        }
      } else {
        for (const right of matches) {
          rows.push(mergeJoinRow(left, right, leftAlias, rightAlias));
        }
      }
    }

    if (stmt.filter && Object.keys(stmt.filter).length > 0) {
      rows = rows.filter((d) => matchFilter(d, stmt.filter!));
    }
    if (stmt.orderBy) {
      const specs = normalizeOrderBy(stmt.orderBy);
      rows = [...rows].sort((a, b) => compareByOrder(a, b, specs));
    }
    const total = rows.length;
    const offset = stmt.offset ?? 0;
    if (offset > 0 || stmt.limit !== undefined) {
      rows = rows.slice(
        offset,
        stmt.limit === undefined ? undefined : offset + stmt.limit,
      );
    }

    if (stmt.columns !== '*') {
      rows = rows.map((row) => projectJoinRow(row, stmt.columns as string[]));
    }

    const columns =
      stmt.columns === '*' ? inferColumns(rows) : (stmt.columns as string[]);
    return {
      type: 'rows',
      rows,
      columns,
      rowCount: rows.length,
      total,
    };
  }

  /** Subscribe to data changes (stream-like). */
  subscribe(handler: (event: unknown) => void): () => void {
    this.on('dataChanged', handler);
    return () => this.off('dataChanged', handler);
  }

  private checkQueryTimeout(durationMs: number): void {
    const limit = this.options.queryTimeout;
    if (limit > 0 && durationMs > limit) {
      throw new JSONSQLiteError(
        ErrorCode.QUERY_TIMEOUT,
        `Query exceeded queryTimeout ${limit}ms (took ${durationMs}ms)`,
      );
    }
  }

  /** Resume incomplete DDL after crash (files vs catalog). */
  private async recoverDdlJournal(): Promise<void> {
    const entry = await this.ddlJournal!.read();
    if (!entry) return;
    const root = this.storagePath;

    if (entry.op === 'drop') {
      await fs.rm(collectionDir(root, entry.name), {
        recursive: true,
        force: true,
      });
      await fs.rm(walFile(root, entry.name), { force: true });
      await fs.rm(path.join(root, 'deltas', `${entry.name}.delta`), {
        force: true,
      });
      if (this.catalog!.has(entry.name)) {
        await this.catalog!.drop(entry.name);
      }
      await this.ddlJournal!.clear();
      return;
    }

    if (entry.op === 'rename') {
      const fromDir = collectionDir(root, entry.from);
      const toDir = collectionDir(root, entry.to);
      const fromExists = await pathExists(fromDir);
      const toExists = await pathExists(toDir);

      if (toExists && !fromExists) {
        // files already moved — ensure catalog points to `to`
        if (this.catalog!.has(entry.from) && !this.catalog!.has(entry.to)) {
          await this.catalog!.rename(entry.from, entry.to);
        } else if (this.catalog!.has(entry.from) && this.catalog!.has(entry.to)) {
          await this.catalog!.drop(entry.from);
        }
      } else if (fromExists && !toExists) {
        // rename never moved files — abort journal
        await this.ddlJournal!.clear();
        return;
      } else if (fromExists && toExists) {
        // ambiguous: prefer completing rename (keep `to`, drop `from` files)
        await fs.rm(fromDir, { recursive: true, force: true });
        await fs.rm(walFile(root, entry.from), { force: true });
        if (this.catalog!.has(entry.from) && !this.catalog!.has(entry.to)) {
          await this.catalog!.rename(entry.from, entry.to);
        } else if (this.catalog!.has(entry.from)) {
          await this.catalog!.drop(entry.from);
        }
      }
      await this.ddlJournal!.clear();
    }
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function inferColumns(rows: Document[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) keys.add(k);
  }
  const preferred = ['_id', '_version', '_createdAt', '_updatedAt'];
  const rest = [...keys].filter((k) => !preferred.includes(k)).sort();
  return [...preferred.filter((k) => keys.has(k)), ...rest];
}

function mergeJoinRow(
  left: Document,
  right: Document | null,
  leftAlias: string,
  rightAlias: string,
): Document {
  const out: Document = {
    _id: left._id,
    _version: left._version,
    _createdAt: left._createdAt,
    _updatedAt: left._updatedAt,
  };
  for (const [k, v] of Object.entries(left)) {
    out[`${leftAlias}.${k}`] = v;
  }
  if (right) {
    for (const [k, v] of Object.entries(right)) {
      out[`${rightAlias}.${k}`] = v;
    }
  } else {
    // LEFT JOIN miss — expose right alias keys as null for common system fields only
    out[`${rightAlias}._id`] = null;
  }
  return out;
}

function projectJoinRow(row: Document, columns: string[]): Document {
  const out: Document = {
    _id: row._id,
    _version: row._version,
    _createdAt: row._createdAt,
    _updatedAt: row._updatedAt,
  };
  for (const c of columns) {
    out[c] = getPath(row, c);
  }
  return out;
}

function qualifyJoinField(
  ref: string,
  leftAlias: string,
  rightAlias: string,
  side: 'left' | 'right',
): string {
  if (ref.includes('.')) return ref;
  return side === 'left' ? `${leftAlias}.${ref}` : `${rightAlias}.${ref}`;
}

function stripAlias(ref: string, alias: string): string {
  const prefix = `${alias}.`;
  if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  if (ref.includes('.')) {
    // table.col without matching alias — use field after last dot
    return ref.slice(ref.lastIndexOf('.') + 1);
  }
  return ref;
}

function joinKey(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function encodeCursor(doc: Document, orderBy: OrderBySpec): string {
  const payload: Record<string, unknown> = {};
  for (const field of Object.keys(orderBy)) {
    payload[field] = getPath(doc, field);
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Document {
  try {
    const obj = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    return {
      _id: typeof obj._id === 'string' ? obj._id : '',
      _version: 0,
      _createdAt: 0,
      _updatedAt: 0,
      ...obj,
    };
  } catch {
    throw new JSONSQLiteError(ErrorCode.INVALID_CONFIG, 'Invalid query cursor');
  }
}

export async function open(options: JSONSQLiteOptions): Promise<JSONSQLite> {
  const db = new JSONSQLite(options);
  await db.open();
  return db;
}
