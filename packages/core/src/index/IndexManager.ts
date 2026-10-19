import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document } from '../types/index.js';
import { ObjectIndex } from './ObjectIndex.js';
import { TreeIndex } from './TreeIndex.js';
import { InvertedIndex } from './InvertedIndex.js';
import type { Index, IndexMeta, IndexType } from './types.js';

interface IndexesFile {
  indexes: IndexMeta[];
}

export class IndexManager {
  private readonly indexes = new Map<string, Index>();

  constructor(private readonly storagePath: string) {}

  private key(collection: string, field: string): string {
    return `${collection}:${field}`;
  }

  private file(): string {
    return path.join(this.storagePath, 'meta', 'indexes.json');
  }

  async load(getDocs: (collection: string) => Document[]): Promise<void> {
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
      idx.build(getDocs(meta.collection));
      this.indexes.set(this.key(meta.collection, meta.field), idx);
    }
  }

  async save(): Promise<void> {
    const data: IndexesFile = {
      indexes: Array.from(this.indexes.values()).map((i) => i.meta),
    };
    await fs.mkdir(path.dirname(this.file()), { recursive: true });
    await fs.writeFile(this.file(), JSON.stringify(data, null, 2), 'utf8');
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

  async createIndex(
    collection: string,
    field: string,
    type: IndexType,
    docs: Document[],
  ): Promise<IndexMeta> {
    const k = this.key(collection, field);
    if (this.indexes.has(k)) {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        `Index already exists: ${k}`,
      );
    }
    const meta: IndexMeta = {
      collection,
      field,
      type,
      createdAt: Date.now(),
    };
    const idx = this.createInstance(meta);
    idx.build(docs);
    this.indexes.set(k, idx);
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
    await this.save();
  }

  async dropAllForCollection(collection: string): Promise<void> {
    let changed = false;
    for (const [k, idx] of [...this.indexes.entries()]) {
      if (idx.meta.collection === collection) {
        this.indexes.delete(k);
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

  private createInstance(meta: IndexMeta): Index {
    switch (meta.type) {
      case 'object':
        return new ObjectIndex(meta);
      case 'tree':
        return new TreeIndex(meta);
      case 'inverted':
        return new InvertedIndex(meta);
      default:
        throw new JSONSQLiteError(
          ErrorCode.INVALID_CONFIG,
          `Unknown index type: ${meta.type as string}`,
        );
    }
  }
}
