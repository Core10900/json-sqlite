export enum ErrorCode {
  NOT_READY = 'NOT_READY',
  ALREADY_OPEN = 'ALREADY_OPEN',
  INVALID_CONFIG = 'INVALID_CONFIG',
  COLLECTION_NOT_FOUND = 'COLLECTION_NOT_FOUND',
  COLLECTION_EXISTS = 'COLLECTION_EXISTS',
  DOCUMENT_NOT_FOUND = 'DOCUMENT_NOT_FOUND',
  VERSION_CONFLICT = 'VERSION_CONFLICT',
  /** Another multi-writer commit won this document. details.retryable is true. */
  WRITE_CONFLICT = 'WRITE_CONFLICT',
  /** Wait-for cycle. This transaction was rolled back. details.retryable is true. */
  DEADLOCK = 'DEADLOCK',
  /** SERIALIZABLE read set changed. details.retryable is true. */
  SERIALIZABLE_CONFLICT = 'SERIALIZABLE_CONFLICT',
  LOCK_FAILED = 'LOCK_FAILED',
  TX_ACTIVE = 'TX_ACTIVE',
  TX_NOT_FOUND = 'TX_NOT_FOUND',
  TX_NESTED = 'TX_NESTED',
  WAL_CORRUPT = 'WAL_CORRUPT',
  /** On-disk format is older than this binary; run migrate. */
  MIGRATION_REQUIRED = 'MIGRATION_REQUIRED',
  BACKUP_CHECKSUM = 'BACKUP_CHECKSUM',
  BACKUP_BASELINE = 'BACKUP_BASELINE',
  /** Document page / JSONL data is corrupt; open refuses without explicit repair. */
  DATA_CORRUPT = 'DATA_CORRUPT',
  ISOLATION_UNSUPPORTED = 'ISOLATION_UNSUPPORTED',
  DB_EXISTS = 'DB_EXISTS',
  DB_NOT_FOUND = 'DB_NOT_FOUND',
  SQL_PARSE = 'SQL_PARSE',
  SQL_UNSUPPORTED = 'SQL_UNSUPPORTED',
  /** JSONPath script, recursive descent, or other rejected syntax. */
  JSONPATH_UNSUPPORTED = 'JSONPATH_UNSUPPORTED',
  /** `AbortSignal` fired while a query was scanning. Not a partial success. */
  QUERY_CANCELLED = 'QUERY_CANCELLED',
  SCHEMA_VIOLATION = 'SCHEMA_VIOLATION',
  QUERY_TIMEOUT = 'QUERY_TIMEOUT',
  /** A configured tokenizer module failed. Point reads stay available. */
  TOKENIZER_FAILED = 'TOKENIZER_FAILED',
  /** Disk is full. The failed write was not committed. */
  STORAGE_FULL = 'STORAGE_FULL',
  /** Target path is not writable. The failed write was not committed. */
  STORAGE_PERMISSION = 'STORAGE_PERMISSION',
  /** Transaction exceeded transactionTimeoutMs and was rolled back. */
  TX_TIMEOUT = 'TX_TIMEOUT',
  /** A destructive op needs an explicit confirm / --yes. */
  CONFIRM_REQUIRED = 'CONFIRM_REQUIRED',
  /** Plugin name/version/parse contract rejected the module. */
  PLUGIN_REJECTED = 'PLUGIN_REJECTED',
  /**
   * Secondary replica refuses writes until `replica promote`.
   * Not retryable as a conflict — role must change first.
   */
  REPLICA_READONLY = 'REPLICA_READONLY',
  ENCRYPTION = 'ENCRYPTION',
  INTERNAL = 'INTERNAL',
}

const RETRYABLE = new Set<ErrorCode>([
  ErrorCode.WRITE_CONFLICT,
  ErrorCode.DEADLOCK,
  ErrorCode.SERIALIZABLE_CONFLICT,
]);

/** True for WRITE_CONFLICT, DEADLOCK, and SERIALIZABLE_CONFLICT. */
export function isRetryableError(err: unknown): boolean {
  return err instanceof JSONSQLiteError && RETRYABLE.has(err.code);
}

export class JSONSQLiteError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'JSONSQLiteError';
    this.code = code;
    this.details = details;
  }
}
