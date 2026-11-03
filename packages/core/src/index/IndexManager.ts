import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document, SyncMode } from '../types/index.js';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { ObjectIndex } from './ObjectIndex.js';
import { TreeIndex } from './TreeIndex.js';
import { InvertedIndex, tokenize } from './InvertedIndex.js';
import { CompositeIndex } from './CompositeIndex.js';
import { GeoIndex } from './GeoIndex.js';
import type { Index, IndexMeta, IndexType } from './types.js';
import {
  INDEX_SEGMENT_FORMAT,
  checksumBody,
  revisionSum,
  segmentFileName,
  type SegmentBody,
  type SegmentStamp,
} from './segment.js';

interface IndexesFile {
  indexes: IndexMeta[];
  segments?: Record<string, SegmentStamp>;
}

export interface CreateIndexOptions {
  fields?: string[];
}

export interface IndexDiagnostics {
  persist: boolean;
  buildCount: number;
  restored: string[];
  servedFromSegment: string[];
  rebuilt: string[];
  corrupt: { key: string; reason: string }[];
  segmentCount: number;
  /** Index keys whose on-disk segment was produced by compact. */
  merged: string[];
  /** Part count for delta segments. Absent keys use a single file. */
  parts: Record<string, number>;
}

export class IndexManager {
  private readonly indexes = new Map<string, Index>();
  private readonly segmentMeta = new Map<string, SegmentStamp>();
  private readonly restored = new Set<string>();
  private readonly servedFromSegment = new Set<string>();
  private readonly rebuilt = new Set<string>();
  private corrupt: { key: string; reason: string }[] = [];
  private buildCount = 0;

  private tokenizeFn: ((text: string) => string[]) | null = null;

  constructor(
    private readonly storagePath: string,
    private readonly syncMode: SyncMode = 'normal',
    private readonly persistSegments = true,
    private readonly deltaSegments = false,
  ) {}

  /** Inverted indexes built after this call use `fn`. Null restores the default splitter. */
  setTokenizer(fn: ((text: string) => string[]) | null): void {
    this.tokenizeFn = fn;
  }

  private key(collection: string, field: string): string {
    return `${collection}:${field}`;
  }

  private file(): string {
    return path.join(this.storagePath, 'meta', 'indexes.json');
  }

  private segmentPath(collection: string, field: string): string {
    return path.join(
      this.storagePath,
      'meta',
      'idx',
      segmentFileName(collection, field),
    );
  }

  /**
   * Load index metadata and, when persistence is on, restore segment
   * postings. Callers still decide whether a restored segment is fresh
   * (`trustSegment`) or must be rebuilt from documents.
   */
  async load(): Promise<void> {
    let data: IndexesFile = { indexes: [] };
    try {
      const raw = await fs.readFile(this.file(), 'utf8');
      data = JSON.parse(raw) as IndexesFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await this.save();
      return;
    }
    for (const meta of data.indexes) {
      const idx = this.createInstance(meta);
      const k = this.key(meta.collection, meta.field);
      this.indexes.set(k, idx);
      const hint = data.segments?.[k];
      if (hint) this.segmentMeta.set(k, hint);
      if (this.persistSegments) await this.tryRestore(k, idx);
    }
  }

  /**
   * True when every index on `collection` was restored and its stamp
   * matches the loaded documents. WAL replay always forces a rebuild.
   */
  trustSegment(
    collection: string,
    stats: { docCount: number; revisionSum: number },
    walReplay: boolean,
  ): boolean {
    if (!this.persistSegments || walReplay || this.tokenizeFn) return false;
    const list = this.findForCollection(collection);
    if (list.length === 0) return true;
    const docCount = stats.docCount;
    const rev = stats.revisionSum;
    for (const idx of list) {
      const k = this.key(idx.meta.collection, idx.meta.field);
      const stamp = this.segmentMeta.get(k);
      if (!this.restored.has(k) || !stamp) return false;
      if (stamp.docCount !== docCount || stamp.revisionSum !== rev) return false;
    }
    this.servedFromSegment.add(collection);
    return true;
  }

  /** Rebuild all indexes for a collection after it is loaded into memory. */
  rebuildCollection(collection: string, docs: Document[]): void {
    const list = this.findForCollection(collection);
    if (list.length === 0) return;
    this.buildCount += 1;
    this.servedFromSegment.delete(collection);
    this.rebuilt.add(collection);
    for (const idx of list) idx.build(docs);
  }

  async flushCollection(
    collection: string,
    stats: { docCount: number; revisionSum: number },
  ): Promise<void> {
    if (!this.persistSegments) return;
    const list = this.findForCollection(collection);
    if (list.length === 0) return;
    for (const idx of list) {
      await this.writeSegment(idx, stats);
    }
    await this.save();
  }

  async save(): Promise<void> {
    const segments: Record<string, SegmentStamp> = {};
    for (const [k, stamp] of this.segmentMeta) segments[k] = stamp;
    const data: IndexesFile = {
      indexes: Array.from(this.indexes.values()).map((i) => i.meta),
      segments,
    };
    await writeFileAtomic(
      this.file(),
      JSON.stringify(data, null, 2),
      this.syncMode,
    );
  }

