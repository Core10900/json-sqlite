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
export { JSONSQLiteError, ErrorCode, isRetryableError } from './errors.js';
export type {
  ReplicaRole,
  ReplicaStatus,
  ReplicaStateFile,
  ReplicaLogEntry,
} from './replica/ReplicaManager.js';
export { REPLICA_LOG_FORMAT } from './replica/ReplicaManager.js';
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
export {
  builtinPluginCatalog,
  builtinPluginInfo,
  createS3Stub,
  createVectorStub,
} from './plugins/registry.js';
export type {
  BuiltinPluginInfo,
  EnginePlugin,
  PluginKind,
  PluginManifest,
} from './plugins/registry.js';
export { compressSmart, decompressSmart, readSmartHeader, selectAlgorithm } from './storage/smartCompress.js';
export type { SmartAlgorithm } from './storage/smartCompress.js';
export type { StorageAdvice, StorageMode } from './storage/advise.js';
export { createBigramTokenizer, bigramTokenize } from './tokenize/chinese.js';
export { tokenize, DEFAULT_STOP_WORDS } from './index/InvertedIndex.js';
export type { ChineseTokenizer } from './tokenize/chinese.js';
export type { QueryExplain, QueryPlanInfo, QueryProfile } from './engine/JSONSQLite.js';
export type { ColumnStoreStatus } from './storage/columnStore.js';
export type { TierSummary } from './storage/tiers.js';

