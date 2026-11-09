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
  };
  timestamp: number;
}

export class Monitor {
  private queries: QueryMetric[] = [];
  private readonly max = 1000;
  queriesTotal = 0;
  writesTotal = 0;
  errorsTotal = 0;
  slowQueryThreshold = 100;
  private readonly filterCounts = new Map<string, Map<string, number>>();
  collectionsLoaded = 0;
  loadMs = 0;
  openLoadMs = 0;

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

  metrics(cacheHitRate: number, openCollections: number) {
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
    };
  }

  health(
    ready: boolean,
    storageWritable: boolean,
    cacheHitRate: number,
    openCollections: number,
  ): HealthReport {
    const status: HealthReport['status'] =
      ready && storageWritable ? 'healthy' : 'degraded';
    return {
      status,
      checks: {
        ready,
        storageWritable,
        cacheHitRate,
        openCollections,
        collectionsLoaded: this.collectionsLoaded,
        loadMs: this.loadMs,
      },
      timestamp: Date.now(),
    };
  }
}
