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
  action: 'recommend' | 'create' | 'skip';
  message: string;
  suggestion?: { collection: string; field: string; type: IndexType };
  dryRun: boolean;
}

export interface AutoTuneDeps {
  listIndexes: () => IndexMeta[];
  createIndex: (
    collection: string,
    field: string,
    type: IndexType,
  ) => Promise<IndexMeta>;
  getSlowQueries: (threshold?: number) => QueryMetric[];
}

/**
 * Optional auto-index tuner. Default off; when on, uses Advisor + slow queries.
 * Always appends audit entries; dry-run never mutates indexes.
 */
export class AutoTune {
  private readonly audit: AutoTuneAuditEntry[] = [];
  private config: AutoTuneConfig;

  constructor(
    private readonly deps: AutoTuneDeps,
    config?: Partial<AutoTuneConfig>,
  ) {
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

  getAuditLog(): AutoTuneAuditEntry[] {
    return [...this.audit];
  }

  clearAudit(): void {
    this.audit.length = 0;
  }

  /** Run once against current slow-query buffer + optional seed query. */
  async tick(seed?: JsonQuery): Promise<AutoTuneAuditEntry[]> {
    if (!this.config.enabled) return [];

    const created: AutoTuneAuditEntry[] = [];
    const indexes = this.deps.listIndexes();
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
      // Suggest object index on _id-less filters is weak; prefer seed advice.
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
        await this.deps.createIndex(sug.collection, sug.field, sug.type);
        const done: AutoTuneAuditEntry = {
          ts: Date.now(),
          action: 'create',
          message: `已创建索引 ${sug.collection}.${sug.field} (${sug.type})；回滚: dropIndex('${sug.collection}','${sug.field}')`,
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

    return created;
  }
}
