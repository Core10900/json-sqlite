export interface QueryMetric {
  ts: number;
  collection: string;
  durationMs: number;
  resultCount: number;
  usedIndex?: string;
}

export interface HealthReport {
  status: 'healthy' | 'degraded';
  checks: {
    ready: boolean;
    storageWritable: boolean;
    cacheHitRate: number;
    openCollections: number;
    collectionsLoaded: number;
    loadMs: number;
    memoryBytes: number;
    lockCount: number;
  };
  timestamp: number;
}

export interface AdviceFeedback {
  ts: number;
  decision: 'accept' | 'reject';
  collection?: string;
  field?: string;
  type?: string;
  message?: string;
}

export class Monitor {
  private queries: QueryMetric[] = [];
  private readonly max = 1000;
  queriesTotal = 0;
  writesTotal = 0;
  errorsTotal = 0;
  slowQueryThreshold = 100;
  private readonly filterCounts = new Map<string, Map<string, number>>();
  private readonly adviceFeedback: AdviceFeedback[] = [];
  private lockWaitMsTotal = 0;
  collectionsLoaded = 0;
  loadMs = 0;
  openLoadMs = 0;
  /** Sliding window for QPS / percentiles. Default 60s. */
  windowMs = 60_000;

  recordQuery(metric: QueryMetric): void {
    this.queriesTotal += 1;
    this.queries.push(metric);
    if (this.queries.length > this.max) this.queries.shift();
  }

  /**
   * Count filter field names for storage advice. The values are hit counts.
   * Document contents are not stored.
   */
  recordFilterFields(collection: string, fields: string[]): void {
    let counts = this.filterCounts.get(collection);
    if (!counts) {
      counts = new Map();
      this.filterCounts.set(collection, counts);
    }
    for (const field of fields) {
      if (!field || field.startsWith('$')) continue;
      counts.set(field, (counts.get(field) ?? 0) + 1);
    }
  }

  filterHistogram(collection: string): Record<string, number> {
    return Object.fromEntries(this.filterCounts.get(collection) ?? []);
  }

  recordWrite(): void {
    this.writesTotal += 1;
  }

  recordError(): void {
    this.errorsTotal += 1;
  }

  recordLockWait(ms: number): void {
    if (ms > 0) this.lockWaitMsTotal += ms;
  }

  recordAdviceFeedback(entry: Omit<AdviceFeedback, 'ts'> & { ts?: number }): void {
    this.adviceFeedback.push({
      ts: entry.ts ?? Date.now(),
      decision: entry.decision,
      ...(entry.collection ? { collection: entry.collection } : {}),
      ...(entry.field ? { field: entry.field } : {}),
      ...(entry.type ? { type: entry.type } : {}),
      ...(entry.message ? { message: entry.message } : {}),
    });
    if (this.adviceFeedback.length > this.max) this.adviceFeedback.shift();
  }

  adviceFeedbackSnapshot(): AdviceFeedback[] {
    return [...this.adviceFeedback];
  }

  rejectedIndexKeys(): Set<string> {
    const out = new Set<string>();
    for (const entry of this.adviceFeedback) {
      if (entry.decision !== 'reject') continue;
      if (entry.collection && entry.field) {
        out.add(`${entry.collection}.${entry.field}`);
      }
    }
    return out;
  }

  recordCollectionLoad(durationMs: number): void {
    this.collectionsLoaded += 1;
    this.loadMs += durationMs;
  }

  setOpenLoadMs(ms: number): void {
    this.openLoadMs = ms;
  }

  getSlowQueries(threshold = this.slowQueryThreshold): QueryMetric[] {
    return this.queries.filter((q) => q.durationMs > threshold);
  }

  private windowQueries(now = Date.now()): QueryMetric[] {
    const cutoff = now - this.windowMs;
    return this.queries.filter((q) => q.ts >= cutoff);
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    );
    return sorted[idx]!;
  }

  latencySnapshot(now = Date.now()): {
    qps: number;
    p50: number;
    p95: number;
    p99: number;
    errorRate: number;
    windowMs: number;
  } {
    const window = this.windowQueries(now);
    const durations = window.map((q) => q.durationMs).sort((a, b) => a - b);
    const denom = this.queriesTotal + this.writesTotal + this.errorsTotal || 1;
    return {
      qps: window.length / (this.windowMs / 1000),
      p50: this.percentile(durations, 50),
      p95: this.percentile(durations, 95),
      p99: this.percentile(durations, 99),
      errorRate: this.errorsTotal / denom,
      windowMs: this.windowMs,
    };
  }

  metrics(cacheHitRate: number, openCollections: number) {
    const latency = this.latencySnapshot();
    return {
      queriesTotal: this.queriesTotal,
      writesTotal: this.writesTotal,
      errorsTotal: this.errorsTotal,
      cacheHitRate,
      openCollections,
      collectionsLoaded: this.collectionsLoaded,
      loadMs: this.loadMs,
      openLoadMs: this.openLoadMs,
      recentSlow: this.getSlowQueries().slice(-20),
      memory: process.memoryUsage(),
      qps: latency.qps,
      p50: latency.p50,
      p95: latency.p95,
      p99: latency.p99,
      errorRate: latency.errorRate,
      windowMs: latency.windowMs,
      lockWaitMs: this.lockWaitMsTotal,
      adviceFeedback: this.adviceFeedbackSnapshot(),
    };
  }

  health(
    ready: boolean,
    storageWritable: boolean,
    cacheHitRate: number,
    openCollections: number,
    opts?: {
      memoryBytes?: number;
      lockCount?: number;
      memoryWatermarkBytes?: number;
    },
  ): HealthReport {
    const memoryBytes = opts?.memoryBytes ?? process.memoryUsage().heapUsed;
    const lockCount = opts?.lockCount ?? 0;
    const watermark = opts?.memoryWatermarkBytes ?? 0;
    let status: HealthReport['status'] =
      ready && storageWritable ? 'healthy' : 'degraded';
    if (watermark > 0 && memoryBytes > watermark) status = 'degraded';
    return {
      status,
      checks: {
        ready,
        storageWritable,
        cacheHitRate,
        openCollections,
        collectionsLoaded: this.collectionsLoaded,
        loadMs: this.loadMs,
        memoryBytes,
        lockCount,
      },
      timestamp: Date.now(),
    };
  }
}
