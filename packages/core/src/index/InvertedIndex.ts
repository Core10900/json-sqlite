import type { Document } from '../types/index.js';
import type { Index, IndexMeta, IndexSnapshot } from './types.js';

import { ErrorCode, JSONSQLiteError } from '../errors.js';

/** Default inverted-index stop words. An empty configured list drops nothing. */
export const DEFAULT_STOP_WORDS = [
  '的',
  '了',
  '是',
  '在',
  '和',
  '有',
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
];

const DEFAULT_STOP = new Set(DEFAULT_STOP_WORDS);

function fieldValue(doc: Document, field: string): unknown {
  if (!field.includes('.')) return doc[field];
  return field.split('.').reduce<unknown>((cur, p) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[p];
    return undefined;
  }, doc);
}

export function tokenize(text: string, stop: ReadonlySet<string> = DEFAULT_STOP): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，。.!！?？;；、：:]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !stop.has(t));
}

export class InvertedIndex implements Index {
  private map = new Map<string, Set<string>>();
  private docFreq = new Map<string, number>();
  private totalDocs = 0;
  private stop: Set<string>;

  constructor(
    readonly meta: IndexMeta,
    private readonly tokenizeFn: (text: string) => string[] = tokenize,
    stop?: Set<string>,
  ) {
    this.stop = stop ?? new Set(DEFAULT_STOP_WORDS);
  }

  /** Replace the stop list. The caller rebuilds postings afterwards. */
  setStopWords(stop: Set<string>): void {
    this.stop = stop;
  }

  private tokens(text: string): string[] {
    try {
      if (this.tokenizeFn === tokenize) return tokenize(text, this.stop);
      return this.tokenizeFn(text).filter((token) => !this.stop.has(token));
    } catch (err) {
      if (err instanceof JSONSQLiteError) throw err;
      throw new JSONSQLiteError(
        ErrorCode.TOKENIZER_FAILED,
        'Tokenizer failed',
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  build(docs: Document[]): void {
    this.map.clear();
    this.docFreq.clear();
    this.totalDocs = 0;
    for (const doc of docs) this.insert(doc);
  }

  insert(doc: Document): void {
    this.totalDocs += 1;
    const text = String(fieldValue(doc, this.meta.field) ?? '');
    const seen = new Set<string>();
    for (const token of this.tokens(text)) {
      let set = this.map.get(token);
      if (!set) {
        set = new Set();
        this.map.set(token, set);
      }
      const before = set.size;
      set.add(doc._id);
      if (set.size > before && !seen.has(token)) {
        this.docFreq.set(token, (this.docFreq.get(token) ?? 0) + 1);
        seen.add(token);
      }
    }
  }

  update(prev: Document | undefined, next: Document): void {
    if (prev) this.remove(prev);
    this.insert(next);
  }

  remove(doc: Document): void {
    const text = String(fieldValue(doc, this.meta.field) ?? '');
    for (const token of new Set(this.tokens(text))) {
      const set = this.map.get(token);
      if (!set) continue;
      if (set.delete(doc._id)) {
        this.docFreq.set(token, Math.max(0, (this.docFreq.get(token) ?? 1) - 1));
      }
      if (set.size === 0) {
        this.map.delete(token);
        this.docFreq.delete(token);
      }
    }
    this.totalDocs = Math.max(0, this.totalDocs - 1);
  }

  lookupEq(): string[] {
    return [];
  }

  lookupRange(): string[] {
    return [];
  }

  lookupText(query: string, limit = 100): string[] {
    const scores = new Map<string, number>();
    for (const term of this.tokens(query)) {
      const docs = this.map.get(term);
      if (!docs) continue;
      const df = this.docFreq.get(term) ?? 1;
      const idf = Math.log((this.totalDocs + 1) / (df + 1)) + 1;
      for (const id of docs) {
        scores.set(id, (scores.get(id) ?? 0) + idf);
      }
    }
    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);
  }

  stats(): { keys: number; docs: number } {
    return { keys: this.map.size, docs: this.totalDocs };
  }

  exportEntries(): IndexSnapshot {
    return {
      entries: [...this.map].map(([k, ids]) => [k, [...ids]]),
      docFreq: [...this.docFreq],
      totalDocs: this.totalDocs,
    };
  }

  importEntries(snapshot: IndexSnapshot): void {
    this.map.clear();
    this.docFreq.clear();
    for (const [k, ids] of snapshot.entries) this.map.set(k, new Set(ids));
    for (const [k, n] of snapshot.docFreq ?? []) this.docFreq.set(k, n);
    this.totalDocs = snapshot.totalDocs ?? 0;
  }
}
