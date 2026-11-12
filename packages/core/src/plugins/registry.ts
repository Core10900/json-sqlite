import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document, SyncMode } from '../types/index.js';
import { writeFileAtomic } from '../utils/fsDurable.js';

export type PluginKind =
  | 'index'
  | 'storage'
  | 'compression'
  | 'backup'
  | 'queryLanguage';

export const PLUGIN_KINDS: readonly PluginKind[] = [
  'index',
  'storage',
  'compression',
  'backup',
  'queryLanguage',
];

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface PluginManifest {
  kind: PluginKind;
  name: string;
  version: string;
  stub?: boolean;
  /** Usable implementation is not in this release. */
  availableIn?: string;
}

export interface EnginePlugin extends PluginManifest {
  onQuery?(ctx: { collection: string }): void;
  putCold?(collection: string, doc: Document): Promise<void> | void;
  getCold?(
    collection: string,
    id: string,
  ): Promise<Document | null | undefined> | Document | null | undefined;
  compress?(payload: string): string;
  decompress?(payload: string): string;
  backup?(ctx: { storagePath: string }): Promise<void> | void;
  search?(ctx: { collection: string; vector: number[] }): unknown;
  /** queryLanguage only. Must return a JSON query object. */
  parse?(input: unknown): unknown;
}

export interface PluginErrorRecord {
  name: string;
  kind: PluginKind;
  message: string;
  at: number;
}

export interface BuiltinPluginInfo extends PluginManifest {
  registered: boolean;
  summary: string;
}

export function assertPluginManifest(input: PluginManifest): void {
  if (!PLUGIN_KINDS.includes(input.kind)) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `Plugin kind "${String(input.kind)}" is not one of ${PLUGIN_KINDS.join(', ')}`,
    );
  }
  if (!NAME_RE.test(input.name)) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `Plugin name "${input.name}" must match ${NAME_RE.source}`,
    );
  }
  if (!VERSION_RE.test(input.version)) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `Plugin version "${input.version}" must be semver (major.minor.patch)`,
    );
  }
}

export function builtinPluginCatalog(): BuiltinPluginInfo[] {
  return [
    {
      kind: 'index',
      name: 'vector',
      version: '0.0.1',
      stub: false,
      availableIn: '3.4',
      registered: false,
      summary:
        '内存向量索引（3.4）。createVectorPlugin() 提供 upsertVector + cosine search；createVectorStub() 仍返回空命中。',
    },
    {
      kind: 'storage',
      name: 's3',
      version: '0.0.1',
      stub: true,
      availableIn: '3.4',
      registered: false,
      summary:
        '可调用的 S3 冷存储 stub。putCold 会记一次调用，不会上传对象。可用文件系统示例通过 createS3Plugin({ rootDir }) 注册（stub:false，3.4）。',
    },
  ];
}

export function builtinPluginInfo(name: string): BuiltinPluginInfo | null {
  return builtinPluginCatalog().find((item) => item.name === name) ?? null;
}

export interface VectorSearchResult {
  hits: string[];
  stub: true;
  availableIn: '3.4';
  called: true;
  collection: string;
}

export function createVectorStub(): EnginePlugin & { calls: number } {
  const stub = {
    kind: 'index' as const,
    name: 'vector',
    version: '0.0.1',
    stub: true,
    availableIn: '3.4',
    calls: 0,
    search(ctx: { collection: string; vector: number[] }): VectorSearchResult {
      stub.calls += 1;
      return {
        hits: [],
        stub: true,
        availableIn: '3.4',
        called: true,
        collection: ctx.collection,
      };
    },
  };
  return stub;
}

export interface VectorHit {
  id: string;
  score: number;
}

