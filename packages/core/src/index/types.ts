import type { Document } from '../types/index.js';

import type { IndexType } from '../types/index.js';
export type { IndexType };

export interface IndexMeta {
  collection: string;
  /** Primary field, or `a+b` joined key for composite indexes. */
  field: string;
  type: IndexType;
  createdAt: number;
  /** Composite field list (equality prefix order). */
  fields?: string[];
}

/** Serializable posting lists. Keys are index-internal (usually JSON.stringify). */
export interface IndexSnapshot {
  entries: [string, string[]][];
  /** TreeIndex key order (raw values). */
  keys?: unknown[];
  docFreq?: [string, number][];
  totalDocs?: number;
}

export interface Index {
  readonly meta: IndexMeta;
  build(docs: Document[]): void;
  insert(doc: Document): void;
  update(prev: Document | undefined, next: Document): void;
  remove(doc: Document): void;
  exportEntries(): IndexSnapshot;
  importEntries(snapshot: IndexSnapshot): void;
  /** Equality lookup → document ids */
  lookupEq(value: unknown): string[];
  /** Range lookup (tree); others may return [] */
  lookupRange(min?: unknown, max?: unknown): string[];
  /** Full-text search (inverted); others may return [] */
  lookupText(query: string, limit?: number): string[];
  /** Composite prefix equality (optional). */
  lookupPrefix?(values: unknown[]): string[];
}
