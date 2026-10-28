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
import { planAndExecute, planIndexIds } from '../query/Planner.js';
import {
  executeAggregate,
  type AggregateStage,
} from '../query/Aggregate.js';
import { selectJsonPath } from '../query/JsonPath.js';
import { Catalog } from '../storage/Catalog.js';
import { ChangeLog, type ChangeEntry } from '../storage/ChangeLog.js';
import { DdlJournal } from '../storage/DdlJournal.js';
import { DocumentStore } from '../storage/DocumentStore.js';
import { FileLock } from '../storage/FileLock.js';
import { diagnoseWalDirectory, Wal } from '../storage/Wal.js';
import {
  compareByOrder,
  executeJsonQuery,
  getPath,
  matchFilter,
  normalizeOrderBy,
} from '../query/JsonQuery.js';
import { TransactionManager } from '../transaction/TransactionManager.js';
import { BackupManager, type BackupInfo, type FullPayload, type IncPayload } from '../backup/BackupManager.js';
import { Monitor } from '../monitor/Monitor.js';
import {
  diffDocs,
  queryAtTime,
  reconstructAtTime,
} from '../features/TimeTravel.js';
import { adviseQuery, profileStages } from '../features/QueryAdvisor.js';
import { analyzeQuality } from '../features/DataQuality.js';
import { AutoTune } from '../features/AutoTune.js';
import { StreamProcessor } from '../features/StreamProcessor.js';
import { startHttpServer, type HttpServerOptions } from '../api/httpServer.js';
import { autoSelectIndexType } from '../index/autoSelect.js';
import { parseSql } from '../sql/parse.js';
import type { SelectStmt, SqlStatement } from '../sql/ast.js';
import { verifyEncryptionKey, writeKeycheck } from '../crypto/keycheck.js';
import { recoverRekeyIfNeeded } from '../ops/rekeyJournal.js';
import { runDoctor } from '../ops/doctor.js';
import { vacuumDatabase } from '../ops/vacuum.js';
import { generateId } from '../utils/id.js';
import { collectionDir, walFile } from '../utils/path.js';
import type {
  AlterTableSpec,
  CollectionInfo,
  CreateTableOptions,
  Document,
  DoctorReport,
  FieldDef,
  ImportCollectionOptions,
  IsolationLevel,
  JsonQuery,
  JSONSQLiteOptions,
  OrderBySpec,
  QueryCursorOptions,
  QueryCursorResult,
  QueryReadOptions,
  RekeyOptions,
  RekeyResult,
  SqlResult,
  TableInfo,
  VacuumOptions,
  VacuumResult,
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
  private l2: L1Cache<Document[]> | null = null;
  private changelog: ChangeLog | null = null;
  private backup: BackupManager | null = null;
  private ddlJournal: DdlJournal | null = null;
  private monitor = new Monitor();
  private autoTune: AutoTune | null = null;
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
    const sync = this.options.syncMode;
    const openStarted = Date.now();

    await recoverRekeyIfNeeded(root, sync);

    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(root, 'meta'), { recursive: true });
    await fs.mkdir(path.join(root, 'collections'), { recursive: true });
    await fs.mkdir(path.join(root, 'wal'), { recursive: true });
    await fs.mkdir(path.join(root, 'deltas'), { recursive: true });
    await fs.mkdir(path.join(root, 'backups'), { recursive: true });

    this.lock = new FileLock(root);
    await this.lock.acquire();

    try {
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
          await writeKeycheck(root, this.encKey);
        }
      }

      if (this.catalog.encryption && this.encKey) {
        await verifyEncryptionKey(
          root,
          this.encKey,
          this.catalog.list().map((c) => c.name),
        );
      }

      this.wal = new Wal(root, this.options.walMode, sync, this.encKey);
      this.wal.setEncryption(this.catalog.encryption);
      await this.wal.initialize();
      if (this.options.walMode) {
        const reports = await diagnoseWalDirectory(root, this.encKey);
        const bad = reports.find((report) => report.issues.length > 0);
        if (bad) {
          const issue = bad.issues[0]!;
          throw new JSONSQLiteError(
            ErrorCode.WAL_CORRUPT,
            `WAL corrupt at line ${issue.line} (${issue.kind}) in ${bad.collection}; refusing to skip committed records`,
            { collection: bad.collection, line: issue.line, kind: issue.kind },
          );
        }
      }

      this.indexes = new IndexManager(root, sync, this.options.persistIndexes);
      this.store = new DocumentStore(
        root,
        this.catalog,
        this.wal,
        sync,
        this.options.schemaMode,
        this.encKey,
        (name, loadMs) => {
          const stats = this.store!.indexStats(name);
          const wal = this.store!.hadWalReplay(name);
          if (!this.indexes!.trustSegment(name, stats, wal)) {
            return this.store!.readAll(name).then((docs) => {
              this.indexes!.rebuildCollection(name, docs);
              this.monitor.recordCollectionLoad(loadMs);
            });
          }
          this.monitor.recordCollectionLoad(loadMs);
        },
      );
      this.store.configure({
        compression: this.options.compression,
        compressionThreshold: this.options.compressionThreshold,
        tiering: this.options.tiering,
        tierColdAfter: this.options.tierColdAfter,
        pageSize: this.options.pageSize,
        maxResidentDocs: this.options.maxResidentDocs,
      });
      this.tx = new TransactionManager(this.store);
      this.changelog = new ChangeLog(root);
      this.cache = new L1Cache(this.options.cacheSize);
      this.l2 = this.options.l2Cache
        ? new L1Cache(this.options.l2CacheSize)
        : null;
      this.backup = new BackupManager(root, this.encKey);
      this.ddlJournal = new DdlJournal(root, sync);

      await this.recoverDdlJournal();

      const lazy = this.options.lazyCollections;
      const prefetch = new Set(this.options.prefetchCollections ?? []);

      await this.indexes.load();
      if (!lazy) {
        for (const info of this.catalog.list()) {
          await this.store.loadCollection(info.name);
        }
      } else {
        for (const name of prefetch) {
          if (this.catalog.has(name)) {
            await this.store.loadCollection(name);
          }
        }
      }

      this.monitor.setOpenLoadMs(Date.now() - openStarted);
      this.autoTune = new AutoTune(
        {
          listIndexes: () => this.indexes!.list(),
          createIndex: (c, f, t) => this.createIndex(c, f, t),
          getSlowQueries: (th) => this.monitor.getSlowQueries(th),
        },
        {
          enabled: this.options.autoTune === true,
          dryRun: this.options.autoTuneDryRun !== false,
        },
      );
      this.ready = true;
      this.emit('ready');
      return this;
    } catch (err) {
      await this.lock.release().catch(() => undefined);
      this.lock = null;
      this.catalog = null;
      this.wal = null;
      this.store = null;
      this.tx = null;
      this.indexes = null;
      this.cache = null;
      this.l2 = null;
      this.ddlJournal = null;
      this.changelog = null;
      this.backup = null;
      this.ready = false;
      throw err;
    }
  }

  async close(opts?: { flush?: boolean }): Promise<void> {
    if (!this.ready) return;
    if (this.tx?.active) await this.tx.rollback();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
    if (opts?.flush !== false) {
      if (this.options.tiering) await this.store?.sweepTiers();
      else await this.store?.flushAll();
      await this.catalog?.save();
      if (this.store && this.indexes && this.options.persistIndexes) {
        for (const name of this.store.loadedCollections()) {
          await this.indexes.flushCollection(name, this.store.indexStats(name));
        }
      }
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
    this.l2 = null;
    this.ddlJournal = null;
    this.changelog = null;
    this.backup = null;
    this.lock = null;
    this.autoTune = null;
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
      documentCount: this.store!.indexStats(name).docCount,
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
    this.touchCaches(name);

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
    this.touchCaches(from);
    this.touchCaches(to);

    await this.store!.ensureLoaded(to);
    const docs = await this.store!.readAll(to);
    for (const meta of indexMetas) {
      await this.indexes!.createIndex(to, meta.field, meta.type, docs, {
        fields: meta.fields,
      });
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
    if (!filter || Object.keys(filter).length === 0) {
      return this.store!.indexStats(collection).docCount;
    }
    const all = await this.store!.readAll(collection);
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
        if (stmt.groupBy) {
          return this.executeGroupByCount(stmt);
        }
        if (stmt.aggregate === 'count') {
          if (stmt.join) {
            throw new JSONSQLiteError(
              ErrorCode.SQL_UNSUPPORTED,
              'COUNT(*) does not support JOIN',
            );
          }
          const n = await this.count(stmt.table, stmt.filter);
          const row: Document = {
            _id: '__count__',
            _version: 0,
            _createdAt: 0,
            _updatedAt: 0,
            count: n,
          };
          return {
            type: 'rows',
            rows: [row],
            columns: ['count'],
            rowCount: 1,
            total: 1,
          };
        }
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
    opts?: { fields?: string[] },
  ) {
    this.assertReady();
    await this.store!.ensureLoaded(collection);
    const meta = await this.indexes!.createIndex(
      collection,
      field,
      type,
      await this.store!.readAll(collection),
      opts,
    );
    this.touchCaches(collection);
    return meta;
  }

  /** Heuristic index type picker (1.7). */
  autoSelectIndexType(
    sample: Parameters<typeof autoSelectIndexType>[0],
    field?: string | string[],
  ): IndexType {
    return autoSelectIndexType(sample, field);
  }

  async listIndexes() {
    this.assertReady();
    return this.indexes!.list();
  }

  async dropIndex(collection: string, field: string) {
    this.assertReady();
    await this.indexes!.dropIndex(collection, field);
    this.touchCaches(collection);
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
        this.touchCaches(collection);
        this.monitor.recordWrite();
        await this.persistIndexState(collection);
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
      this.touchCaches(collection);
      this.monitor.recordWrite();
      await this.persistIndexState(collection);
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
    await this.store!.ensureLoaded(collection);
    const prev = await this.store!.getById(collection, id);
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
      this.touchCaches(collection);
      this.monitor.recordWrite();
      await this.persistIndexState(collection);
    }
    this.emit('dataChanged', { op: 'update', collection, id });
    return doc;
  }

  async delete(collection: string, id: string): Promise<boolean> {
    this.assertReady();
    const inTx = !!this.tx!.active;
    if (inTx) await this.tx!.touch(collection);
    await this.store!.ensureLoaded(collection);
    const prev = await this.store!.getById(collection, id);
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
      this.touchCaches(collection);
      this.monitor.recordWrite();
      await this.persistIndexState(collection);
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
    if (id) {
      await this.store!.ensureLoaded(collection);
      if (await this.store!.getById(collection, id)) {
        return this.update(collection, id, data);
      }
    }
    return this.insert(collection, data) as Promise<Document>;
  }

  async findById(
    collection: string,
    id: string,
    opts?: QueryReadOptions,
  ): Promise<Document | null> {
    this.assertReady();
    if (opts?.txId !== undefined && this.tx!.isSnapshot(opts.txId)) {
      return this.tx!.snapshotGet(opts.txId, collection, id) ?? null;
    }
    await this.store!.ensureLoaded(collection);
    return (await this.store!.getById(collection, id)) ?? null;
  }

  async query(query: JsonQuery, opts?: QueryReadOptions): Promise<Document[]> {
    this.assertReady();
    const start = Date.now();
    if (opts?.txId !== undefined && this.tx!.isSnapshot(opts.txId)) {
      const snapDocs = this.tx!.snapshotDocs(opts.txId, query.collection);
      const planned = planAndExecute(snapDocs, query, [], () => []);
      return planned.docs;
    }
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
    if (this.l2) {
      const l2hit = this.l2.get(cacheKey);
      if (l2hit) {
        this.cache!.set(cacheKey, l2hit);
        this.monitor.recordQuery({
          ts: Date.now(),
          collection: query.collection,
          durationMs: Date.now() - start,
          resultCount: l2hit.length,
          usedIndex: 'l2',
        });
        return l2hit.map((d) => ({ ...d }));
      }
    }

    await this.store!.ensureLoaded(query.collection);
    const indexes = this.indexes!.findForCollection(query.collection);
    const indexed = planIndexIds(query, indexes);
    let plannedDocs: Document[];
    let usedIndex: { type: string; field: string } | undefined;
    if (indexed) {
      const resolved: Document[] = [];
      for (const id of indexed.ids) {
        const doc = await this.store!.getById(query.collection, id);
        if (doc) resolved.push({ ...doc });
      }
      plannedDocs = executeJsonQuery(resolved, {
        filter: query.filter,
        projection: query.projection,
        orderBy: query.orderBy,
        limit: query.limit,
        offset: query.offset,
      });
      usedIndex = indexed.usedIndex;
    } else {
      const all = await this.store!.readAll(query.collection);
      const planned = planAndExecute(all, query, [], () => []);
      plannedDocs = planned.docs;
    }

    this.cache!.set(cacheKey, plannedDocs);
    this.l2?.set(cacheKey, plannedDocs);
    if (this.options.tiering) {
      for (const doc of plannedDocs) {
        this.store!.noteAccess(query.collection, doc._id);
      }
    }
    const durationMs = Date.now() - start;
    this.checkQueryTimeout(durationMs);
    this.monitor.recordQuery({
      ts: Date.now(),
      collection: query.collection,
      durationMs,
      resultCount: plannedDocs.length,
      usedIndex: usedIndex ? `${usedIndex.type}:${usedIndex.field}` : undefined,
    });
    if (this.autoTune?.enabled && durationMs > this.monitor.slowQueryThreshold) {
      void this.autoTune.tick(query).catch(() => undefined);
    }
    return plannedDocs;
  }

  /** Export all documents in a collection (plain array). */
  async exportCollection(name: string): Promise<Document[]> {
    this.assertReady();
    await this.store!.ensureLoaded(name);
    return (await this.store!.readAll(name)).map((d) => ({ ...d }));
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
        void _createdAt;
        void _updatedAt;
        prepared.push({
          ...rest,
          _id: id ?? generateId(),
          _version: typeof raw._version === 'number' ? raw._version : 1,
          _createdAt: typeof raw._createdAt === 'number' ? raw._createdAt : now,
          _updatedAt: typeof raw._updatedAt === 'number' ? raw._updatedAt : now,
        } as Document);
      }
      await this.store!.replaceAllDurable(name, prepared);
      for (const idx of this.indexes!.findForCollection(name)) {
        idx.build(await this.store!.readAll(name));
      }
      this.touchCaches(name);
      await this.persistIndexState(name);
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
    let docs = await this.store!.readAll(opts.collection);
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
    const fromNames = new Set(
      pipeline
        .filter((s): s is Extract<AggregateStage, { type: 'lookup' }> => s.type === 'lookup')
        .map((s) => s.from),
    );
    for (const name of fromNames) {
      await this.store!.ensureLoaded(name);
    }
    const tables = new Map<string, Document[]>();
    tables.set(collection, await this.store!.readAll(collection));
    for (const name of fromNames) {
      tables.set(name, await this.store!.readAll(name));
    }
    return executeAggregate(tables.get(collection) ?? [], pipeline, {
      getCollection: (name) => tables.get(name) ?? [],
    });
  }

  async jsonPath(collection: string, pathExpr: string): Promise<unknown[]> {
    this.assertReady();
    await this.store!.ensureLoaded(collection);
    return selectJsonPath(await this.store!.readAll(collection), pathExpr);
  }

  async beginTransaction(
    isolationLevel: IsolationLevel = this.options.defaultIsolation,
  ): Promise<number> {
    this.assertReady();
    const id = this.tx!.begin(isolationLevel);
    if (isolationLevel === 'REPEATABLE_READ') {
      const snap = new Map<string, Map<string, Document>>();
      for (const info of this.catalog!.list()) {
        await this.store!.ensureLoaded(info.name);
        const docs = await this.store!.readAll(info.name);
        const map = new Map<string, Document>();
        for (const doc of docs) map.set(doc._id, { ...doc });
        snap.set(info.name, map);
      }
      this.tx!.captureSnapshot(id, snap);
    }
    return id;
  }

  async commitTransaction(txId?: number): Promise<void> {
    this.assertReady();
    const result = await this.tx!.commit(txId);
    if (result.kind === 'snapshot') return;
    for (const c of result.touched) this.touchCaches(c);
    for (const c of result.touched) {
      for (const idx of this.indexes!.findForCollection(c)) {
        idx.build(await this.store!.readAll(c));
      }
      await this.persistIndexState(c);
    }
    if (result.touched.length > 0) this.monitor.recordWrite();
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
      collections[info.name] = await this.store!.readAll(info.name);
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

  async restoreBackup(
    file: string,
    opts?: { collection?: string },
  ): Promise<void> {
    await this.restoreChain({ type: 'full', file, collection: opts?.collection });
  }

  /**
   * Restore a full backup, or a full backup plus incrementals in order.
   * Checksums are verified before any collection is written.
   * `collection` restores only that collection from the full backup.
   */
  async restoreChain(opts: {
    type: 'full' | 'incremental';
    file?: string;
    collection?: string;
  }): Promise<void> {
    this.assertReady();
    const list = await this.backup!.list();
    const plan = this.backup!.resolveChain(list, opts.type, opts.file);
    const decoded: (FullPayload | IncPayload)[] = [];
    for (const info of plan) {
      decoded.push(await this.backup!.readVerified(info));
    }
    const full = decoded[0];
    if (!full || full.type !== 'full') {
      throw new JSONSQLiteError(
        ErrorCode.BACKUP_BASELINE,
        'Restore plan did not start with a full backup',
      );
    }
    const collections: Record<string, Document[]> = {};
    const names = opts.collection ? [opts.collection] : Object.keys(full.collections);
    for (const name of names) {
      if (!(name in full.collections)) {
        throw new JSONSQLiteError(
          ErrorCode.COLLECTION_NOT_FOUND,
          `Collection ${name} is not in the full backup`,
        );
      }
      collections[name] = full.collections[name]!.map((d) => ({ ...d }));
    }
    for (const payload of decoded.slice(1)) {
      if (payload.type !== 'incremental') continue;
      applyIncrementalChanges(collections, payload.changes, opts.collection);
    }
    for (const [name, docs] of Object.entries(collections)) {
      await this.catalog!.ensure(name);
      await this.store!.replaceAllDurable(name, docs);
      for (const idx of this.indexes!.findForCollection(name)) {
        idx.build(docs);
      }
      this.touchCaches(name);
      await this.persistIndexState(name);
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
      await this.store!.readAll(collection),
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
    await this.store!.replaceAllDurable(collection, docs);
    for (const idx of this.indexes!.findForCollection(collection)) {
      idx.build(docs);
    }
    this.touchCaches(collection);
    await this.persistIndexState(collection);
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

  getSlowQueries(threshold?: number) {
    this.assertReady();
    return this.monitor.getSlowQueries(threshold);
  }

  /** Configure AutoTune at runtime (default off). */
  setAutoTune(opts: { enabled?: boolean; dryRun?: boolean }): void {
    this.assertReady();
    this.autoTune?.setConfig(opts);
  }

  getAutoTuneAudit() {
    this.assertReady();
    return this.autoTune?.getAuditLog() ?? [];
  }

  /** Run AutoTune once (no-op when disabled). */
  async runAutoTune(seed?: JsonQuery) {
    this.assertReady();
    return this.autoTune?.tick(seed) ?? [];
  }

  /** In-process sliding-window stream helper (1.7). */
  createStreamProcessor(): StreamProcessor {
    this.assertReady();
    return new StreamProcessor(this);
  }

  async analyzeQuality(collection: string, requiredFields: string[] = []) {
    this.assertReady();
    await this.store!.ensureLoaded(collection);
    return analyzeQuality(await this.store!.readAll(collection), requiredFields);
  }

  getMetrics() {
    this.assertReady();
    const base = this.monitor.metrics(
      this.cache!.stats.hitRate,
      this.catalog!.list().length,
    );
    const l2 = this.l2?.stats;
    return {
      ...base,
      l2: l2
        ? { enabled: true as const, ...l2 }
        : {
            enabled: false as const,
            hits: 0,
            misses: 0,
            evictions: 0,
            size: 0,
            hitRate: 0,
          },
      tiers: this.store!.tierSnapshot(),
      compression: {
        enabled: this.store!.compressionEnabled(),
        threshold: this.options.compressionThreshold,
      },
      indexes: this.indexes!.diagnostics(),
    };
  }

  /** Page cache budget and how many page files have been read. */
  pagingStats() {
    this.assertReady();
    return this.store!.pagingSnapshot();
  }

  /** Index segment load / rebuild counters (1.8). */
  indexPersistence() {
    this.assertReady();
    return this.indexes!.diagnostics();
  }

  /**
   * Rebuild index postings from live documents and rewrite segments.
   * Omit `collection` to rebuild every table.
   */
  async rebuildIndexes(collection?: string): Promise<{ collections: string[] }> {
    this.assertReady();
    const names = collection
      ? [collection]
      : (await this.listTables()).map((t) => t.name);
    for (const name of names) {
      await this.store!.ensureLoaded(name);
      const docs = await this.store!.readAll(name);
      this.indexes!.rebuildCollection(name, docs);
      await this.indexes!.flushCollection(name, this.store!.indexStats(name));
    }
    return { collections: names };
  }

  /** Doctor / CLI summary for segments, compression, tiering, and L2. */
  storageSummary() {
    this.assertReady();
    const metrics = this.getMetrics();
    const idx = metrics.indexes;
    return {
      indexSegments: {
        persist: idx.persist,
        segmentCount: idx.segmentCount,
        restored: idx.restored,
        servedFromSegment: idx.servedFromSegment,
        rebuilt: idx.rebuilt,
        corrupt: idx.corrupt,
      },
      compression: metrics.compression,
      tiering: metrics.tiers,
      l2: metrics.l2,
    };
  }

  /** Number of collections currently resident in memory. */
  loadedCollectionCount(): number {
    this.assertReady();
    return this.store!.loadedCollections().length;
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

  async vacuum(opts?: VacuumOptions): Promise<VacuumResult> {
    this.assertReady();
    return vacuumDatabase(this, opts);
  }

  async doctor(opts?: { deep?: boolean }): Promise<DoctorReport> {
    this.assertReady();
    return runDoctor(this, opts);
  }

  /**
   * Offline rekey helper bound to this DB's storagePath.
   * Closes the current handle first when inplace (caller should reopen).
   */
  async rekey(
    opts: Omit<RekeyOptions, 'storagePath'> & { storagePath?: string },
  ): Promise<RekeyResult> {
    const storagePath = opts.storagePath ?? this.storagePath;
    if (this.ready && path.resolve(storagePath) === this.storagePath) {
      await this.close({ flush: true });
    }
    const { rekeyDatabase } = await import('../ops/rekey.js');
    return rekeyDatabase({ ...opts, storagePath });
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
    const leftDocs = await this.store!.readAll(stmt.table);
    const rightDocs = await this.store!.readAll(join.table);

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

  private async executeGroupByCount(stmt: SelectStmt): Promise<SqlResult> {
    if (stmt.join) {
      throw new JSONSQLiteError(
        ErrorCode.SQL_UNSUPPORTED,
        '[SQL_UNSUPPORTED] GROUP BY does not support JOIN',
      );
    }
    if (stmt.aggregate !== 'count' || !stmt.groupBy) {
      throw new JSONSQLiteError(
        ErrorCode.SQL_UNSUPPORTED,
        '[SQL_UNSUPPORTED] GROUP BY requires COUNT(*) in this version',
      );
    }
    await this.store!.ensureLoaded(stmt.table);
    let docs = await this.store!.readAll(stmt.table);
    if (stmt.filter && Object.keys(stmt.filter).length > 0) {
      docs = docs.filter((d) => matchFilter(d, stmt.filter!));
    }
    const field = stmt.groupBy;
    const groups = new Map<string, { key: unknown; count: number }>();
    for (const doc of docs) {
      const key = getPath(doc, field);
      const sk = JSON.stringify(key ?? null);
      const existing = groups.get(sk);
      if (existing) existing.count += 1;
      else groups.set(sk, { key, count: 1 });
    }
    let rows: Document[] = [...groups.values()].map((g, i) => ({
      _id: `g:${i}`,
      _version: 0,
      _createdAt: 0,
      _updatedAt: 0,
      [field]: g.key,
      count: g.count,
    }));
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
    const columns = stmt.columns === '*' ? [field, 'count'] : stmt.columns;
    return {
      type: 'rows',
      rows,
      columns,
      rowCount: rows.length,
      total,
    };
  }

  private touchCaches(collection: string): void {
    this.cache?.invalidateCollection(collection);
    this.l2?.invalidateCollection(collection);
  }

  private async persistIndexState(collection: string): Promise<void> {
    if (!this.options.persistIndexes) return;
    await this.indexes!.flushCollection(
      collection,
      this.store!.indexStats(collection),
    );
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

function applyIncrementalChanges(
  collections: Record<string, Document[]>,
  changes: ChangeEntry[],
  only?: string,
): void {
  for (const change of changes) {
    if (only && change.collection !== only) continue;
    const list = collections[change.collection] ?? [];
    const map = new Map(list.map((doc) => [doc._id, doc]));
    if (change.op === 'delete') map.delete(change.id);
    else if (change.after) map.set(change.id, { ...change.after });
    collections[change.collection] = [...map.values()];
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
