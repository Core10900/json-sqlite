import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SyncMode } from '../types/index.js';
import type { Document } from '../types/index.js';
import { writeFileAtomic } from '../utils/fsDurable.js';
import type { StorageMode } from './advise.js';
import { decodeColumn, encodeColumn } from './columnCodec.js';

const SYSTEM = new Set(['_id', '_version', '_createdAt', '_updatedAt']);

export interface ColumnManifest {
  ready: boolean;
  generation: number;
  fields: string[];
  docCount: number;
  revisionSum: number;
  checksum: string;
  /** Per-file sha256 of the bytes that were written. Absent on 2.3 manifests. */
  files?: Record<string, string>;
}

export type { StorageMode };

export interface ColumnStoreStatus {
  enabled: boolean;
  ready: boolean;
  building: boolean;
  generation: number;
  fields: string[];
  docCount: number;
  fileReads: number;
  lastFileReads: number;
}

export interface ColumnRead {
  docs: Document[];
  fileReads: number;
}

interface RowKey {
  _id: string;
  _version: number;
  _createdAt: number;
  _updatedAt: number;
}

/**
 * Derived column files for one table. The WAL and page files stay the
 * commit source. A manifest with ready:false, or a checksum mismatch,
 * is ignored and the caller reads documents instead.
 */
export class ColumnStore {
  private readonly enabled = new Set<string>();
  private readonly building = new Set<string>();
  private readonly ready = new Map<string, ColumnManifest>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly generation = new Map<string, number>();
  private readonly hybridFields = new Map<string, string[]>();
  private readonly modes = new Map<string, StorageMode>();
  fileReads = 0;
  lastFileReads = 0;

  constructor(
    private readonly root: string,
    private readonly syncMode: SyncMode,
  ) {}

  isEnabled(name: string): boolean {
    return this.enabled.has(name);
  }

  enabledNames(): string[] {
    return [...this.enabled];
  }

  enable(name: string): void {
    this.enabled.add(name);
    if (!this.modes.has(name) || this.modes.get(name) === 'document') {
      this.modes.set(name, 'columnar');
    }
  }

  /**
   * Hot fields are written as columns. Other fields stay on the document
   * pages. The mode is recorded only; this does not run from a suggestion.
   */
  enableHybrid(name: string, fields: string[]): void {
    this.enabled.add(name);
    this.hybridFields.set(name, [...fields]);
    this.modes.set(name, 'hybrid');
  }

  mode(name: string): StorageMode {
    return this.modes.get(name) ?? 'document';
  }

  hybridFieldList(name: string): string[] | null {
    const fields = this.hybridFields.get(name);
    return fields ? [...fields] : null;
  }

  status(name: string): ColumnStoreStatus {
    const manifest = this.ready.get(name);
    return {
      enabled: this.enabled.has(name),
      ready: Boolean(manifest),
      building: this.building.has(name),
      generation: manifest?.generation ?? this.generation.get(name) ?? 0,
      fields: manifest?.fields ?? [],
      docCount: manifest?.docCount ?? 0,
      fileReads: this.fileReads,
      lastFileReads: this.lastFileReads,
    };
  }

  resetFileReads(): void {
    this.fileReads = 0;
    this.lastFileReads = 0;
  }

  async persistEnabled(): Promise<void> {
    const hybrid: Record<string, string[]> = {};
    for (const [name, fields] of this.hybridFields) hybrid[name] = fields;
    const modes: Record<string, StorageMode> = {};
    for (const [name, mode] of this.modes) modes[name] = mode;
    await writeFileAtomic(
      this.enabledFile(),
      JSON.stringify({ collections: [...this.enabled], hybrid, modes }, null, 2),
      this.syncMode,
    );
  }

