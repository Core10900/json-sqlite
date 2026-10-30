import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveEncryptionKey } from '../config/defaults.js';
import { writeKeycheck } from '../crypto/keycheck.js';
import { open, type JSONSQLite } from '../engine/JSONSQLite.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { create } from '../lifecycle.js';
import type { RekeyOptions, RekeyResult } from '../types/index.js';
import { appendAuditFile } from './audit.js';
import { RekeyJournal } from './rekeyJournal.js';

/**
 * Offline rekey: read with fromKey, write with toKey to targetPath,
 * or atomically swap inplace (requires yes: true).
 */
export async function rekeyDatabase(opts: RekeyOptions): Promise<RekeyResult> {
  if (!opts.storagePath) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      'rekey requires storagePath',
    );
  }
  const source = path.resolve(opts.storagePath);
  if (!opts.toKey || opts.toKey.length < 1) {
    throw new JSONSQLiteError(ErrorCode.INVALID_CONFIG, 'rekey requires toKey');
  }

  const inPlace = opts.inPlace === true;
  if (inPlace && !opts.yes) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      'inplace rekey requires yes: true (CLI: --in-place --yes)',
    );
  }
  if (!inPlace && !opts.targetPath) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      'rekey to a new path requires targetPath (or use inPlace: true with yes: true)',
    );
  }

  const target = inPlace
    ? `${source}.rekey-tmp`
    : path.resolve(opts.targetPath!);

  await fs.rm(target, { recursive: true, force: true });

  let src: JSONSQLite | null = null;
  let dst: JSONSQLite | null = null;
  try {
    src = await open({
      storagePath: source,
      encryptionKey: opts.fromKey ?? null,
      lazyCollections: false,
      syncMode: opts.syncMode ?? 'normal',
    });

    await create({ storagePath: target, force: true });
    dst = await open({
      storagePath: target,
      encryptionKey: opts.toKey,
      lazyCollections: false,
      syncMode: opts.syncMode ?? 'normal',
    });

    const tables = await src.listTables();
    for (const t of tables) {
      if (t.fields?.length) {
        await dst.createTable(t.name, { fields: t.fields });
      }
      const docs = await src.exportCollection(t.name);
      await dst.importCollection(t.name, docs, { mode: 'replace' });
    }

    for (const idx of await src.listIndexes()) {
      await dst.createIndex(idx.collection, idx.field, idx.type, {
        fields: idx.fields,
      });
    }

    await copyDeltas(source, target);
    await writeKeycheck(target, Buffer.from(opts.toKey, 'utf8'));

    await dst.close();
    dst = null;
    await src.close();
    src = null;

    if (!inPlace) {
      await appendAuditFile(target, 'rekey', `rekey out from ${source}`, {
        from: source,
        to: target,
        mode: 'out',
      });
      return { storagePath: target, mode: 'out' };
    }

    const backup = `${source}.rekey-bak`;
    await fs.rm(backup, { recursive: true, force: true });

    const journal = new RekeyJournal(source, opts.syncMode ?? 'normal');
    await journal.write({
      op: 'rekey',
      phase: 'staging_ready',
      source,
      staging: target,
      backup,
      startedAt: Date.now(),
    });

    await journal.write({
      op: 'rekey',
      phase: 'swapping',
      source,
      staging: target,
      backup,
      startedAt: Date.now(),
    });

    await fs.rename(source, backup);
    try {
      await fs.rename(target, source);
    } catch (err) {
      await fs.rename(backup, source).catch(() => undefined);
      throw err;
    }

    await journal.clear();
    await fs.rm(backup, { recursive: true, force: true });

    await appendAuditFile(source, 'rekey', `rekey inplace at ${source}`, {
      from: source,
      to: source,
      mode: 'inplace',
    });
    return { storagePath: source, mode: 'inplace' };
  } catch (err) {
    await src?.close().catch(() => undefined);
    await dst?.close().catch(() => undefined);
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof JSONSQLiteError) throw err;
    throw new JSONSQLiteError(
      ErrorCode.INTERNAL,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function copyDeltas(from: string, to: string): Promise<void> {
  const srcDir = path.join(from, 'deltas');
  const dstDir = path.join(to, 'deltas');
  try {
    const entries = await fs.readdir(srcDir);
    await fs.mkdir(dstDir, { recursive: true });
    for (const name of entries) {
      await fs.copyFile(path.join(srcDir, name), path.join(dstDir, name));
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function resolveRekeyKeys(opts: {
  fromKey?: string;
  toKey?: string;
  fromEnv?: string;
  toEnv?: string;
}): { fromKey: string | null; toKey: string } {
  const fromKey =
    opts.fromKey ??
    (opts.fromEnv ? process.env[opts.fromEnv] : undefined) ??
    null;
  const toKey =
    opts.toKey ?? (opts.toEnv ? process.env[opts.toEnv] : undefined);
  if (!toKey) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      'rekey requires --to-key or --to-env',
    );
  }
  resolveEncryptionKey(fromKey);
  return { fromKey, toKey };
}
