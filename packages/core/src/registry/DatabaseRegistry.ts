import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { open, type JSONSQLite } from '../engine/JSONSQLite.js';
import type { JSONSQLiteOptions } from '../types/index.js';
import { writeFileAtomic } from '../utils/fsDurable.js';

export interface RegistryEntry {
  name: string;
  storagePath: string;
  options?: Omit<JSONSQLiteOptions, 'storagePath'>;
}

export interface DatabaseRegistryOptions {
  /** Override registry file path. */
  file?: string;
  /**
   * Prefer cwd `.jsonsqlite-registry.json` when it exists (default true).
   * Otherwise use `~/.jsonsqlite/registry.json`.
   */
  preferCwd?: boolean;
}

interface RegistryFile {
  databases: RegistryEntry[];
}

const CWD_FILE = '.jsonsqlite-registry.json';

export function defaultRegistryPath(preferCwd = true): string {
  if (preferCwd) {
    return path.resolve(process.cwd(), CWD_FILE);
  }
  return path.join(os.homedir(), '.jsonsqlite', 'registry.json');
}

async function resolveRegistryFile(
  opts: DatabaseRegistryOptions = {},
): Promise<string> {
  if (opts.file) return path.resolve(opts.file);
  const preferCwd = opts.preferCwd !== false;
  if (preferCwd) {
    const cwdPath = path.resolve(process.cwd(), CWD_FILE);
    try {
      await fs.access(cwdPath);
      return cwdPath;
    } catch {
      /* fall through to home */
    }
  }
  return path.join(os.homedir(), '.jsonsqlite', 'registry.json');
}

/**
 * Multi-database name → storagePath registry.
 * Persists to cwd `.jsonsqlite-registry.json` or `~/.jsonsqlite/registry.json`.
 */
export class DatabaseRegistry {
  private entries = new Map<string, RegistryEntry>();
  private openHandles = new Map<string, JSONSQLite>();
  private filePath: string | null = null;
  private readonly opts: DatabaseRegistryOptions;

  constructor(opts: DatabaseRegistryOptions = {}) {
    this.opts = opts;
  }

  get path(): string | null {
    return this.filePath;
  }

  async load(): Promise<this> {
    this.filePath = await resolveRegistryFile(this.opts);
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      this.entries.clear();
      for (const entry of parsed.databases ?? []) {
        if (entry?.name && entry?.storagePath) {
          this.entries.set(entry.name, {
            name: entry.name,
            storagePath: entry.storagePath,
            ...(entry.options ? { options: entry.options } : {}),
          });
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.entries.clear();
    }
    return this;
  }

  async register(
    name: string,
    storagePath: string,
    options?: Omit<JSONSQLiteOptions, 'storagePath'>,
  ): Promise<void> {
    if (!name || typeof name !== 'string') {
      throw new JSONSQLiteError(ErrorCode.INVALID_CONFIG, 'register() requires a name');
    }
    if (!storagePath || typeof storagePath !== 'string') {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        'register() requires a storagePath',
      );
    }
    await this.ensureLoaded();
    this.entries.set(name, {
      name,
      storagePath: path.resolve(storagePath),
      ...(options ? { options } : {}),
    });
    await this.persist();
  }

  async use(name: string): Promise<JSONSQLite> {
    await this.ensureLoaded();
    const entry = this.entries.get(name);
    if (!entry) {
      throw new JSONSQLiteError(
        ErrorCode.DB_NOT_FOUND,
        `Database "${name}" is not registered`,
      );
    }
    const existing = this.openHandles.get(name);
    if (existing?.isReady) return existing;
    const db = await open({
      ...(entry.options ?? {}),
      storagePath: entry.storagePath,
    });
    this.openHandles.set(name, db);
    return db;
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  async unregister(name: string): Promise<boolean> {
    await this.ensureLoaded();
    if (!this.entries.has(name)) return false;
    const handle = this.openHandles.get(name);
    if (handle) {
      this.openHandles.delete(name);
      if (handle.isReady) await handle.close({ flush: true });
    }
    this.entries.delete(name);
    await this.persist();
    return true;
  }

  /** Close all open handles without clearing the registry file. */
  async closeAll(): Promise<void> {
    const handles = [...this.openHandles.entries()];
    this.openHandles.clear();
    for (const [, db] of handles) {
      if (db.isReady) await db.close({ flush: true });
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.filePath) await this.load();
  }

  private async persist(): Promise<void> {
    if (!this.filePath) {
      this.filePath = await resolveRegistryFile(this.opts);
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const data: RegistryFile = { databases: this.list() };
    await writeFileAtomic(this.filePath, JSON.stringify(data, null, 2), 'normal');
  }
}

export async function createDatabaseRegistry(
  opts?: DatabaseRegistryOptions,
): Promise<DatabaseRegistry> {
  const registry = new DatabaseRegistry(opts);
  await registry.load();
  return registry;
}
