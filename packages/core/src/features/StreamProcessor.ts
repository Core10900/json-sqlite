import type { Document } from '../types/index.js';

export type StreamAggOp = 'count' | 'sum' | 'avg';

export interface SlidingWindowOptions {
  /** Only count events for this collection (omit = all). */
  collection?: string;
  /** Window size in milliseconds. */
  windowMs: number;
  /** Aggregation: count events, or sum/avg a numeric field from event.after / event.doc. */
  op?: StreamAggOp;
  field?: string;
  /** Max events retained inside the window (default 10_000). */
  maxEvents?: number;
}

export interface SlidingWindowSnapshot {
  count: number;
  value: number;
  windowMs: number;
  fromTs: number;
  toTs: number;
}

export interface StreamLike {
  subscribe(handler: (event: unknown) => void): () => void;
}

interface TimedEvent {
  ts: number;
  collection?: string;
  numeric?: number;
}

/**
 * In-process sliding-window aggregator over `subscribe` / dataChanged events.
 * Capability boundary: single-process memory only; not durable; not multi-node.
 */
export class StreamProcessor {
  constructor(private readonly source: StreamLike) {}

  /**
   * Start a sliding window. Call `stop()` (or the returned disposer) to unsubscribe.
   */
  slidingWindow(opts: SlidingWindowOptions): {
    getSnapshot: () => SlidingWindowSnapshot;
    stop: () => void;
  } {
    const windowMs = Math.max(1, opts.windowMs);
    const maxEvents = opts.maxEvents ?? 10_000;
    const op = opts.op ?? 'count';
    const events: TimedEvent[] = [];

    const unsub = this.source.subscribe((raw) => {
      const ev = raw as Record<string, unknown>;
      const collection =
        typeof ev.collection === 'string' ? ev.collection : undefined;
      if (opts.collection && collection !== opts.collection) return;

      let numeric: number | undefined;
      if (op === 'sum' || op === 'avg') {
        const doc =
          (ev.after as Document | undefined) ??
          (ev.doc as Document | undefined) ??
          (ev as Document);
        const field = opts.field;
        if (field && doc && typeof doc === 'object') {
          const v = (doc as Record<string, unknown>)[field];
          if (typeof v === 'number') numeric = v;
        }
        if (numeric === undefined && typeof ev.count === 'number') {
          numeric = ev.count;
        }
      }

      events.push({ ts: Date.now(), collection, numeric });
      if (events.length > maxEvents) events.shift();
    });

    const prune = (now: number) => {
      const cutoff = now - windowMs;
      while (events.length && events[0]!.ts < cutoff) events.shift();
    };

    return {
      getSnapshot: () => {
        const now = Date.now();
        prune(now);
        const count = events.length;
        let value = 0;
        if (op === 'count') {
          value = count;
        } else {
          const nums = events
            .map((e) => e.numeric)
            .filter((n): n is number => typeof n === 'number');
          if (op === 'sum') {
            value = nums.reduce((a, b) => a + b, 0);
          } else {
            value = nums.length
              ? nums.reduce((a, b) => a + b, 0) / nums.length
              : 0;
          }
        }
        return {
          count,
          value,
          windowMs,
          fromTs: now - windowMs,
          toTs: now,
        };
      },
      stop: () => unsub(),
    };
  }
}
