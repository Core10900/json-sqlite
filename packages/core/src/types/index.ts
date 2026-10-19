export type IsolationLevel =
  | 'READ_UNCOMMITTED'
  | 'READ_COMMITTED'
  | 'REPEATABLE_READ'
  | 'SERIALIZABLE';

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

export interface JSONSQLiteOptions {
  /** Absolute or relative path for on-disk data */
  storagePath: string;
  /** Enable write-ahead log (default true) */
  walMode?: boolean;
  /** Default isolation for new transactions */
  defaultIsolation?: IsolationLevel;
  /** Query timeout ms (reserved) */
  queryTimeout?: number;
  /** L1 query cache size */
  cacheSize?: number;
  /** Optional AES key string (or set JSONSQLITE_KEY) */
  encryptionKey?: string | null;
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
