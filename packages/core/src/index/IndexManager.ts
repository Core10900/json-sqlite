import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document, SyncMode } from '../types/index.js';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { ObjectIndex } from './ObjectIndex.js';
import { TreeIndex } from './TreeIndex.js';
import { InvertedIndex } from './InvertedIndex.js';
import { CompositeIndex } from './CompositeIndex.js';
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
}

export class IndexManager {
  private readonly indexes = new Map<string, Index>();
  private readonly segmentMeta = new Map<string, SegmentStamp>();
  private readonly restored = new Set<string>();
  private readonly servedFromSegment = new Set<string>();
  private readonly rebuilt = new Set<string>();
  private corrupt: { key: string; reason: string }[] = [];
  private buildCount = 0;

  constructor(
    private readonly storagePath: string,
    private readonly syncMode: SyncMode = 'normal',
    private readonly persistSegments = true,
  ) {}

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
      if (this.persistSegments) await this.tryRestore(k, idx);
    }
  }

  /**
   * True when every index on `collection` was restored and its stamp
   * matches the loaded documents. WAL replay always forces a rebuild.
   */
  trustSegment(
    collection: string,
    docs: Document[],
    walReplay: boolean,
  ): boolean {
    if (!this.persistSegments || walReplay) return false;
    const list = this.findForCollection(collection);
    if (list.length === 0) return true;
    const docCount = docs.length;
    const rev = revisionSum(docs);
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

  async flushCollection(collection: string, docs: Document[]): Promise<void> {
    if (!this.persistSegments) return;
    const list = this.findForCollection(collection);
    if (list.length === 0) return;
    for (const idx of list) {
      await this.writeSegment(idx, docs);
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
    };
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
    await this.writeSegment(idx, docs);
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

  private async tryRestore(k: string, idx: Index): Promise<void> {
    const file = this.segmentPath(idx.meta.collection, idx.meta.field);
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
      idx.importEntries(parsed.body.snapshot);
      const stamp: SegmentStamp = {
        checksum,
        docCount: parsed.body.docCount,
        revisionSum: parsed.body.revisionSum,
      };
      this.segmentMeta.set(k, stamp);
      this.restored.add(k);
    } catch (err) {
      this.noteCorrupt(k, err instanceof Error ? err.message : String(err));
    }
  }

  private async writeSegment(idx: Index, docs: Document[]): Promise<void> {
    if (!this.persistSegments) return;
    const k = this.key(idx.meta.collection, idx.meta.field);
    const body: SegmentBody = {
      format: INDEX_SEGMENT_FORMAT,
      meta: idx.meta,
      docCount: docs.length,
      revisionSum: revisionSum(docs),
      snapshot: idx.exportEntries(),
    };
    const checksum = checksumBody(body);
    await writeFileAtomic(
      this.segmentPath(idx.meta.collection, idx.meta.field),
      JSON.stringify({ checksum, body }),
      this.syncMode,
    );
    this.segmentMeta.set(k, {
      checksum,
      docCount: body.docCount,
      revisionSum: body.revisionSum,
    });
    this.restored.add(k);
    this.corrupt = this.corrupt.filter((c) => c.key !== k);
  }

  private async removeSegment(
    collection: string,
    field: string,
    k: string,
  ): Promise<void> {
    this.segmentMeta.delete(k);
    this.restored.delete(k);
    this.corrupt = this.corrupt.filter((c) => c.key !== k);
    await fs.rm(this.segmentPath(collection, field), { force: true });
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
        return new InvertedIndex(meta);
      case 'composite':
        return new CompositeIndex(meta);
      default:
        throw new JSONSQLiteError(
          ErrorCode.INVALID_CONFIG,
          `Unknown index type: ${meta.type as string}`,
        );
    }
  }
}
