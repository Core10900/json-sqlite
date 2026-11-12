import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { open, type JSONSQLite } from '../engine/JSONSQLite.js';
import type { JSONSQLiteOptions } from '../types/index.js';

export interface ConnectionPoolOptions {
  storagePath: string;
  /**
   * Requested pool size. Single-writer storage only allows one open handle
   * per path, so size > 1 still shares one connection (serialized borrow).
   */
  size?: number;
  /** Extra open() options (storagePath is taken from the pool options). */
  openOptions?: Omit<JSONSQLiteOptions, 'storagePath'>;
}

export interface ConnectionPool {
  borrow(): Promise<JSONSQLite>;
  release(db: JSONSQLite): void;
  close(): Promise<void>;
}

interface Waiter {
  resolve: (db: JSONSQLite) => void;
  reject: (err: Error) => void;
}

/**
 * Logical connection pool for a single storagePath.
 * Opens one shared JSONSQLite handle and serializes borrow/return so
 * single-writer file locks are not contended.
 */
export function createConnectionPool(
  opts: ConnectionPoolOptions,
): ConnectionPool {
  if (!opts.storagePath || typeof opts.storagePath !== 'string') {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      'createConnectionPool requires storagePath',
    );
  }
  const size = opts.size ?? 1;
  if (!Number.isInteger(size) || size < 1) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `Connection pool size must be a positive integer (got ${String(opts.size)})`,
    );
  }

  let closed = false;
  let db: JSONSQLite | null = null;
  let openPromise: Promise<JSONSQLite> | null = null;
  let borrowed = false;
  const waiters: Waiter[] = [];

  async function ensureOpen(): Promise<JSONSQLite> {
    if (closed) {
      throw new JSONSQLiteError(ErrorCode.POOL_CLOSED, 'Connection pool is closed');
    }
    if (db) return db;
    if (!openPromise) {
      openPromise = open({
        ...(opts.openOptions ?? {}),
        storagePath: opts.storagePath,
      }).then((handle) => {
        db = handle;
        return handle;
      });
    }
    try {
      return await openPromise;
    } catch (err) {
      openPromise = null;
      throw err;
    }
  }

  function assertNotClosed(): void {
    if (closed) {
      throw new JSONSQLiteError(ErrorCode.POOL_CLOSED, 'Connection pool is closed');
    }
  }

  return {
    async borrow(): Promise<JSONSQLite> {
      assertNotClosed();
      const handle = await ensureOpen();
      assertNotClosed();
      if (!borrowed) {
        borrowed = true;
        return handle;
      }
      return new Promise<JSONSQLite>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },

    release(released: JSONSQLite): void {
      assertNotClosed();
      if (!db || released !== db) {
        throw new JSONSQLiteError(
          ErrorCode.INVALID_CONFIG,
          'release() requires a connection borrowed from this pool',
        );
      }
      if (!borrowed) {
        throw new JSONSQLiteError(
          ErrorCode.INVALID_CONFIG,
          'Connection was not borrowed',
        );
      }
      const next = waiters.shift();
      if (next) {
        next.resolve(db);
        return;
      }
      borrowed = false;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const pending = waiters.splice(0);
      for (const w of pending) {
        w.reject(
          new JSONSQLiteError(ErrorCode.POOL_CLOSED, 'Connection pool is closed'),
        );
      }
      borrowed = false;
      const handle = db;
      db = null;
      openPromise = null;
      if (handle) {
        await handle.close({ flush: true });
      }
    },
  };
}
