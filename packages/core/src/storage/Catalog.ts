import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { CollectionInfo, FieldDef, SyncMode } from '../types/index.js';
import { catalogFile, collectionDir } from '../utils/path.js';
import { writeFileAtomic } from '../utils/fsDurable.js';

/**
 * Current on-disk catalog format.
 * 1 = 1.x monolithic data.jsonl (open refuses; use migrate).
 * 2 = paged documents (pages.json + pages/pNNNNNN.jsonl).
 */
export const FORMAT_VERSION = 2;

interface CatalogCollection {
  name: string;
  createdAt: number;
  documentCount: number;
  fields?: FieldDef[];
}

interface CatalogData {
  formatVersion: number;
  /** When true, collection JSONL + WAL lines are AES-GCM envelopes. */
  encryption?: boolean;
  collections: Record<string, CatalogCollection>;
}

type Migrator = (data: CatalogData) => CatalogData;

/** Migrate catalog from version N → N+1. Add entries when bumping FORMAT_VERSION. */
const MIGRATIONS: Record<number, Migrator> = {
  // Example: 1: (data) => ({ ...data, formatVersion: 2, ... }),
};

export class Catalog {
  private data: CatalogData = {
    formatVersion: FORMAT_VERSION,
    collections: {},
  };

  constructor(
    private readonly storagePath: string,
    private readonly syncMode: SyncMode = 'normal',
  ) {}

  get formatVersion(): number {
    return this.data.formatVersion;
  }

  get encryption(): boolean {
    return this.data.encryption === true;
  }

  async setEncryption(enabled: boolean): Promise<void> {
    if (enabled) this.data.encryption = true;
    else delete this.data.encryption;
    await this.save();
  }

  async load(): Promise<void> {
    const file = catalogFile(this.storagePath);
    try {
      const raw = await fs.readFile(file, 'utf8');
      let data = JSON.parse(raw) as CatalogData;
      if (typeof data.formatVersion !== 'number') {
        throw new JSONSQLiteError(
          ErrorCode.INTERNAL,
          'catalog.json missing formatVersion',
        );
      }
      if (data.formatVersion < FORMAT_VERSION) {
        throw new JSONSQLiteError(
          ErrorCode.MIGRATION_REQUIRED,
          `formatVersion ${data.formatVersion} cannot be opened by this release; run \`jsonsqlite migrate --from <db> --to <new> --yes\``,
        );
      }
      data = migrateCatalog(data);
      this.data = data;
      if (this.data.formatVersion !== FORMAT_VERSION) {
        throw new JSONSQLiteError(
          ErrorCode.INTERNAL,
          `Unsupported formatVersion: ${this.data.formatVersion} (code=${FORMAT_VERSION})`,
        );
      }
      // Persist if migrations advanced the file
      const onDisk = JSON.parse(raw) as CatalogData;
      if (onDisk.formatVersion !== this.data.formatVersion) {
        await this.save();
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
    await writeFileAtomic(
      file,
      JSON.stringify(this.data, null, 2),
      this.syncMode,
    );
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

export function migrateCatalog(data: CatalogData): CatalogData {
  let cur = { ...data, collections: { ...data.collections } };
  while (cur.formatVersion < FORMAT_VERSION) {
    const step = MIGRATIONS[cur.formatVersion];
    if (!step) {
      throw new JSONSQLiteError(
        ErrorCode.INTERNAL,
        `No migration from formatVersion ${cur.formatVersion} to ${FORMAT_VERSION}`,
      );
    }
    cur = step(cur);
  }
  if (cur.formatVersion > FORMAT_VERSION) {
    throw new JSONSQLiteError(
      ErrorCode.INTERNAL,
      `Catalog formatVersion ${cur.formatVersion} is newer than this binary (${FORMAT_VERSION})`,
    );
  }
  return cur;
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
