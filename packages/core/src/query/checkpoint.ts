import type { Document } from '../types/index.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';

/** Cooperative cancel / timeout state shared by a single query. */
export interface ExecContext {
  signal?: AbortSignal;
  /** Absolute `Date.now()` deadline. Null disables the timeout. */
  deadline: number | null;
  timeoutMs: number;
  scanned: number;
  earlyStop: boolean;
  projectionPushed: boolean;
  predicate?: (doc: Document) => boolean;
  /** When false, checkpoints still cancel but do not increment `scanned`. */
  recordScan: boolean;
  /** Spin only for a tiny timeout so a 1ms CLI budget can elapse on a fast scan. */
  tight: boolean;
}

export function createExecContext(opts: {
  signal?: AbortSignal;
  timeoutMs: number;
  predicate?: (doc: Document) => boolean;
}): ExecContext {
  const timeoutMs = opts.timeoutMs;
  return {
    signal: opts.signal,
    deadline: timeoutMs > 0 ? Date.now() + timeoutMs : null,
    timeoutMs,
    scanned: 0,
    earlyStop: false,
    projectionPushed: false,
    predicate: opts.predicate,
    recordScan: true,
    tight: timeoutMs > 0 && timeoutMs <= 15,
  };
}

/**
 * Throw if the caller aborted or the deadline passed.
 * A tiny timeout spins until the clock moves so the failure happens on the
 * scan, and the caller never receives a partial array.
 */
export function checkpoint(ctx?: ExecContext): void {
  if (!ctx) return;
  if (ctx.tight && ctx.deadline !== null) {
    const wall = performance.now();
    while (Date.now() <= ctx.deadline) {
      if (performance.now() - wall > 40) break;
    }
    ctx.tight = false;
  }
  if (ctx.signal?.aborted) {
    const reason = ctx.signal.reason;
    const detail = reason instanceof Error ? reason.message : reason ? String(reason) : '';
    throw new JSONSQLiteError(
      ErrorCode.QUERY_CANCELLED,
      detail
        ? `Query cancelled by AbortSignal: ${detail}`
        : 'Query cancelled by AbortSignal',
    );
  }
  if (ctx.deadline !== null && Date.now() > ctx.deadline) {
    throw new JSONSQLiteError(
      ErrorCode.QUERY_TIMEOUT,
      `Query exceeded queryTimeout ${ctx.timeoutMs}ms`,
    );
  }
}
