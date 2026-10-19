import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { CollectionInfo, FieldDef } from '../types/index.js';
import { catalogFile, collectionDir } from '../utils/path.js';

const FORMAT_VERSION = 1;

interface CatalogCollection {
  name: string;
  createdAt: number;
  documentCount: number;
  fields?: FieldDef[];
}

interface CatalogData {
  formatVersion: number;
  collections: Record<string, CatalogCollection>;
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
    return Object.values(this.data.collections).map((c) => toInfo(c));
  }

  get(name: string): CollectionInfo | undefined {
    const c = this.data.collections[name];
    return c ? toInfo(c) : undefined;
  }

  has(name: string): boolean {
    return name in this.data.collections;
  }

  async create(name: string, fields?: FieldDef[]): Promise<CollectionInfo> {
    if (this.has(name)) {
      throw new JSONSQLiteError(
        ErrorCode.COLLECTION_EXISTS,
        `Collection already exists: ${name}`,
      );
    }
    validateCollectionName(name);
    if (fields) validateFields(fields);
    const info: CatalogCollection = {
      name,
      createdAt: Date.now(),
      documentCount: 0,
      ...(fields && fields.length > 0 ? { fields: [...fields] } : {}),
    };
    this.data.collections[name] = info;
    await fs.mkdir(path.join(collectionDir(this.storagePath, name), 'docs'), {
      recursive: true,
    });
    await fs.mkdir(path.join(this.storagePath, 'wal'), { recursive: true });
    await this.save();
    return toInfo(info);
  }

  async ensure(name: string): Promise<CollectionInfo> {
    if (!this.has(name)) {
      return this.create(name);
    }
    return toInfo(this.data.collections[name]!);
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

  async rename(from: string, to: string): Promise<CollectionInfo> {
    if (!this.has(from)) {
      throw new JSONSQLiteError(
        ErrorCode.COLLECTION_NOT_FOUND,
        `Collection not found: ${from}`,
      );
    }
    if (this.has(to)) {
      throw new JSONSQLiteError(
        ErrorCode.COLLECTION_EXISTS,
        `Collection already exists: ${to}`,
      );
    }
    validateCollectionName(to);
    const prev = this.data.collections[from]!;
    const next: CatalogCollection = { ...prev, name: to };
    delete this.data.collections[from];
    this.data.collections[to] = next;
    await this.save();
    return toInfo(next);
  }

  async setFields(name: string, fields: FieldDef[]): Promise<CollectionInfo> {
    const c = this.data.collections[name];
    if (!c) {
      throw new JSONSQLiteError(
        ErrorCode.COLLECTION_NOT_FOUND,
        `Collection not found: ${name}`,
      );
    }
    validateFields(fields);
    c.fields = fields.length > 0 ? [...fields] : undefined;
    if (c.fields === undefined) delete c.fields;
    await this.save();
    return toInfo(c);
  }

  setDocumentCount(name: string, count: number): void {
    const c = this.data.collections[name];
    if (c) c.documentCount = count;
  }

  getDocumentCount(name: string): number {
    return this.data.collections[name]?.documentCount ?? 0;
  }
}

function toInfo(c: CatalogCollection): CollectionInfo {
  return {
    name: c.name,
    createdAt: c.createdAt,
    documentCount: c.documentCount,
    ...(c.fields ? { fields: [...c.fields] } : {}),
  };
}

export function validateCollectionName(name: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `Invalid collection name: ${name}`,
    );
  }
}

export function validateFields(fields: FieldDef[]): void {
  const seen = new Set<string>();
  for (const f of fields) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.name)) {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        `Invalid field name: ${f.name}`,
      );
    }
    if (seen.has(f.name)) {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        `Duplicate field: ${f.name}`,
      );
    }
    seen.add(f.name);
    const ok = ['string', 'number', 'boolean', 'json', 'any'].includes(f.type);
    if (!ok) {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        `Invalid field type: ${f.type}`,
      );
    }
  }
}
