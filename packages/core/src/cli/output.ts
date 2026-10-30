import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { ExitCode, setExit } from './exit.js';
import { noColor } from './args.js';

export interface OutputOpts {
  json: boolean;
  quiet?: boolean;
}

export function printSuccess(
  opts: OutputOpts,
  human: string,
  data: Record<string, unknown> = {},
): void {
  if (opts.quiet && !opts.json) return;
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...data }, null, 2));
    return;
  }
  console.log(human);
}

export function printData(
  opts: OutputOpts,
  human: string,
  data: Record<string, unknown>,
): void {
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...data }, null, 2));
    return;
  }
  if (!opts.quiet) console.log(human);
}

export function fail(
  opts: OutputOpts,
  message: string,
  code: string | ErrorCode = 'USAGE',
  exit: ExitCode = ExitCode.USAGE,
  hint?: string,
): never {
  setExit(exit);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          code,
          message,
          ...(hint ? { hint } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    const prefix = noColor() ? '错误:' : '错误:';
    console.error(`${prefix} ${message}`);
    if (hint) console.error(`提示: ${hint}`);
  }
  // Use throw to unwind; caller main().catch will not double-exit if exitCode set
  throw new CliFail(message, exit);
}

export class CliFail extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = 'CliFail';
    this.exitCode = exitCode;
  }
}

export function mapErrorToExit(err: unknown): ExitCode {
  if (err instanceof CliFail) return err.exitCode;
  if (err instanceof JSONSQLiteError) {
    if (err.code === ErrorCode.LOCK_FAILED) return ExitCode.LOCK;
    if (
      err.code === ErrorCode.INVALID_CONFIG ||
      err.code === ErrorCode.SQL_PARSE ||
      err.code === ErrorCode.SQL_UNSUPPORTED ||
      err.code === ErrorCode.COLLECTION_NOT_FOUND ||
      err.code === ErrorCode.DOCUMENT_NOT_FOUND ||
      err.code === ErrorCode.DB_EXISTS ||
      err.code === ErrorCode.DB_NOT_FOUND ||
      err.code === ErrorCode.ENCRYPTION ||
      err.code === ErrorCode.SCHEMA_VIOLATION ||
      err.code === ErrorCode.MIGRATION_REQUIRED ||
      err.code === ErrorCode.BACKUP_CHECKSUM ||
      err.code === ErrorCode.BACKUP_BASELINE ||
      err.code === ErrorCode.DATA_CORRUPT ||
      err.code === ErrorCode.ISOLATION_UNSUPPORTED ||
      err.code === ErrorCode.WAL_CORRUPT
    ) {
      return ExitCode.USAGE;
    }
    return ExitCode.SYSTEM;
  }
  return ExitCode.SYSTEM;
}

export function failFromError(opts: OutputOpts, err: unknown): never {
  const exit = mapErrorToExit(err);
  if (err instanceof CliFail) throw err;
  const code =
    err instanceof JSONSQLiteError ? err.code : 'INTERNAL';
  const message = err instanceof Error ? err.message : String(err);
  setExit(exit);
  if (opts.json) {
    console.log(JSON.stringify({ ok: false, code, message }, null, 2));
  } else {
    console.error(message);
  }
  throw new CliFail(message, exit);
}

export function requireTty(opts: OutputOpts, context: string, hint: string): void {
  if (!process.stdin.isTTY) {
    fail(opts, `${context} 需要交互式终端`, 'USAGE', ExitCode.USAGE, hint);
  }
}
