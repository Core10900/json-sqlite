import { open, type JSONSQLite } from '../engine/JSONSQLite.js';
import type { GlobalFlags } from './args.js';
import { resolveStoragePath } from './args.js';
import type { OutputOpts } from './output.js';
import { failFromError } from './output.js';

export interface CliContext {
  globals: GlobalFlags;
  out: OutputOpts;
  storagePath: string;
}

export function makeContext(globals: GlobalFlags, args: string[]): CliContext {
  return {
    globals,
    out: { json: globals.json, quiet: globals.quiet },
    storagePath: resolveStoragePath(globals, args),
  };
}

export async function withDb<T>(
  ctx: CliContext,
  fn: (db: JSONSQLite) => Promise<T>,
): Promise<T> {
  let db: JSONSQLite | null = null;
  const onSig = async () => {
    try {
      await db?.close({ flush: false });
    } catch {
      /* ignore */
    }
    process.exit(130);
  };
  process.once('SIGINT', onSig);
  try {
    db = await open({ storagePath: ctx.storagePath });
    return await fn(db);
  } catch (err) {
    return failFromError(ctx.out, err);
  } finally {
    process.off('SIGINT', onSig);
    await db?.close().catch(() => undefined);
  }
}

export function parseKvPairs(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const k = p.slice(0, eq);
    const raw = p.slice(eq + 1);
    out[k] = coerceValue(raw);
  }
  return out;
}

export function coerceValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (
    (raw.startsWith('{') && raw.endsWith('}')) ||
    (raw.startsWith('[') && raw.endsWith(']'))
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function parseWhere(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid --where JSON: ${raw}`);
  }
}
