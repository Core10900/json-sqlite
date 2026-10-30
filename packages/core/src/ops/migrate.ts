import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveEncryptionKey } from '../config/defaults.js';
import { verifyEncryptionKey } from '../crypto/keycheck.js';
import { decryptLine, isEncryptedLine } from '../crypto/aes.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { open } from '../engine/JSONSQLite.js';
import { create } from '../lifecycle.js';
import { FORMAT_VERSION } from '../storage/Catalog.js';
import { decompressLine } from '../storage/compress.js';
import { diagnoseWalText } from '../storage/Wal.js';
import type { Document, FieldDef, SyncMode } from '../types/index.js';
import { appendAuditFile } from './audit.js';
import { catalogFile, docsFile, walFile } from '../utils/path.js';

export interface MigrateDatabaseOptions {
  from: string;
  to: string;
  /** Key for an encrypted source. Also used to encrypt the target. */
  encryptionKey?: string | null;
  /**
   * When the target already exists, refuse unless this is true.
   * With yes, the target is replaced. Without yes, the existing target is left as-is.
   */
  yes?: boolean;
  syncMode?: SyncMode;
}

export interface MigrateDatabaseResult {
  storagePath: string;
  formatVersion: number;
  documentCounts: Record<string, number>;
  /** sha256 over the source catalog and collection payloads. */
  sourceChecksum: string;
}

interface SourceCatalog {
  formatVersion: number;
  encryption?: boolean;
  collections: Record<
    string,
    { name: string; createdAt: number; documentCount: number; fields?: FieldDef[] }
  >;
}

/**
 * Copy a 1.x database (formatVersion 1) into a format 2 directory.
 * The source is validated before the target directory is created.
 * If copying fails, a target created by this call is removed.
 */
