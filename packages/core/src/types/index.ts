/**
 * Transaction isolation.
 * Implemented: READ_COMMITTED (default), REPEATABLE_READ (snapshot at begin).
 * READ_UNCOMMITTED and SERIALIZABLE throw ISOLATION_UNSUPPORTED.
 * Configuring them as defaultIsolation throws INVALID_CONFIG.
 */
export type IsolationLevel =
  | 'READ_UNCOMMITTED'
  | 'READ_COMMITTED'
  | 'REPEATABLE_READ'
  | 'SERIALIZABLE';

/** Disk durability: none = fast; normal = fsync data + parent dir; full = also fsync after rename. */
export type SyncMode = 'none' | 'normal' | 'full';

/**
 * Soft-schema validation on insert/update.
 * off = metadata only (default); warn = console.warn; strict = throw.
 */
export type SchemaMode = 'off' | 'warn' | 'strict';

export interface Document {
  _id: string;
  _version: number;
  _createdAt: number;
  _updatedAt: number;
  [field: string]: unknown;
}

export type FilterValue =
  | string
  | number
  | boolean
  | null
  | FilterOp
  | FilterValue[];

export interface FilterOp {
  $eq?: unknown;
  $ne?: unknown;
  $gt?: number | string;
  $gte?: number | string;
  $lt?: number | string;
  $lte?: number | string;
  $in?: unknown[];
  $nin?: unknown[];
  $contains?: string;
  /** SQL LIKE pattern (`%` / `_`; `\` escapes the next char). */
  $like?: string;
  /** SQL NOT LIKE. */
  $nlike?: string;
  /**
   * JavaScript RegExp. String form uses no flags.
   * Object form: `{ pattern, flags? }`. Invalid patterns throw INVALID_CONFIG.
   */
  $regex?: string | { pattern: string; flags?: string };
  $exists?: boolean;
  $and?: FilterCondition[];
  $or?: FilterCondition[];
}

export type FilterCondition = Record<string, FilterValue>;

export interface OrderBySpec {
  [field: string]: 'asc' | 'desc';
}

export interface JsonQuery {
  collection: string;
  filter?: FilterCondition;
  projection?: string[];
  orderBy?: OrderBySpec | OrderBySpec[];
  limit?: number;
  offset?: number;
}

export interface QueryCursorOptions {
  collection: string;
  filter?: FilterCondition;
  /** Stable sort keys; defaults to `{ _id: 'asc' }`. */
  orderBy?: OrderBySpec;
  /** Opaque cursor from a previous page (`nextCursor`). */
  cursor?: string | null;
  limit?: number;
}

export interface QueryCursorResult {
  docs: Document[];
  /** Null when no more pages. */
  nextCursor: string | null;
}

export interface ImportCollectionOptions {
  /** `replace` clears the collection first; `append` upserts by `_id` (default). */
  mode?: 'replace' | 'append';
}

