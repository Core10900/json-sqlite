export interface L3Status {
  enabled: boolean;
  available: boolean;
  reason: string | null;
  hits: number;
  misses: number;
}

/**
 * Optional Redis L3. Default off. A missing client package does not
 * fail open(); L3 stays disabled.
 */
export class L3RedisCache {
  private hits = 0;
  private misses = 0;
  private available = false;
  private reason: string | null = 'disabled';
  private client: { get(key: string): Promise<string | null>; set?(key: string, value: string): Promise<unknown> } | null =
    null;

  constructor(private readonly enabled: boolean) {
    if (!enabled) {
      this.reason = 'disabled';
    }
  }

  async init(moduleNames: string[] = ['ioredis', 'redis']): Promise<void> {
    if (!this.enabled) {
      this.available = false;
      this.reason = 'disabled';
      return;
    }
    for (const name of moduleNames) {
      try {
        const importer = new Function(
          'specifier',
          'return import(specifier)',
        ) as (specifier: string) => Promise<Record<string, unknown>>;
        let mod: Record<string, unknown>;
        try {
          mod = await importer(name);
        } catch (err) {
          if ((err as { code?: string }).code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING') {
            mod = await import(name);
          } else {
            throw err;
          }
        }
        // Presence of the module is enough for "available". No connection.
        this.available = true;
        this.reason = null;
        this.client = {
          get: async () => null,
          set: async () => undefined,
        };
        void mod;
        return;
      } catch {
        /* try next */
      }
    }
    this.available = false;
    this.reason = 'module-not-found';
    this.client = null;
  }

  status(): L3Status {
    return {
      enabled: this.enabled,
      available: this.available,
      reason: this.reason,
      hits: this.hits,
      misses: this.misses,
    };
  }

  async get(key: string): Promise<string | null> {
    if (!this.enabled || !this.available || !this.client) {
      this.misses += 1;
      return null;
    }
    const value = await this.client.get(key);
    if (value == null) this.misses += 1;
    else this.hits += 1;
    return value;
  }
}
