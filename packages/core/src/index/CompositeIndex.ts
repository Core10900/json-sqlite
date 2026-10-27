import type { Document } from '../types/index.js';
import type { Index, IndexMeta, IndexSnapshot } from './types.js';

function fieldValue(doc: Document, field: string): unknown {
  if (!field.includes('.')) return doc[field];
  return field.split('.').reduce<unknown>((cur, p) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[p];
    return undefined;
  }, doc);
}

function compositeKey(doc: Document, fields: string[]): string {
  return JSON.stringify(fields.map((f) => fieldValue(doc, f)));
}

/** Multi-field equality (prefix) index. */
export class CompositeIndex implements Index {
  private map = new Map<string, Set<string>>();
  private readonly fields: string[];

  constructor(readonly meta: IndexMeta) {
    this.fields =
      meta.fields && meta.fields.length > 0
        ? meta.fields
        : meta.field.split('+').filter(Boolean);
  }

  build(docs: Document[]): void {
    this.map.clear();
    for (const doc of docs) this.insert(doc);
  }

  insert(doc: Document): void {
    const k = compositeKey(doc, this.fields);
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
    const k = compositeKey(doc, this.fields);
    const set = this.map.get(k);
    if (!set) return;
    set.delete(doc._id);
    if (set.size === 0) this.map.delete(k);
  }

  /** Equality on full composite key (array of values matching fields order). */
  lookupEq(value: unknown): string[] {
    const key =
      Array.isArray(value) ? JSON.stringify(value) : JSON.stringify([value]);
    return Array.from(this.map.get(key) ?? []);
  }

  /** Prefix equality: values for the first N fields. */
  lookupPrefix(values: unknown[]): string[] {
    if (values.length === 0 || values.length > this.fields.length) return [];
    if (values.length === this.fields.length) return this.lookupEq(values);
    const prefix = JSON.stringify(values).slice(0, -1); // strip trailing ]
    const out = new Set<string>();
    for (const [k, ids] of this.map) {
      if (k.startsWith(prefix) && (k[prefix.length] === ',' || k[prefix.length] === ']')) {
        for (const id of ids) out.add(id);
      }
    }
    return Array.from(out);
  }

  lookupRange(): string[] {
    return [];
  }

  lookupText(): string[] {
    return [];
  }

  exportEntries(): IndexSnapshot {
    return {
      entries: [...this.map].map(([k, ids]) => [k, [...ids]]),
    };
  }

  importEntries(snapshot: IndexSnapshot): void {
    this.map.clear();
    for (const [k, ids] of snapshot.entries) this.map.set(k, new Set(ids));
  }
}