  list(): IndexMeta[] {
    return Array.from(this.indexes.values()).map((i) => ({ ...i.meta }));
  }

  get(collection: string, field: string): Index | undefined {
    return this.indexes.get(this.key(collection, field));
  }

  findForCollection(collection: string): Index[] {
    return Array.from(this.indexes.values()).filter(
      (i) => i.meta.collection === collection,
    );
  }

  diagnostics(): IndexDiagnostics {
    return {
      persist: this.persistSegments,
      buildCount: this.buildCount,
      restored: [...this.restored],
      servedFromSegment: [...this.servedFromSegment],
      rebuilt: [...this.rebuilt],
      corrupt: this.corrupt.map((c) => ({ ...c })),
      segmentCount: this.segmentMeta.size,
      merged: [...this.segmentMeta.entries()]
        .filter(([, stamp]) => stamp.merged === true)
        .map(([key]) => key),
      parts: Object.fromEntries(
        [...this.segmentMeta.entries()].map(([key, stamp]) => [key, stamp.parts ?? 1]),
      ),
    };
  }

  /**
   * Merge delta segment parts into one checksummed segment.
   * Query postings stay in memory and are rewritten; this does not drop the index.
   */
  async compact(
    collection: string | undefined,
    statsFor: (name: string) => { docCount: number; revisionSum: number },
  ): Promise<{ indexes: string[]; partsMerged: number }> {
    const indexes: string[] = [];
    let partsMerged = 0;
    for (const idx of this.indexes.values()) {
      if (collection && idx.meta.collection !== collection) continue;
      const k = this.key(idx.meta.collection, idx.meta.field);
      const stats = statsFor(idx.meta.collection);
      const parts = this.segmentMeta.get(k)?.parts ?? 1;
      partsMerged += parts;
      const packed = gzipSync(
        Buffer.from(JSON.stringify(idx.exportEntries()), 'utf8'),
      ).toString('base64');
      const body: SegmentBody = {
        format: INDEX_SEGMENT_FORMAT,
        meta: idx.meta,
        docCount: stats.docCount,
        revisionSum: stats.revisionSum,
        snapshot: { entries: [] },
        merged: true,
        algorithm: 'gzip',
        packed,
      };
      const checksum = checksumBody(body);
      await writeFileAtomic(
        this.segmentPath(idx.meta.collection, idx.meta.field),
        JSON.stringify({ checksum, body }),
        this.syncMode,
      );
      for (let n = 2; n <= parts; n++) {
        await fs.rm(this.partPath(idx.meta.collection, idx.meta.field, n), {
          force: true,
        });
      }
      this.segmentMeta.set(k, {
        checksum,
        docCount: stats.docCount,
        revisionSum: stats.revisionSum,
        parts: 1,
        merged: true,
      });
      this.restored.add(k);
      indexes.push(k);
    }
    await this.save();
    return { indexes, partsMerged };
  }

