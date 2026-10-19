export { JSONSQLite, open } from './engine/JSONSQLite.js';
export { create, init, getVersion } from './lifecycle.js';
export type {
  CreateDatabaseOptions,
  CreateDatabaseResult,
  InitDatabaseResult,
} from './lifecycle.js';
export { JSONSQLiteError, ErrorCode } from './errors.js';
export { parseSql } from './sql/parse.js';
export type { AggregateStage, AggregateField, AggregateOp } from './query/Aggregate.js';
export type { BackupInfo } from './backup/BackupManager.js';
export type { Advice } from './features/QueryAdvisor.js';
export type { HealthReport } from './monitor/Monitor.js';
export type { IndexMeta } from './index/types.js';
export type { SqlStatement } from './sql/ast.js';
export type {
  JSONSQLiteOptions,
  Document,
  JsonQuery,
  FilterCondition,
  FilterOp,
  IsolationLevel,
  CollectionInfo,
  TableInfo,
  FieldDef,
  FieldType,
  CreateTableOptions,
  AlterTableSpec,
  SqlResult,
  OrderBySpec,
  IndexType,
} from './types/index.js';