export interface JSONSQLiteOptions {
  /** Absolute or relative path for on-disk data */
  storagePath: string;
  /** Enable write-ahead log (default true) */
  walMode?: boolean;
  /**
   * Default isolation for new transactions.
   * READ_COMMITTED (default) or REPEATABLE_READ.
   * READ_UNCOMMITTED and SERIALIZABLE are rejected.
   */
  defaultIsolation?: IsolationLevel;
  /**
   * Soft limit for query wall time (ms). Exceeding throws QUERY_TIMEOUT.
   * Default 30000; set 0 to disable.
   */
  queryTimeout?: number;
  /** L1 query cache size */
  cacheSize?: number;
  /** Optional AES key string (or set JSONSQLITE_KEY) */
  encryptionKey?: string | null;
  /** Durability sync policy (default 'normal') */
  syncMode?: SyncMode;
  /** Soft-schema enforcement (default 'off') */
  schemaMode?: SchemaMode;
  /**
   * When true (default in 1.5+), open() does not preload all collections;
   * first touch loads via ensureLoaded. Set false for 1.4-style eager load.
   */
  lazyCollections?: boolean;
  /** Warm these collections during open (works with lazyCollections). */
  prefetchCollections?: string[];
  /**
   * AutoTune: recommend/create indexes from slow queries + Advisor (1.7+).
   * Default **false**. When true without autoTuneDryRun, may create indexes.
   */
  autoTune?: boolean;
  /** When autoTune is on, only record recommendations (default true). */
  autoTuneDryRun?: boolean;
  /**
   * Persist index segments (checksummed) so the next open can serve
   * equality/range lookups without rebuilding. Default true. Set false
   * to keep the 1.7 rebuild-on-load path. Missing or corrupt segments
   * still rebuild.
   */
  persistIndexes?: boolean;
  /** Process-local L2 query cache (default false). */
  l2Cache?: boolean;
  /** L2 entry cap when `l2Cache` is on (default 5000). */
  l2CacheSize?: number;
  /** Gzip stored JSON at/above `compressionThreshold` (default false). */
  compression?: boolean;
  /** Minimum JSON length in bytes before gzip (default 1024). */
  compressionThreshold?: number;
  /**
   * Experimental hot/cold tiering (default false). Cold documents are
   * loaded on demand. Do not rely on the file layout across majors.
   */
  tiering?: boolean;
  /** Access count at or below this is swept to cold (default 0). */
  tierColdAfter?: number;
  /**
   * Documents per on-disk page (format 2). Default 32.
   * Point reads load one page; the page cache evicts to `maxResidentDocs`.
   */
  pageSize?: number;
  /**
   * Max document bodies resident in the page cache. Default 256.
   * Must be >= pageSize. The id→page directory is not counted.
   */
  maxResidentDocs?: number;
  /**
   * Scheduled backup interval in ms. Default 0 (off).
   * When > 0, a background timer runs backup (full if none, else differential).
   * Failures emit an `alert` event / webhook.
   */
  backupIntervalMs?: number;
  /** Retention: delete backups older than this many days (optional). */
  backupKeepDays?: number;
  /** Retention: keep at most this many backups (optional). */
  backupMaxCount?: number;
  /**
   * Alert rules evaluated against metrics / backup failures.
   * Delivered via EventEmitter `alert` and optional webhookUrl.
   */
  alerts?: {
    rules?: Array<{
      kind: 'cache_hit' | 'error_rate' | 'corrupt' | 'backup_failed';
      cacheHitBelow?: number;
      errorRateAbove?: number;
    }>;
    webhookUrl?: string | null;
  };
}

/** Optional read scope. `txId` selects a REPEATABLE_READ snapshot. */
export interface QueryReadOptions {
  txId?: number;
}

export interface RekeyOptions {
  /** Source DB path (defaults to this.storagePath when called as method). */
  storagePath?: string;
  /** Current key (or omit to use JSONSQLITE_KEY / plaintext). */
  fromKey?: string | null;
  /** New encryption key (required). */
  toKey: string;
  /** Write rekeyed DB here (recommended). Required unless inPlace. */
  targetPath?: string;
  /** Replace source directory (requires yes: true). */
  inPlace?: boolean;
  /** Confirm destructive inplace. */
  yes?: boolean;
  syncMode?: SyncMode;
}

export interface RekeyResult {
  storagePath: string;
  mode: 'out' | 'inplace';
}

export interface VacuumOptions {
  /** Vacuum one collection; omit for all. */
  collection?: string;
  /** Rewrite JSONL with gzip for docs at/above the compression threshold. */
  compress?: boolean;
}

export interface VacuumResult {
  collections: string[];
  documentCounts: Record<string, number>;
  compressed?: boolean;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  message: string;
  details?: unknown;
}

export interface DoctorReport {
  status: 'healthy' | 'unhealthy';
  deep: boolean;
  checks: DoctorCheck[];
  timestamp: number;
}

export type IndexType = 'object' | 'tree' | 'inverted' | 'composite';

/** Soft schema field types for table DDL / CLI dialogue. */
export type FieldType = 'string' | 'number' | 'boolean' | 'json' | 'any';

export interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean;
}

export interface CollectionInfo {
  name: string;
  createdAt: number;
  documentCount: number;
  /** Optional soft schema (metadata only; writes are not strictly validated). */
  fields?: FieldDef[];
}

export type TableInfo = CollectionInfo;

export interface CreateTableOptions {
  fields?: FieldDef[];
}

export interface AlterTableSpec {
  renameTo?: string;
  addFields?: FieldDef[];
  dropFields?: string[];
}

export type SqlResult =
  | {
      type: 'rows';
      rows: Document[];
      columns: string[];
      rowCount: number;
      total?: number;
    }
  | {
      type: 'ok';
      changes: number;
      lastId?: string;
      message?: string;
    }
  | {
      type: 'tables';
      tables: TableInfo[];
    }
  | {
      type: 'schema';
      table: string;
      fields: FieldDef[];
      documentCount: number;
    };

export type WriteOpType = 'insert' | 'update' | 'delete' | 'upsert';
