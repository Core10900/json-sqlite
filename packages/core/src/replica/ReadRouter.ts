import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document } from '../types/index.js';
import type { ReplicaStatus } from './ReplicaManager.js';

/** Default max secondary lag (entries) before onLag applies. */
export const DEFAULT_LAG_THRESHOLD_ENTRIES = 10;

/**
 * Default lag policy: fail the read when secondary lag exceeds the threshold.
 * Set `onLag: 'primary'` to fall back to the primary instead.
 */
export type ReadRouterOnLag = 'fail' | 'primary';

export interface ReadRouterOptions {
  /** Max secondary lagEntries allowed for secondary reads. Default 10. */
  lagThresholdEntries?: number;
  /**
   * When lag exceeds the threshold:
   * - `'fail'` (default): throw JSONSQLiteError
   * - `'primary'`: read from primary
   */
  onLag?: ReadRouterOnLag;
}

/** Minimal handle the router needs from a JSONSQLite (or test double). */
export interface ReadRouterEndpoint {
  insert(
    collection: string,
    data: Record<string, unknown>,
  ): Promise<Document | string>;
  findById(collection: string, id: string): Promise<Document | null>;
  replicaStatus(): ReplicaStatus | Promise<ReplicaStatus>;
}

/**
 * Write-always-primary / read-secondary-when-fresh router (V34-ROUTE-1).
 *
 * Default `onLag` is `'fail'`. Both `'fail'` and `'primary'` are supported
 * and should be covered by tests.
 */
export class ReadRouter {
  private readonly lagThresholdEntries: number;
  private readonly onLag: ReadRouterOnLag;

  constructor(
    private readonly primary: ReadRouterEndpoint,
    private readonly secondary: ReadRouterEndpoint,
    opts?: ReadRouterOptions,
  ) {
    this.lagThresholdEntries = Math.max(
      0,
      opts?.lagThresholdEntries ?? DEFAULT_LAG_THRESHOLD_ENTRIES,
    );
    this.onLag = opts?.onLag ?? 'fail';
  }

  /** All writes go to the primary. */
  async write(
    collection: string,
    data: Record<string, unknown>,
  ): Promise<Document | string> {
    return this.primary.insert(collection, data);
  }

  /**
   * Read by id. Uses the secondary when lagEntries <= threshold;
   * otherwise applies `onLag`.
   */
  async read(collection: string, id: string): Promise<Document | null> {
    const status = await this.secondary.replicaStatus();
    const lag = status.lagEntries ?? 0;
    if (lag <= this.lagThresholdEntries) {
      return this.secondary.findById(collection, id);
    }
    if (this.onLag === 'primary') {
      return this.primary.findById(collection, id);
    }
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `Secondary lag ${lag} entries exceeds threshold ${this.lagThresholdEntries}`,
      {
        lagEntries: lag,
        lagThresholdEntries: this.lagThresholdEntries,
        onLag: this.onLag,
        role: status.role,
      },
    );
  }
}
