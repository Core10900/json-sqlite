import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveOptions } from './config/defaults.js';
import { ErrorCode, JSONSQLiteError } from './errors.js';
import { Catalog, FORMAT_VERSION } from './storage/Catalog.js';
import { catalogFile } from './utils/path.js';
import type { JSONSQLiteOptions } from './types/index.js';

/** Injected by tsup from package.json at build time. */
declare const __JSONSQLITE_VERSION__: string;

/** LTS compatibility snapshot (frozen for 1.6.x). */
export interface CompatibilityInfo {
  version: string;
  formatVersion: number;
  /** Always true on the 1.6 LTS line. */
  lts: true;
  /** CLI command surface frozen from this release. */
  cliSurface: '1.5.5';
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

/** LTS metadata for tooling / ops (version, format, CLI surface). */
export function getCompatibilityInfo(): CompatibilityInfo {
  return {
    version: getVersion(),
    formatVersion: FORMAT_VERSION,
    lts: true,
    cliSurface: '1.5.5',
    features: [
      'encryption',
      'sql-like-join-count',
      'lazy-collections',
      'rekey',
      'vacuum',
      'doctor-deep',
      'cli-1.5.5',
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
