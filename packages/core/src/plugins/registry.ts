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
      stub: true,
      availableIn: '3.3',
      registered: false,
      summary:
        '可调用的向量索引 stub。search 会记一次调用并返回空命中。可用实现在 3.3，本版不能做向量检索。',
    },
    {
      kind: 'storage',
      name: 's3',
      version: '0.0.1',
      stub: true,
      availableIn: '3.4',
      registered: false,
      summary:
        '可调用的 S3 冷存储 stub。putCold 会记一次调用，不会上传对象。可用实现在 3.4，3.1 不会实际上传。',
    },
  ];
}

export function builtinPluginInfo(name: string): BuiltinPluginInfo | null {
  return builtinPluginCatalog().find((item) => item.name === name) ?? null;
}

export interface VectorSearchResult {
  hits: string[];
  stub: true;
  availableIn: '3.3';
  called: true;
  collection: string;
}

export function createVectorStub(): EnginePlugin & { calls: number } {
  const stub = {
    kind: 'index' as const,
    name: 'vector',
    version: '0.0.1',
    stub: true,
    availableIn: '3.3',
    calls: 0,
    search(ctx: { collection: string; vector: number[] }): VectorSearchResult {
      stub.calls += 1;
      return {
        hits: [],
        stub: true,
        availableIn: '3.3',
        called: true,
        collection: ctx.collection,
      };
    },
  };
  return stub;
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