  async loadEnabled(): Promise<void> {
    try {
      const raw = await fs.readFile(this.enabledFile(), 'utf8');
      const parsed = JSON.parse(raw) as {
        collections?: string[];
        hybrid?: Record<string, string[]>;
        modes?: Record<string, StorageMode>;
      };
      for (const name of parsed.collections ?? []) this.enabled.add(name);
      for (const [name, fields] of Object.entries(parsed.hybrid ?? {})) {
        this.hybridFields.set(name, [...fields]);
      }
      for (const [name, mode] of Object.entries(parsed.modes ?? {})) {
        this.modes.set(name, mode);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /**
   * Trust an on-disk manifest only when it is marked ready and its
   * checksum and revision match the loaded documents.
   */
  async restore(name: string, stats: { docCount: number; revisionSum: number }): Promise<boolean> {
    if (!this.enabled.has(name)) return false;
    const manifest = await this.readManifest(name);
    if (!manifest?.ready) {
      this.ready.delete(name);
      return false;
    }
    if (
      manifest.docCount !== stats.docCount ||
      manifest.revisionSum !== stats.revisionSum
    ) {
      this.ready.delete(name);
      return false;
    }
    const checksum = await this.checksumFiles(name, manifest.fields);
    if (!checksum || checksum !== manifest.checksum) {
      this.ready.delete(name);
      return false;
    }
    this.ready.set(name, manifest);
    this.generation.set(name, manifest.generation);
    return true;
  }

  scheduleRebuild(name: string, load: () => Promise<Document[]>): Promise<void> {
    const token = (this.generation.get(name) ?? 0) + 1;
    this.generation.set(name, token);
    this.ready.delete(name);
    this.building.add(name);
    const job = this.rebuild(name, token, load).finally(() => {
      if (this.jobs.get(name) === job) this.jobs.delete(name);
    });
    this.jobs.set(name, job);
    return job;
  }

  async whenIdle(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (job) await job;
  }

  async whenAllIdle(): Promise<void> {
    await Promise.all([...this.jobs.values()]);
  }

  /**
   * Read only the requested user fields plus the row key.
   * Returns null when the column store is not ready or a file is missing.
   * That null is a fallback, not an error.
   */
  async read(name: string, fields: string[] | null): Promise<ColumnRead | null> {
    const manifest = this.ready.get(name);
    if (!manifest || this.building.has(name)) return null;
    const userFields = fields ?? manifest.fields;
    for (const field of userFields) {
      if (!manifest.fields.includes(field)) return null;
    }
    try {
      const rowRaw = await this.readFileCounted(this.rowKeyFile(name));
      if (!this.hashMatches(manifest, 'rowkey', rowRaw)) {
        this.ready.delete(name);
        return null;
      }
      const keys = JSON.parse(rowRaw) as RowKey[];
      const columns = new Map<string, unknown[]>();
      for (const field of userFields) {
        const raw = await this.readFileCounted(this.fieldFile(name, field));
        if (!this.hashMatches(manifest, field, raw)) {
          this.ready.delete(name);
          return null;
        }
        columns.set(field, decodeColumn(raw));
      }
      this.lastFileReads = 1 + userFields.length;
      const docs: Document[] = keys.map((key, i) => {
        const doc: Document = {
          _id: key._id,
          _version: key._version,
          _createdAt: key._createdAt,
          _updatedAt: key._updatedAt,
        };
        for (const field of userFields) {
          const values = columns.get(field);
          doc[field] = values ? values[i] : undefined;
        }
        return doc;
      });
      return { docs, fileReads: this.lastFileReads };
    } catch {
      this.ready.delete(name);
      return null;
    }
  }

  private async rebuild(
    name: string,
    token: number,
    load: () => Promise<Document[]>,
  ): Promise<void> {
    try {
      await this.writeManifest(name, {
        ready: false,
        generation: token,
        fields: [],
        docCount: 0,
        revisionSum: 0,
        checksum: '',
      });
      const docs = await load();
      if (this.generation.get(name) !== token) return;
      const hybrid = this.hybridFields.get(name);
      const fields = hybrid ? [...hybrid] : collectFields(docs);
      const keys: RowKey[] = docs.map((doc) => ({
        _id: doc._id,
        _version: doc._version,
        _createdAt: doc._createdAt,
        _updatedAt: doc._updatedAt,
      }));
      const files: Record<string, string> = {};
      await fs.mkdir(this.dir(name), { recursive: true });
      const rowBody = JSON.stringify(keys);
      files.rowkey = sha256(rowBody);
      await writeFileAtomic(this.rowKeyFile(name), rowBody, this.syncMode);
      for (const field of fields) {
        const values = docs.map((doc) => doc[field]);
        const body = encodeColumn(values);
        files[field] = sha256(body);
        await writeFileAtomic(this.fieldFile(name, field), body, this.syncMode);
      }
      if (this.generation.get(name) !== token) return;
      const checksum = await this.checksumFiles(name, fields);
      let revisionSum = 0;
      for (const doc of docs) revisionSum += doc._version;
      const manifest: ColumnManifest = {
        ready: true,
        generation: token,
        fields,
        docCount: docs.length,
        revisionSum,
        checksum: checksum ?? '',
        files,
      };
      await this.writeManifest(name, manifest);
      if (this.generation.get(name) !== token) return;
      this.ready.set(name, manifest);
    } catch {
      if (this.generation.get(name) === token) this.ready.delete(name);
    } finally {
      if (this.generation.get(name) === token) this.building.delete(name);
    }
  }

  private hashMatches(manifest: ColumnManifest, name: string, body: string): boolean {
    const expected = manifest.files?.[name];
    if (!expected) return true;
    return sha256(body) === expected;
  }

  private async readFileCounted(file: string): Promise<string> {
    const raw = await fs.readFile(file, 'utf8');
    this.fileReads += 1;
    return raw;
  }

  private async checksumFiles(name: string, fields: string[]): Promise<string | null> {
    try {
      const hash = createHash('sha256');
      hash.update(await fs.readFile(this.rowKeyFile(name)));
      for (const field of [...fields].sort()) {
        hash.update(field);
        hash.update(await fs.readFile(this.fieldFile(name, field)));
      }
      return hash.digest('hex');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  private async readManifest(name: string): Promise<ColumnManifest | null> {
    try {
      const raw = await fs.readFile(this.manifestFile(name), 'utf8');
      return JSON.parse(raw) as ColumnManifest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  private async writeManifest(name: string, manifest: ColumnManifest): Promise<void> {
    await fs.mkdir(this.dir(name), { recursive: true });
    await writeFileAtomic(
      this.manifestFile(name),
      JSON.stringify(manifest, null, 2),
      this.syncMode,
    );
  }

  private enabledFile(): string {
    return path.join(this.root, 'meta', 'column-collections.json');
  }

  private dir(name: string): string {
    return path.join(this.root, 'collections', name, 'columns');
  }

  private manifestFile(name: string): string {
    return path.join(this.dir(name), 'manifest.json');
  }

  private rowKeyFile(name: string): string {
    return path.join(this.dir(name), 'rowkey.json');
  }

  private fieldFile(name: string, field: string): string {
    return path.join(this.dir(name), `${encodeURIComponent(field)}.json`);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function collectFields(docs: Document[]): string[] {
  const fields = new Set<string>();
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      if (!SYSTEM.has(key)) fields.add(key);
    }
  }
  return [...fields].sort();
}

export function columnManifestPath(root: string, name: string): string {
  return path.join(root, 'collections', name, 'columns', 'manifest.json');
}
