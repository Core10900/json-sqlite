export { JSONSQLite, open } from './engine/JSONSQLite.js';
export {
  create,
  init,
  getVersion,
  getCompatibilityInfo,
} from './lifecycle.js';
export type {
  CreateDatabaseOptions,
  CreateDatabaseResult,
  InitDatabaseResult,
  CompatibilityInfo,
} from './lifecycle.js';
export { JSONSQLiteError, ErrorCode } from './errors.js';
export { parseSql } from './sql/parse.js';
export { rekeyDatabase } from './ops/rekey.js';
export { migrateDatabase } from './ops/migrate.js';
export type { MigrateDatabaseOptions, MigrateDatabaseResult } from './ops/migrate.js';
export type { AggregateStage, AggregateField, AggregateOp } from './query/Aggregate.js';
export type {
  BackupInfo,
  BackupType,
  PruneOptions,
  PruneResult,
} from './backup/BackupManager.js';
export type { Advice } from './features/QueryAdvisor.js';
export type {
  AutoTuneAuditEntry,
  AutoTuneConfig,
  AutoTuneHistoryEntry,
} from './features/AutoTune.js';
export type { AuditEntry, AuditAction } from './ops/audit.js';
export type { AlertEvent, AlertKind, AlertRule } from './monitor/Alerts.js';
export type { RepairOptions, RepairResult } from './ops/repair.js';
export { repairDatabase } from './ops/repair.js';
export { StreamProcessor } from './features/StreamProcessor.js';
export type {
  SlidingWindowOptions,
  SlidingWindowSnapshot,
  StreamAggOp,
} from './features/StreamProcessor.js';
export type { HealthReport } from './monitor/Monitor.js';
export type { IndexMeta } from './index/types.js';
export { autoSelectIndexType } from './index/autoSelect.js';
export type { AutoSelectSample } from './index/autoSelect.js';
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
  SyncMode,
  SchemaMode,
  QueryCursorOptions,
  QueryCursorResult,
  QueryReadOptions,
  ImportCollectionOptions,
  RekeyOptions,
  RekeyResult,
  VacuumOptions,
  VacuumResult,
  DoctorCheck,
  DoctorReport,
} from './types/index.js';
export { FORMAT_VERSION } from './storage/Catalog.js';
export type { HttpServerOptions } from './api/httpServer.js';
export { isLoopbackHost } from './api/httpServer.js';

