/**
 * Transaction isolation.
 * v1.3+ only **implements** READ_COMMITTED (snapshot-on-touch).
 * Other values are accepted for API compatibility but coerced to READ_COMMITTED.
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
   * Only READ_COMMITTED is implemented; others are coerced.
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
}

export type IndexType = 'object' | 'tree' | 'inverted';

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
