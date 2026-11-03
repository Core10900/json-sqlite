import { gunzipSync, gzipSync } from 'node:zlib';
import type { Document } from '../types/index.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { L1Cache } from './L1Cache.js';

type Stored = Document[] | { v: 1; gz: string };

export interface CacheCompressionStats {
  enabled: boolean;
  threshold: number;
  compressedSets: number;
}

/**
 * Query-result cache. With compression off, values are stored as document
 * arrays, same as L1Cache. Large values can be gzipped; a hit returns the
 * original documents. A failed round-trip throws DATA_CORRUPT.
 */
export class ResultCache {
  private readonly inner: L1Cache<Stored>;
  compressedSets = 0;

  constructor(
    maxSize: number,
    private readonly compress: boolean,
    private readonly threshold: number,
  ) {
    this.inner = new L1Cache<Stored>(maxSize);
  }

  get stats() {
    return this.inner.stats;
  }

  compressionStats(): CacheCompressionStats {
    return {
      enabled: this.compress,
      threshold: this.threshold,
      compressedSets: this.compressedSets,
    };
  }

  encoding(key: string): 'plain' | 'compressed' | 'miss' {
    const raw = this.peek(key);
    if (raw === undefined) return 'miss';
    return Array.isArray(raw) ? 'plain' : 'compressed';
  }

  get(key: string): Document[] | undefined {
    const raw = this.inner.get(key);
    if (raw === undefined) return undefined;
    if (Array.isArray(raw)) return raw;
    try {
      const json = gunzipSync(Buffer.from(raw.gz, 'base64')).toString('utf8');
      const docs = JSON.parse(json) as Document[];
      if (!Array.isArray(docs)) {
        throw new Error('cached value is not a document array');
      }
      return docs;
    } catch (err) {
      if (err instanceof JSONSQLiteError) throw err;
      throw new JSONSQLiteError(
        ErrorCode.DATA_CORRUPT,
        'Cache value decompression failed',
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  set(key: string, docs: Document[]): void {
    if (!this.compress) {
      this.inner.set(key, docs);
      return;
    }
    const json = JSON.stringify(docs);
    if (Buffer.byteLength(json) < this.threshold) {
      this.inner.set(key, docs);
      return;
    }
    const gz = gzipSync(Buffer.from(json, 'utf8')).toString('base64');
    const back = gunzipSync(Buffer.from(gz, 'base64')).toString('utf8');
    if (back !== json) {
      throw new JSONSQLiteError(
        ErrorCode.DATA_CORRUPT,
        'Cache value compression round-trip failed',
      );
    }
    this.inner.set(key, { v: 1, gz });
    this.compressedSets += 1;
  }

  invalidateCollection(collection: string): void {
    this.inner.invalidateCollection(collection);
  }

  clear(): void {
    this.inner.clear();
  }

  /** Read without counting a hit. Used to tell compressed entries from plain ones. */
  private peek(key: string): Stored | undefined {
    const hits = this.inner.hits;
    const misses = this.inner.misses;
    const value = this.inner.get(key);
    this.inner.hits = hits;
    this.inner.misses = misses;
    return value;
  }
}
