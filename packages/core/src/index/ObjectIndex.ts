import type { Document } from '../types/index.js';
import type { Index, IndexMeta } from './types.js';

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

  constructor(readonly meta: IndexMeta) {}

  build(docs: Document[]): void {
    this.map.clear();
    for (const doc of docs) this.insert(doc);
  }

  insert(doc: Document): void {
    const k = keyOf(fieldValue(doc, this.meta.field));
    let set = this.map.get(k);
    if (!set) {
      set = new Set();
      this.map.set(k, set);
    }
    set.add(doc._id);
  }

  update(prev: Document | undefined, next: Document): void {
    if (prev) this.remove(prev);
    this.insert(next);
  }

  remove(doc: Document): void {
    const k = keyOf(fieldValue(doc, this.meta.field));
    const set = this.map.get(k);
    if (!set) return;
    set.delete(doc._id);
    if (set.size === 0) this.map.delete(k);
  }

  lookupEq(value: unknown): string[] {
    return Array.from(this.map.get(keyOf(value)) ?? []);
  }

  lookupRange(): string[] {
    return [];
  }

  lookupText(): string[] {
    return [];
  }
}