export async function migrateDatabase(
  opts: MigrateDatabaseOptions,
): Promise<MigrateDatabaseResult> {
  const from = path.resolve(opts.from);
  const to = path.resolve(opts.to);
  if (from === to) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      'migrate --from and --to must be different directories',
    );
  }

  const source = await readSourceCatalog(from);
  if (source.formatVersion > FORMAT_VERSION) {
    throw new JSONSQLiteError(
      ErrorCode.INTERNAL,
      `Source formatVersion ${source.formatVersion} is newer than this binary`,
    );
  }

  const key = resolveEncryptionKey(opts.encryptionKey);
  if (source.encryption && !key) {
    throw new JSONSQLiteError(
      ErrorCode.ENCRYPTION,
      'Encrypted source requires encryptionKey / JSONSQLITE_KEY',
    );
  }
  if (source.encryption && key) {
    await verifyEncryptionKey(from, key, Object.keys(source.collections));
  }

  const loaded =
    source.formatVersion < FORMAT_VERSION
      ? await loadLegacyDocuments(from, source, key)
      : await loadCurrentDocuments(from, opts.encryptionKey ?? null);
  const checksum = await sourceChecksum(from, Object.keys(loaded));

  let created = false;
  try {
    const exists = await pathExists(to);
    if (exists && !opts.yes) {
      throw new JSONSQLiteError(
        ErrorCode.DB_EXISTS,
        `Target already exists at ${to}. Pass yes: true or --yes to replace it.`,
      );
    }
    if (exists && opts.yes) {
      await fs.rm(to, { recursive: true, force: true });
    }

    const encKey = source.encryption
      ? (opts.encryptionKey ?? process.env.JSONSQLITE_KEY ?? null)
      : null;
    await create({
      storagePath: to,
      force: false,
      encryptionKey: encKey,
      syncMode: opts.syncMode,
    });
    created = true;

    const db = await open({
      storagePath: to,
      encryptionKey: encKey,
      syncMode: opts.syncMode ?? 'normal',
      lazyCollections: true,
    });
    try {
      const documentCounts: Record<string, number> = {};
      for (const [name, docs] of Object.entries(loaded)) {
        const fields = source.collections[name]?.fields;
        await db.createTable(name, fields && fields.length > 0 ? { fields } : undefined);
        await db.importCollection(name, docs, { mode: 'replace' });
        documentCounts[name] = docs.length;
      }
      await db.close();
      await appendAuditFile(to, 'migrate', `migrated from ${from}`, {
        from,
        to,
        documentCounts,
        sourceChecksum: checksum,
      });
      return {
        storagePath: to,
        formatVersion: FORMAT_VERSION,
        documentCounts,
        sourceChecksum: checksum,
      };
    } catch (err) {
      await db.close({ flush: false }).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    if (created) {
      await fs.rm(to, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
}

async function readSourceCatalog(root: string): Promise<SourceCatalog> {
  let raw: string;
  try {
    raw = await fs.readFile(catalogFile(root), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new JSONSQLiteError(ErrorCode.DB_NOT_FOUND, `No catalog at ${root}`);
    }
    throw err;
  }
  let data: SourceCatalog;
  try {
    data = JSON.parse(raw) as SourceCatalog;
  } catch {
    throw new JSONSQLiteError(ErrorCode.INTERNAL, 'Source catalog.json is not valid JSON');
  }
  if (typeof data.formatVersion !== 'number' || !data.collections) {
    throw new JSONSQLiteError(
      ErrorCode.INTERNAL,
      'Source catalog.json is missing formatVersion or collections',
    );
  }
  return data;
}

async function loadCurrentDocuments(
  root: string,
  encryptionKey: string | null,
): Promise<Record<string, Document[]>> {
  const db = await open({
    storagePath: root,
    encryptionKey,
    lazyCollections: true,
  });
  try {
    const out: Record<string, Document[]> = {};
    for (const table of await db.listTables()) {
      out[table.name] = await db.exportCollection(table.name);
    }
    return out;
  } finally {
    await db.close();
  }
}

async function loadLegacyDocuments(
  root: string,
  source: SourceCatalog,
  key: Buffer | null,
): Promise<Record<string, Document[]>> {
  const out: Record<string, Document[]> = {};
  for (const name of Object.keys(source.collections)) {
    let raw = '';
    try {
      raw = await fs.readFile(docsFile(root, name), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const parsed = parseDocLines(name, raw, key);
    let walRaw = '';
    try {
      walRaw = await fs.readFile(walFile(root, name), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (walRaw) {
      const diag = diagnoseWalText(walRaw, key);
      if (diag.issues.length > 0) {
        const first = diag.issues[0]!;
        throw new JSONSQLiteError(
          ErrorCode.WAL_CORRUPT,
          `Source WAL for ${name} is corrupt at line ${first.line}; migrate aborted`,
          first,
        );
      }
      for (const entry of diag.committed) {
        if (entry.op === 'delete') {
          const id = (entry.payload as { _id: string })._id;
          const idx = parsed.findIndex((d) => d._id === id);
          if (idx >= 0) parsed.splice(idx, 1);
        } else {
          const doc = entry.payload as Document;
          const idx = parsed.findIndex((d) => d._id === doc._id);
          if (idx >= 0) parsed[idx] = doc;
          else parsed.push(doc);
        }
      }
    }
    out[name] = parsed;
  }
  return out;
}

function parseDocLines(name: string, raw: string, key: Buffer | null): Document[] {
  if (raw.length === 0) return [];
  const parts = raw.split('\n');
  if (raw.endsWith('\n')) parts.pop();
  else parts.pop();
  const docs: Document[] = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (!line.trim()) continue;
    try {
      docs.push(decodeDocLine(line, key));
    } catch (err) {
      if (err instanceof JSONSQLiteError && err.code === ErrorCode.ENCRYPTION) throw err;
      throw new JSONSQLiteError(
        ErrorCode.INTERNAL,
        `Corrupt document line ${i + 1} in ${name}; migrate aborted`,
      );
    }
  }
  return docs;
}

function decodeDocLine(line: string, key: Buffer | null): Document {
  if (isEncryptedLine(line) && !key) {
    throw new JSONSQLiteError(
      ErrorCode.ENCRYPTION,
      'Encrypted source requires encryptionKey / JSONSQLITE_KEY',
    );
  }
  const plain = decompressLine(decryptLine(line, key));
  const doc = JSON.parse(plain) as Document;
  if (!doc || typeof doc._id !== 'string') {
    throw new Error('document missing _id');
  }
  return doc;
}

async function sourceChecksum(
  root: string,
  collections: string[],
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(catalogFile(root)));
  for (const name of [...collections].sort()) {
    hash.update(name);
    try {
      hash.update(await fs.readFile(docsFile(root, name)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    try {
      hash.update(await fs.readFile(walFile(root, name)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return hash.digest('hex');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
