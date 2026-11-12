/**
 * Transaction isolation.
 * Implemented: READ_COMMITTED (default), REPEATABLE_READ (snapshot at begin).
 * SERIALIZABLE is implemented only with writers: 'multi'.
 * READ_UNCOMMITTED throws ISOLATION_UNSUPPORTED. single mode also rejects SERIALIZABLE.
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
  /**
   * Bounding box. Points use `{ lat, lon }`, `{ latitude, longitude }`,
   * GeoJSON Point, or `[lon, lat]`. Without a geo index this is a scan.
   */
  $geoWithin?: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  };
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
   * SERIALIZABLE is accepted only together with writers: 'multi'.
   * READ_UNCOMMITTED is rejected. single mode rejects SERIALIZABLE.
   */
  defaultIsolation?: IsolationLevel;
  /**
   * single (default) is the LTS-2 lock: a second process gets LOCK_FAILED.
   * multi opts into same-machine writers. Omitting this stays single.
   * Production multi-writer pin is 2.5, not 2.4.
   */
  writers?: 'single' | 'multi';
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
  /** Minimum slow-query hits before AutoTune acts (default 2). Same as design autoIndexThreshold. */
  autoTuneMinHits?: number;
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
      kind:
        | 'cache_hit'
        | 'error_rate'
        | 'corrupt'
        | 'backup_failed'
        | 'response_time';
      cacheHitBelow?: number;
      errorRateAbove?: number;
    }>;
    webhookUrl?: string | null;
    /** Fire when recent p99 exceeds this many ms. */
    responseTimeMs?: number;
  };
  /**
   * Master switch for the 2.3 column store. Default false.
   * Tables are listed in `columnCollections`, or enabled later with
   * `enableColumnStore`. The WAL remains the commit source.
   */
  columnStore?: boolean;
  /** Tables that rebuild a column projection. Default empty (off). */
  columnCollections?: string[];
  /**
   * 2.3 hot/warm/cold layout. Default false.
   * This is not the 1.8 `tiering` flag. `tiering` still means the
   * experimental cold.jsonl sweep on close.
   */
  storageTiers?: boolean;
  /** Access count at or below this is moved to cold when storageTiers is on. Default 0. */
  coldAfter?: number;
  /** Access count at or below this (and above coldAfter) is warm. Default 1. */
  warmAfter?: number;
  /**
   * Delta / dictionary / RLE / gzip with a block header. Default false.
   * The 2.2 `compression` flag stays gzip-only.
   */
  smartCompression?: boolean;
  /** Append index segment parts instead of overwriting one file. Default false. */
  indexDeltaSegments?: boolean;
  /** Gzip large query-cache values. Default false. Hits return the original documents. */
  cacheCompression?: boolean;
  /** Byte length at or above which a cached result is compressed. Default 4096. */
  cacheCompressionThreshold?: number;
  /** Prefetch the next page after a page miss. Default false. Failure falls back to on-demand reads. */
  prefetchPages?: boolean;
  /**
   * When > 0, collection scans filter in chunks of this size, then sort
   * and project once. Default 0 (one shot, same as 2.2). 0 disables chunking.
   */
  queryChunkSize?: number;
  /** `none` (default) or the built-in `bigram` tokenizer. No extra dependency. */
  chineseTokenizer?: 'none' | 'bigram';
  /**
   * Optional tokenizer package name. If the module is missing, open still
   * succeeds and Chinese tokenization stays unavailable.
   */
  tokenizerModule?: string;
  /**
   * Compile whitelist filter operators. Default false (interpret only).
   * Opening this does not accept caller-supplied source strings.
   */
  compileFilters?: boolean;
  /**
   * Maximum keys in one B+Tree node. Default 128.
   * Does not create a tree index by itself.
   */
  bTreeOrder?: number;
  /**
   * Allow `storageAdvise` to return a suggestion. Default false.
   * A suggestion never changes the table's storage mode.
   */
  storageAdvise?: boolean;
  /** Tables stored as hybrid: listed hot fields in columns, other fields on document pages. */
  hybridCollections?: string[];
  /** Hot fields written as `table.field`. Used with `hybridCollections`. */
  hybridFields?: string[];
  /**
   * External directory for cold-tier copies. Requires `storageTiers`.
   * If this directory cannot be written, hot point reads still succeed.
   */
  coldExternalDir?: string;
  /** Sample size used when smart compression picks an algorithm. Default 64. */
  compressionSampleWindow?: number;
  /**
   * Stop words for the inverted index. Omit for the built-in list.
   * `[]` keeps every token. Applied on open and on `setStopWords`.
   */
  stopWords?: string[];
  /**
   * Changelog retention for time travel (ms). Default 7 days.
   * Separate from backup `keepDays`.
   */
  timeTravelRetentionMs?: number;
  /**
   * Transaction timeout (ms). Default 0 (off). Timed-out txs roll back.
   */
  transactionTimeoutMs?: number;
  /** Interval for `metrics` events (ms). Default 5000. */
  metricsIntervalMs?: number;
  /**
   * Heap watermark for /health. Default 0 reports only and never degrades.
   */
  memoryWatermarkBytes?: number;
  /** Delta lines before a checksummed snapshot. Default 1000. */
  deltaSnapshotThreshold?: number;
  /** Optional Redis L3. Default false. Missing client keeps L3 closed. */
  l3?: boolean;
  /** Redis marker. Default false. Missing client does not fail open. */
  redis?: boolean;
  /**
   * Async replication (3.3+). Default false.
   * Role requires `replica init`. Object may set `syncIntervalMs` and `quorum`.
   * `quorum` is acknowledgements including the primary (default 1 = primary only).
   */
  replica?:
    | boolean
    | {
        enabled?: boolean;
        /** Secondary pull interval in milliseconds. Default 100. */
        syncIntervalMs?: number;
        /**
         * Acknowledgements required including primary. Default 1 (no secondary wait).
         * quorum=2 waits for 1 secondary ack after append.
         */
        quorum?: number;
      };
  /**
   * Enable minimal GraphQL execute/HTTP (3.4). Default false.
   */
  graphql?: boolean;
  /**
   * Optional async advisor hook (3.4). Called after built-in rules.
   * Failures fall back to rules advice and do not throw from `advise`.
   */
  advisorProvider?: (
    query: JsonQuery,
    rulesAdvice: import('../features/QueryAdvisor.js').Advice[],
  ) =>
    | import('../features/QueryAdvisor.js').Advice[]
    | Promise<import('../features/QueryAdvisor.js').Advice[] | null | undefined>
    | null
    | undefined;
}

/** Optional read scope. `txId` selects a REPEATABLE_READ snapshot. */
export interface QueryReadOptions {
  txId?: number;
  /**
   * Override `queryChunkSize` for this call. `0` forces a single pass.
   * Omit to use the open() option (default 0).
   */
  chunkSize?: number;
  /**
   * `false` forces the document scan even when a column store is ready.
   * Omit to use the column store when it is ready.
   */
  column?: boolean;
  /**
   * Override `queryTimeout` for this call, in milliseconds.
   * `0` disables the limit. Omit to use the open() option.
   */
  timeout?: number;
  /** Abort the scan. Cancellation throws `QUERY_CANCELLED` and does not return a partial array. */
  signal?: AbortSignal;
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

export type IndexType = 'object' | 'tree' | 'inverted' | 'composite' | 'geo';

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
