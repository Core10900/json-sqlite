import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { CollectionInfo } from '../types/index.js';
import { catalogFile, collectionDir } from '../utils/path.js';

const FORMAT_VERSION = 1;

interface CatalogData {
  formatVersion: number;
  collections: Record<
    string,
    {
      name: string;
      createdAt: number;
      documentCount: number;
    }
  >;
}

export class Catalog {
  private data: CatalogData = {
    formatVersion: FORMAT_VERSION,
    collections: {},
  };

  constructor(private readonly storagePath: string) {}

  async load(): Promise<void> {
    const file = catalogFile(this.storagePath);
    try {
      const raw = await fs.readFile(file, 'utf8');
      this.data = JSON.parse(raw) as CatalogData;
      if (this.data.formatVersion !== FORMAT_VERSION) {
        throw new JSONSQLiteError(
          ErrorCode.INTERNAL,
          `Unsupported formatVersion: ${this.data.formatVersion}`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.save();
        return;
      }
      throw err;
    }
  }

  async save(): Promise<void> {
    const file = catalogFile(this.storagePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  list(): CollectionInfo[] {
    return Object.values(this.data.collections).map((c) => ({ ...c }));
  }

  has(name: string): boolean {
    return name in this.data.collections;
  }

  async create(name: string): Promise<CollectionInfo> {
    if (this.has(name)) {
      throw new JSONSQLiteError(
        ErrorCode.COLLECTION_EXISTS,
        `Collection already exists: ${name}`,
      );
    }
    validateCollectionName(name);
    const info = {
      name,
      createdAt: Date.now(),
      documentCount: 0,
    };
    this.data.collections[name] = info;
    await fs.mkdir(path.join(collectionDir(this.storagePath, name), 'docs'), {
      recursive: true,
    });
    await fs.mkdir(path.join(this.storagePath, 'wal'), { recursive: true });
    await this.save();
    return { ...info };
  }

  async ensure(name: string): Promise<CollectionInfo> {
    if (!this.has(name)) {
      return this.create(name);
    }
    return { ...this.data.collections[name]! };
  }

  async drop(name: string): Promise<void> {
    if (!this.has(name)) {
      throw new JSONSQLiteError(
        ErrorCode.COLLECTION_NOT_FOUND,
        `Collection not found: ${name}`,
      );
    }
    delete this.data.collections[name];
    await this.save();
  }

  setDocumentCount(name: string, count: number): void {
    const c = this.data.collections[name];
    if (c) c.documentCount = count;
  }

  getDocumentCount(name: string): number {
    return this.data.collections[name]?.documentCount ?? 0;
  }
}

function validateCollectionName(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `Invalid collection name: ${name}`,
    );
  }
}
