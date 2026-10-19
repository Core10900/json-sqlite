export enum ErrorCode {
  NOT_READY = 'NOT_READY',
  ALREADY_OPEN = 'ALREADY_OPEN',
  INVALID_CONFIG = 'INVALID_CONFIG',
  COLLECTION_NOT_FOUND = 'COLLECTION_NOT_FOUND',
  COLLECTION_EXISTS = 'COLLECTION_EXISTS',
  DOCUMENT_NOT_FOUND = 'DOCUMENT_NOT_FOUND',
  VERSION_CONFLICT = 'VERSION_CONFLICT',
  LOCK_FAILED = 'LOCK_FAILED',
  TX_ACTIVE = 'TX_ACTIVE',
  TX_NOT_FOUND = 'TX_NOT_FOUND',
  TX_NESTED = 'TX_NESTED',
  WAL_CORRUPT = 'WAL_CORRUPT',
  DB_EXISTS = 'DB_EXISTS',
  DB_NOT_FOUND = 'DB_NOT_FOUND',
  SQL_PARSE = 'SQL_PARSE',
  SQL_UNSUPPORTED = 'SQL_UNSUPPORTED',
  SCHEMA_VIOLATION = 'SCHEMA_VIOLATION',
  QUERY_TIMEOUT = 'QUERY_TIMEOUT',
  INTERNAL = 'INTERNAL',
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
