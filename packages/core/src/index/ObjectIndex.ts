import type { Document } from '../types/index.js';
import type { Index, IndexMeta, IndexSnapshot } from './types.js';

function keyOf(value: unknown): string {
  return JSON.stringify(value);
}

function fieldValue(doc: Document, field: string): unknown {
  if (!field.includes('.')) return doc[field];
  return field.split('.').reduce<unknown>((cur, p) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[p];
    return undefined;
  }, doc);
}

export class ObjectIndex implements Index {
  private map = new Map<string, Set<string>>();
  private docCount = 0;

  constructor(readonly meta: IndexMeta) {}

  build(docs: Document[]): void {
    this.map.clear();
    this.docCount = 0;
    for (const doc of docs) this.insert(doc);
  }

  insert(doc: Document): void {
    const k = keyOf(fieldValue(doc, this.meta.field));
    let set = this.map.get(k);
    if (!set) {
      set = new Set();
      this.map.set(k, set);
    }
    const before = set.size;
    set.add(doc._id);
    if (set.size > before) this.docCount += 1;
  }

  update(prev: Document | undefined, next: Document): void {
    if (prev) this.remove(prev);
    this.insert(next);
  }

  remove(doc: Document): void {
    const k = keyOf(fieldValue(doc, this.meta.field));
    const set = this.map.get(k);
    if (!set) return;
    if (!set.delete(doc._id)) return;
    this.docCount -= 1;
    if (set.size === 0) this.map.delete(k);
  }

  lookupEq(value: unknown): string[] {
    const set = this.map.get(keyOf(value));
    if (!set || set.size === 0) return [];
    // Avoid Array.from allocator for the common single-hit equality case.
    if (set.size === 1) {
      for (const id of set) return [id];
    }
    return [...set];
  }

  lookupRange(): string[] {
    return [];
  }

  lookupText(): string[] {
    return [];
  }

  stats(): { keys: number; docs: number } {
    return { keys: this.map.size, docs: this.docCount };
  }

  exportEntries(): IndexSnapshot {
    return {
      entries: [...this.map].map(([k, ids]) => [k, [...ids]]),
    };
  }

  importEntries(snapshot: IndexSnapshot): void {
    this.map.clear();
    this.docCount = 0;
    for (const [k, ids] of snapshot.entries) {
      this.map.set(k, new Set(ids));
      this.docCount += ids.length;
    }
  }
}
