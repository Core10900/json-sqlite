export class L1Cache<V = unknown> {
  private readonly map = new Map<string, V>();
  hits = 0;
  misses = 0;
  evictions = 0;

  constructor(private readonly maxSize = 1000) {}

  get(key: string): V | undefined {
    if (!this.map.has(key)) {
      this.misses += 1;
      return undefined;
    }
    const value = this.map.get(key)!;
    // LRU refresh
    this.map.delete(key);
    this.map.set(key, value);
    this.hits += 1;
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxSize) {
      const first = this.map.keys().next().value as string | undefined;
      if (first !== undefined) {
        this.map.delete(first);
        this.evictions += 1;
      }
    }
    this.map.set(key, value);
  }

  invalidateCollection(collection: string): void {
    const prefix = `${collection}::`;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get stats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.map.size,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}
