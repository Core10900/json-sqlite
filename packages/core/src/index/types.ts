import type { Document } from '../types/index.js';

import type { IndexType } from '../types/index.js';
export type { IndexType };

export interface IndexMeta {
  collection: string;
  field: string;
  type: IndexType;
  createdAt: number;
}

export interface Index {
  readonly meta: IndexMeta;
  build(docs: Document[]): void;
  insert(doc: Document): void;
  update(prev: Document | undefined, next: Document): void;
  remove(doc: Document): void;
  /** Equality lookup → document ids */
  lookupEq(value: unknown): string[];
  /** Range lookup (tree); others may return [] */
  lookupRange(min?: unknown, max?: unknown): string[];
  /** Full-text search (inverted); others may return [] */
  lookupText(query: string, limit?: number): string[];
}
