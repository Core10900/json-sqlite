import type { JSONSQLite } from '../engine/JSONSQLite.js';
import type { VacuumOptions, VacuumResult } from '../types/index.js';

/**
 * Rewrite collection JSONL from in-memory live docs and truncate WAL.
 * Does not delete change-log deltas (time-travel preserved; documented).
 */
export async function vacuumDatabase(
  db: JSONSQLite,
  opts?: VacuumOptions,
): Promise<VacuumResult> {
  const names = opts?.collection
    ? [opts.collection]
    : (await db.listTables()).map((t) => t.name);

  if (opts?.compress) db._store.setCompression(true);

  const documentCounts: Record<string, number> = {};
  for (const name of names) {
    await db._store.ensureLoaded(name);
    await db._store.persistCollection(name);
    documentCounts[name] = db._store.getAll(name).length;
  }

  return {
    collections: names,
    documentCounts,
    compressed: opts?.compress === true || db._store.compressionEnabled(),
  };
}
