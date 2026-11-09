import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveOptions } from './config/defaults.js';
import { ErrorCode, JSONSQLiteError } from './errors.js';
import { Catalog, FORMAT_VERSION } from './storage/Catalog.js';
import { catalogFile } from './utils/path.js';
import type { JSONSQLiteOptions } from './types/index.js';

/** Injected by tsup from package.json at build time. */
declare const __JSONSQLITE_VERSION__: string;

/** Compatibility snapshot for tooling / ops. */
export interface CompatibilityInfo {
  version: string;
  formatVersion: number;
  /**
   * True on an LTS binary. 3.0.0 is not LTS.
   * The recommended single-writer pin remains LTS-2 (2.2). This flag does not switch the default open mode.
   */
  lts: boolean;
  /**
   * Latest LTS line known to this binary. `2.5` means LTS-3.
   * On 3.0.0 this is not the package version. Single-writer users still pin 2.2.
   */
  ltsLine: '2.5';
  /** CLI surface. 3.1.0 keeps the 3.0 commands and adds storage advise. */
  cliSurface: string;
  /** Default open mode. Multi-writer is opt-in and is not this field. */
  writers: 'single';
  features: string[];
}

export interface CreateDatabaseOptions extends JSONSQLiteOptions {
  /** If true, remove existing storagePath and recreate (destructive). */
  force?: boolean;
}

export interface CreateDatabaseResult {
  storagePath: string;
  created: boolean;
  version: string;
}

export interface InitDatabaseResult {
  storagePath: string;
  created: boolean;
  initialized: true;
  version: string;
}

/** Return the published package version string. */
export function getVersion(): string {
  return __JSONSQLITE_VERSION__;
}

/** Compatibility metadata for tooling / ops (version, format, CLI surface). */
export function getCompatibilityInfo(): CompatibilityInfo {
  return {
    version: getVersion(),
    formatVersion: FORMAT_VERSION,
    lts: false,
    ltsLine: '2.5',
    cliSurface: '3.1.0',
    writers: 'single',
    features: [
      'encryption',
      'sql-like-join-count',
      'lazy-collections',
      'rekey',
      'vacuum',
      'doctor-deep',
      'cli-1.5.5',
      'cli-1.7',
      'cli-1.8',
      'cli-2.0',
      'cli-2.1',
      'admin-sse',
      'composite-index',
      'aggregate-unwind-lookup',
      'stream-processor',
      'auto-tune',
      'index-segments',
      'l2-cache',
      'compression',
      'tiering',
      'group-by-count',
      'single-writer',
      'repeatable-read',
      'paged-storage',
      'backup-chain',
      'backup-differential',
      'backup-retention',
      'wal-fail-closed',
      'alerts',
      'audit',
      'auto-repair',
      'regex',
      'predicate-pushdown',
      'lts-2',
      'cli-2.2',
      'column-store',
      'storage-tiers',
      'smart-compression',
      'index-compact',
      'cache-compression',
      'page-prefetch',
      'plugins',
      'vector-stub',
      's3-stub',
      'chunk-query',
      'geo-index',
      'chinese-tokenizer',
      'cli-2.3',
      'multi-writer',
      'savepoint',
      'serializable',
      'deadlock-detection',
      'cli-2.4',
      'lts-3',
      'jsonpath-filter',
      'query-cancel',
      'cost-index',
      'query-profile',
      'sql-group-agg',
      'compile-filters',
      'btree',
      'geo-grid',
      'column-encoding',
      'hybrid-storage',
      'storage-advise',
      'front-coding',
      'tier-compression',
      'stop-words',
    ],
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureSkeleton(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, 'meta'), { recursive: true });
  await fs.mkdir(path.join(root, 'collections'), { recursive: true });
  await fs.mkdir(path.join(root, 'wal'), { recursive: true });
  await fs.mkdir(path.join(root, 'deltas'), { recursive: true });
  await fs.mkdir(path.join(root, 'backups'), { recursive: true });
}

/**
 * Create a new database directory.
 * Fails if a catalog already exists unless `force: true`.
 */
export async function create(
  options: CreateDatabaseOptions,
): Promise<CreateDatabaseResult> {
  const resolved = resolveOptions(options);
  const root = path.resolve(resolved.storagePath);
  const catalogPath = catalogFile(root);
  const exists = await pathExists(catalogPath);

  if (exists && !options.force) {
    throw new JSONSQLiteError(
      ErrorCode.DB_EXISTS,
      `Database already exists at ${root}. Use force: true or \`jsonsqlite create --force\` to recreate.`,
    );
  }

  if (exists && options.force) {
    await fs.rm(root, { recursive: true, force: true });
  }

  await ensureSkeleton(root);
  const catalog = new Catalog(root);
  await catalog.save();

  return {
    storagePath: root,
    created: true,
    version: getVersion(),
  };
}

/**
 * Initialize a database directory (idempotent).
 * Creates the DB if missing; otherwise ensures folder skeleton is intact.
 */
export async function init(
  options: JSONSQLiteOptions,
): Promise<InitDatabaseResult> {
  const resolved = resolveOptions(options);
  const root = path.resolve(resolved.storagePath);
  const catalogPath = catalogFile(root);
  const exists = await pathExists(catalogPath);

  if (!exists) {
    const created = await create({ ...options, force: false });
    return {
      storagePath: created.storagePath,
      created: true,
      initialized: true,
      version: created.version,
    };
  }

  await ensureSkeleton(root);
  const catalog = new Catalog(root);
  await catalog.load();
  await catalog.save();

  return {
    storagePath: root,
    created: false,
    initialized: true,
    version: getVersion(),
  };
}