export interface VectorPluginSearchResult {
  hits: VectorHit[];
  stub: false;
  availableIn: '3.4';
  collection: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * In-memory vector index plugin (3.4).
 * Call `upsertVector` to index; `search` returns cosine-ranked hits.
 */
export function createVectorPlugin(): EnginePlugin & {
  calls: number;
  upsertVector(collection: string, id: string, vector: number[]): void;
  clearVectors(collection?: string): void;
} {
  const index = new Map<string, Map<string, number[]>>();
  const plugin = {
    kind: 'index' as const,
    name: 'vector',
    version: '0.1.0',
    stub: false,
    availableIn: '3.4' as const,
    calls: 0,
    upsertVector(collection: string, id: string, vector: number[]): void {
      let bucket = index.get(collection);
      if (!bucket) {
        bucket = new Map();
        index.set(collection, bucket);
      }
      bucket.set(id, vector.slice());
    },
    clearVectors(collection?: string): void {
      if (collection) index.delete(collection);
      else index.clear();
    },
    search(ctx: {
      collection: string;
      vector: number[];
      limit?: number;
    }): VectorPluginSearchResult {
      plugin.calls += 1;
      const bucket = index.get(ctx.collection);
      const hits: VectorHit[] = [];
      if (bucket) {
        for (const [id, vec] of bucket) {
          hits.push({ id, score: cosineSimilarity(ctx.vector, vec) });
        }
        hits.sort((a, b) => b.score - a.score);
      }
      const limit = ctx.limit ?? hits.length;
      return {
        hits: hits.slice(0, Math.max(0, limit)),
        stub: false,
        availableIn: '3.4',
        collection: ctx.collection,
      };
    },
  };
  return plugin;
}

export function createS3Stub(): EnginePlugin & { calls: number } {
  const stub = {
    kind: 'storage' as const,
    name: 's3',
    version: '0.0.1',
    stub: true,
    availableIn: '3.4',
    calls: 0,
    putCold(_collection: string, _doc: Document): void {
      stub.calls += 1;
    },
    getCold(): null {
      stub.calls += 1;
      return null;
    },
  };
  return stub;
}

/**
 * Filesystem-backed cold object store that simulates S3 (V34-S3-1).
 * Objects live at `{rootDir}/{collection}/{id}.json`.
 * Not a stub — `stub: false`, `availableIn: '3.4'`.
 */
export function createS3Plugin(opts: { rootDir: string }): EnginePlugin {
  const rootDir = path.resolve(opts.rootDir);
  return {
    kind: 'storage',
    name: 's3',
    version: '0.1.0',
    stub: false,
    availableIn: '3.4',
    async putCold(collection: string, doc: Document): Promise<void> {
      const dir = path.join(rootDir, collection);
      await fs.mkdir(dir, { recursive: true });
      await writeFileAtomic(
        path.join(dir, `${doc._id}.json`),
        JSON.stringify(doc),
        'normal',
      );
    },
    async getCold(
      collection: string,
      id: string,
    ): Promise<Document | null> {
      try {
        const raw = await fs.readFile(
          path.join(rootDir, collection, `${id}.json`),
          'utf8',
        );
        return JSON.parse(raw) as Document;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

interface StoredManifestFile {
  plugins: PluginManifest[];
}

/**
 * In-process plugin registry. A throwing hook is recorded and does not
 * escape to the caller. Manifests are stored; function bodies are not
 * reloaded from disk.
 */
export class PluginRegistry {
  private readonly plugins: EnginePlugin[] = [];
  private readonly errors: PluginErrorRecord[] = [];

  constructor(
    private readonly root: string,
    private readonly syncMode: SyncMode,
  ) {}

  list(): PluginManifest[] {
    return this.plugins.map((plugin) => ({
      kind: plugin.kind,
      name: plugin.name,
      version: plugin.version,
      ...(plugin.stub ? { stub: true } : {}),
      ...(plugin.availableIn ? { availableIn: plugin.availableIn } : {}),
    }));
  }

  errorsSnapshot(): PluginErrorRecord[] {
    return this.errors.map((err) => ({ ...err }));
  }

  find(name: string, kind?: PluginKind): EnginePlugin | undefined {
    return this.plugins.find(
      (plugin) => plugin.name === name && (kind === undefined || plugin.kind === kind),
    );
  }

  storageHooks(): EnginePlugin[] {
    return this.plugins.filter((plugin) => plugin.kind === 'storage');
  }

  register(plugin: EnginePlugin): void {
    assertPluginManifest(plugin);
    if (this.find(plugin.name, plugin.kind)) {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        `Plugin already registered: ${plugin.kind}:${plugin.name}`,
      );
    }
    this.plugins.push(plugin);
  }

  async persist(): Promise<void> {
    const data: StoredManifestFile = { plugins: this.list() };
    await writeFileAtomic(
      this.file(),
      JSON.stringify(data, null, 2),
      this.syncMode,
    );
  }

  async invokeQuery(collection: string): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.kind !== 'queryLanguage' || !plugin.onQuery) continue;
      await this.isolate(plugin, () => plugin.onQuery!({ collection }));
    }
  }

  async isolate<T>(
    plugin: EnginePlugin,
    fn: () => T | Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.errors.push({
        name: plugin.name,
        kind: plugin.kind,
        message,
        at: Date.now(),
      });
      return { ok: false, error: message };
    }
  }

  private file(): string {
    return path.join(this.root, 'meta', 'plugins.json');
  }

  /** Manifests only. Hooks are not restored from this file. */
  async readManifests(): Promise<PluginManifest[]> {
    try {
      const raw = await fs.readFile(this.file(), 'utf8');
      const parsed = JSON.parse(raw) as StoredManifestFile;
      return parsed.plugins ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }
}
