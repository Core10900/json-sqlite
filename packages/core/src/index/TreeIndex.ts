import type { Document } from '../types/index.js';
import type { Index, IndexMeta, IndexSnapshot } from './types.js';

function fieldValue(doc: Document, field: string): unknown {
  if (!field.includes('.')) return doc[field];
  return field.split('.').reduce<unknown>((cur, p) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[p];
    return undefined;
  }, doc);
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return String(a).localeCompare(String(b));
}

/** Ordered index (sorted keys + id sets). Sufficient for v1 range queries. */
export class TreeIndex implements Index {
  private keys: unknown[] = [];
  private map = new Map<string, Set<string>>();

  constructor(readonly meta: IndexMeta) {}

  build(docs: Document[]): void {
    this.keys = [];
    this.map.clear();
    for (const doc of docs) this.insert(doc);
  }

  private sk(v: unknown): string {
    return JSON.stringify(v);
  }

  insert(doc: Document): void {
    const v = fieldValue(doc, this.meta.field);
    const k = this.sk(v);
    let set = this.map.get(k);
    if (!set) {
      set = new Set();
      this.map.set(k, set);
      this.keys.push(v);
      this.keys.sort(cmp);
    }
    set.add(doc._id);
  }

  update(prev: Document | undefined, next: Document): void {
    if (prev) this.remove(prev);
    this.insert(next);
  }

  remove(doc: Document): void {
    const v = fieldValue(doc, this.meta.field);
    const k = this.sk(v);
    const set = this.map.get(k);
    if (!set) return;
    set.delete(doc._id);
    if (set.size === 0) {
      this.map.delete(k);
      this.keys = this.keys.filter((x) => this.sk(x) !== k);
    }
  }

  lookupEq(value: unknown): string[] {
    return Array.from(this.map.get(this.sk(value)) ?? []);
  }

  lookupRange(min?: unknown, max?: unknown): string[] {
    const out: string[] = [];
    for (const k of this.keys) {
      if (min !== undefined && cmp(k, min) < 0) continue;
      if (max !== undefined && cmp(k, max) > 0) continue;
      const set = this.map.get(this.sk(k));
      if (set) out.push(...set);
    }
    return out;
  }

  lookupText(): string[] {
    return [];
  }

  exportEntries(): IndexSnapshot {
    return {
      entries: [...this.map].map(([k, ids]) => [k, [...ids]]),
      keys: [...this.keys],
    };
  }

  importEntries(snapshot: IndexSnapshot): void {
    this.map.clear();
    this.keys = snapshot.keys ? [...snapshot.keys] : [];
    for (const [k, ids] of snapshot.entries) this.map.set(k, new Set(ids));
    if (!snapshot.keys) {
      this.keys = snapshot.entries.map(([k]) => JSON.parse(k) as unknown);
      this.keys.sort(cmp);
    }
  }
}
