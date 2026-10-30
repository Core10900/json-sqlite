import type { Advice } from './QueryAdvisor.js';
import type { IndexMeta } from '../index/types.js';
import type { IndexType, JsonQuery } from '../types/index.js';
import type { QueryMetric } from '../monitor/Monitor.js';
import { adviseQuery } from './QueryAdvisor.js';

export interface AutoTuneConfig {
  /** Master switch (default false). */
  enabled: boolean;
  /** When true, only record recommendations — never create indexes. */
  dryRun: boolean;
  /** Minimum slow-query hits for a field before acting. */
  minHits?: number;
}

export interface AutoTuneAuditEntry {
  ts: number;
  action: 'recommend' | 'create' | 'skip' | 'rollback' | 'apply_failed';
  message: string;
  suggestion?: { collection: string; field: string; type: IndexType };
  dryRun: boolean;
}

export interface AutoTuneHistoryEntry {
  ts: number;
  kind: 'apply' | 'rollback' | 'dry-run';
  before: IndexMeta[];
  after: IndexMeta[];
  message: string;
}

export interface AutoTuneDeps {
  listIndexes: () => IndexMeta[];
  createIndex: (
    collection: string,
    field: string,
    type: IndexType,
  ) => Promise<IndexMeta>;
  dropIndex: (collection: string, field: string) => Promise<void>;
  getSlowQueries: (threshold?: number) => QueryMetric[];
  /**
   * Optional post-apply check. Throw to trigger rollback of indexes
   * created in this tick.
   */
  validateApply?: (created: IndexMeta[]) => Promise<void> | void;
}

/**
 * Optional auto-index tuner. Default off; when on, uses Advisor + slow queries.
 * Always appends audit entries; dry-run never mutates indexes.
 * Gray apply: on validation failure, drop created indexes and record history.
 */
export class AutoTune {
  private readonly audit: AutoTuneAuditEntry[] = [];
  private readonly history: AutoTuneHistoryEntry[] = [];
  private config: AutoTuneConfig;

  private deps: AutoTuneDeps;

  constructor(
    deps: AutoTuneDeps,
    config?: Partial<AutoTuneConfig>,
  ) {
    this.deps = deps;
    this.config = {
      enabled: false,
      dryRun: true,
      minHits: 2,
      ...config,
    };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  setConfig(patch: Partial<AutoTuneConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** Test / ops hook: fail gray apply to exercise rollback. */
  setValidateApply(
    fn: ((created: IndexMeta[]) => Promise<void> | void) | undefined,
  ): void {
    this.deps.validateApply = fn;
  }

  getAuditLog(): AutoTuneAuditEntry[] {
    return [...this.audit];
  }

  getHistory(): AutoTuneHistoryEntry[] {
    return [...this.history];
  }

  clearAudit(): void {
    this.audit.length = 0;
  }

  /** Run once against current slow-query buffer + optional seed query. */
  async tick(seed?: JsonQuery): Promise<AutoTuneAuditEntry[]> {
    if (!this.config.enabled) return [];

    const created: AutoTuneAuditEntry[] = [];
    const indexes = this.deps.listIndexes();
    const before = indexes.map((i) => ({ ...i }));
    const advice: Advice[] = [];

    if (seed) {
      advice.push(...adviseQuery(seed, indexes));
    }

    const slow = this.deps.getSlowQueries();
    const byCollection = new Map<string, number>();
    for (const q of slow) {
      byCollection.set(q.collection, (byCollection.get(q.collection) ?? 0) + 1);
    }

    for (const [collection, hits] of byCollection) {
      if (hits < (this.config.minHits ?? 2)) continue;
      if (!seed) {
        const entry: AutoTuneAuditEntry = {
          ts: Date.now(),
          action: 'recommend',
          message: `慢查询 ${hits} 次 @ ${collection}；提供 JsonQuery 可得到字段级建议`,
          dryRun: this.config.dryRun,
        };
        this.audit.push(entry);
        created.push(entry);
      }
    }

    const applied: IndexMeta[] = [];

    for (const a of advice) {
      if (a.type !== 'index' || !a.suggestion) continue;
      const sug = a.suggestion as {
        collection: string;
        field: string;
        type: IndexType;
      };
      const exists = indexes.some(
        (i) => i.collection === sug.collection && i.field === sug.field,
      );
      if (exists) {
        const skip: AutoTuneAuditEntry = {
          ts: Date.now(),
          action: 'skip',
          message: `索引已存在 ${sug.collection}.${sug.field}`,
          suggestion: sug,
          dryRun: this.config.dryRun,
        };
        this.audit.push(skip);
        created.push(skip);
        continue;
      }

      if (this.config.dryRun) {
        const rec: AutoTuneAuditEntry = {
          ts: Date.now(),
          action: 'recommend',
          message: a.message,
          suggestion: sug,
          dryRun: true,
        };
        this.audit.push(rec);
        created.push(rec);
      } else {
        const meta = await this.deps.createIndex(
          sug.collection,
          sug.field,
          sug.type,
        );
        applied.push(meta);
        const done: AutoTuneAuditEntry = {
          ts: Date.now(),
          action: 'create',
          message: `已创建索引 ${sug.collection}.${sug.field} (${sug.type})`,
          suggestion: sug,
          dryRun: false,
        };
        this.audit.push(done);
        created.push(done);
        indexes.push({
          collection: sug.collection,
          field: sug.field,
          type: sug.type,
          createdAt: Date.now(),
        });
      }
    }

    if (this.config.dryRun) {
      this.history.push({
        ts: Date.now(),
        kind: 'dry-run',
        before,
        after: before,
        message: 'dry-run: no indexes changed',
      });
      return created;
    }

    if (applied.length > 0) {
      try {
        await this.deps.validateApply?.(applied);
        this.history.push({
          ts: Date.now(),
          kind: 'apply',
          before,
          after: this.deps.listIndexes().map((i) => ({ ...i })),
          message: `applied ${applied.length} index(es)`,
        });
      } catch (err) {
        for (const meta of applied) {
          await this.deps.dropIndex(meta.collection, meta.field).catch(() => undefined);
        }
        const msg = err instanceof Error ? err.message : String(err);
        const fail: AutoTuneAuditEntry = {
          ts: Date.now(),
          action: 'apply_failed',
          message: `AutoTune apply failed: ${msg}`,
          dryRun: false,
        };
        this.audit.push(fail);
        created.push(fail);
        const rb: AutoTuneAuditEntry = {
          ts: Date.now(),
          action: 'rollback',
          message: `rolled back to pre-apply index set (${before.length} indexes)`,
          dryRun: false,
        };
        this.audit.push(rb);
        created.push(rb);
        this.history.push({
          ts: Date.now(),
          kind: 'rollback',
          before,
          after: this.deps.listIndexes().map((i) => ({ ...i })),
          message: msg,
        });
      }
    }

    return created;
  }
}