  async createIndex(
    collection: string,
    field: string,
    type: IndexType,
    docs: Document[],
    opts?: CreateIndexOptions,
  ): Promise<IndexMeta> {
    let fields = opts?.fields;
    let resolvedField = field;

    if (type === 'composite') {
      fields =
        fields && fields.length > 0
          ? fields
          : field.split(/[+,\s]+/).filter(Boolean);
      if (!fields || fields.length < 2) {
        throw new JSONSQLiteError(
          ErrorCode.INVALID_CONFIG,
          'Composite index requires at least 2 fields (--fields a,b)',
        );
      }
      resolvedField = fields.join('+');
    }

    const k = this.key(collection, resolvedField);
    if (this.indexes.has(k)) {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        `Index already exists: ${k}`,
      );
    }
    const meta: IndexMeta = {
      collection,
      field: resolvedField,
      type,
      createdAt: Date.now(),
      ...(fields && fields.length > 0 ? { fields } : {}),
    };
    const idx = this.createInstance(meta);
    idx.build(docs);
    this.indexes.set(k, idx);
    await this.writeSegment(idx, {
      docCount: docs.length,
      revisionSum: revisionSum(docs),
    });
    await this.save();
    return { ...meta };
  }

  async dropIndex(collection: string, field: string): Promise<void> {
    const k = this.key(collection, field);
    if (!this.indexes.delete(k)) {
      throw new JSONSQLiteError(
        ErrorCode.DOCUMENT_NOT_FOUND,
        `Index not found: ${k}`,
      );
    }
    await this.removeSegment(collection, field, k);
    await this.save();
  }

  async dropAllForCollection(collection: string): Promise<void> {
    let changed = false;
    for (const [k, idx] of [...this.indexes.entries()]) {
      if (idx.meta.collection === collection) {
        this.indexes.delete(k);
        await this.removeSegment(collection, idx.meta.field, k);
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  onInsert(collection: string, doc: Document): void {
    for (const idx of this.findForCollection(collection)) idx.insert(doc);
  }

  onUpdate(collection: string, prev: Document | undefined, next: Document): void {
    for (const idx of this.findForCollection(collection)) idx.update(prev, next);
  }

  onDelete(collection: string, doc: Document): void {
    for (const idx of this.findForCollection(collection)) idx.remove(doc);
  }

  private partPath(collection: string, field: string, part: number): string {
    return `${this.segmentPath(collection, field)}.p${part}`;
  }

  private async tryRestore(k: string, idx: Index): Promise<void> {
    const hint = this.segmentMeta.get(k);
    const file =
      hint && (hint.parts ?? 1) > 1 && hint.merged !== true
        ? this.partPath(idx.meta.collection, idx.meta.field, hint.parts ?? 1)
        : this.segmentPath(idx.meta.collection, idx.meta.field);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.noteCorrupt(k, err instanceof Error ? err.message : String(err));
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { checksum?: string; body?: SegmentBody };
      if (!parsed.body || typeof parsed.checksum !== 'string') {
        this.noteCorrupt(k, 'segment missing checksum or body');
        return;
      }
      const checksum = checksumBody(parsed.body);
      if (checksum !== parsed.checksum) {
        this.noteCorrupt(k, 'checksum mismatch');
        return;
      }
      if (parsed.body.format !== INDEX_SEGMENT_FORMAT) {
        this.noteCorrupt(k, `unsupported segment format ${parsed.body.format}`);
        return;
      }
      if (parsed.body.algorithm === 'gzip') {
        if (typeof parsed.body.packed !== 'string') {
          this.noteCorrupt(k, 'merged segment missing packed snapshot');
          return;
        }
        const json = gunzipSync(Buffer.from(parsed.body.packed, 'base64')).toString(
          'utf8',
        );
        parsed.body.snapshot = JSON.parse(json) as SegmentBody['snapshot'];
      }
      idx.importEntries(parsed.body.snapshot);
      const stamp: SegmentStamp = {
        checksum,
        docCount: parsed.body.docCount,
        revisionSum: parsed.body.revisionSum,
        ...(hint?.parts !== undefined || parsed.body.merged
          ? { parts: parsed.body.merged ? 1 : hint?.parts ?? 1 }
          : {}),
        ...(parsed.body.merged ? { merged: true } : {}),
      };
      this.segmentMeta.set(k, stamp);
      this.restored.add(k);
    } catch (err) {
      this.noteCorrupt(k, err instanceof Error ? err.message : String(err));
    }
  }

  private async writeSegment(
    idx: Index,
    stats: { docCount: number; revisionSum: number },
  ): Promise<void> {
    if (!this.persistSegments) return;
    const k = this.key(idx.meta.collection, idx.meta.field);
    const existing = this.segmentMeta.get(k);
    if (
      existing?.merged &&
      existing.docCount === stats.docCount &&
      existing.revisionSum === stats.revisionSum
    ) {
      return;
    }
    const body: SegmentBody = {
      format: INDEX_SEGMENT_FORMAT,
      meta: idx.meta,
      docCount: stats.docCount,
      revisionSum: stats.revisionSum,
      snapshot: idx.exportEntries(),
    };
    const checksum = checksumBody(body);
    const appendPart =
      this.deltaSegments && existing !== undefined && existing.merged !== true;
    const parts = appendPart ? (existing?.parts ?? 1) + 1 : 1;
    const file = appendPart
      ? this.partPath(idx.meta.collection, idx.meta.field, parts)
      : this.segmentPath(idx.meta.collection, idx.meta.field);
    await writeFileAtomic(file, JSON.stringify({ checksum, body }), this.syncMode);
    this.segmentMeta.set(k, {
      checksum,
      docCount: body.docCount,
      revisionSum: body.revisionSum,
      ...(this.deltaSegments ? { parts, merged: false } : {}),
    });
    this.restored.add(k);
    this.corrupt = this.corrupt.filter((c) => c.key !== k);
  }

  private async removeSegment(
    collection: string,
    field: string,
    k: string,
  ): Promise<void> {
    const parts = this.segmentMeta.get(k)?.parts ?? 1;
    this.segmentMeta.delete(k);
    this.restored.delete(k);
    this.corrupt = this.corrupt.filter((c) => c.key !== k);
    await fs.rm(this.segmentPath(collection, field), { force: true });
    for (let n = 2; n <= parts; n++) {
      await fs.rm(this.partPath(collection, field, n), { force: true });
    }
  }

  private noteCorrupt(k: string, reason: string): void {
    if (!this.corrupt.some((c) => c.key === k)) {
      this.corrupt.push({ key: k, reason });
    }
  }

  private createInstance(meta: IndexMeta): Index {
    switch (meta.type) {
      case 'object':
        return new ObjectIndex(meta);
      case 'tree':
        return new TreeIndex(meta);
      case 'inverted':
        return new InvertedIndex(meta, this.tokenizeFn ?? tokenize);
      case 'composite':
        return new CompositeIndex(meta);
      case 'geo':
        return new GeoIndex(meta);
      default:
        throw new JSONSQLiteError(
          ErrorCode.INVALID_CONFIG,
          `Unknown index type: ${meta.type as string}`,
        );
    }
  }
}
