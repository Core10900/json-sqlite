import type { JSONSQLite } from '../engine/JSONSQLite.js';

export interface RepairOptions {
  /** Rebuild all indexes from live documents (default true). */
  rebuildIndexes?: boolean;
}

export interface RepairResult {
  rebuiltIndexes: string[];
  message: string;
}

/**
 * Explicit repair. Does not rewrite document pages.
 * Call this after open when indexes are corrupt or incomplete.
 */
export async function repairDatabase(
  db: JSONSQLite,
  opts?: RepairOptions,
): Promise<RepairResult> {
  const rebuildIndexes = opts?.rebuildIndexes !== false;
  const rebuiltIndexes: string[] = [];
  if (rebuildIndexes) {
    const result = await db.rebuildIndexes();
    rebuiltIndexes.push(...result.collections);
  }
  return {
    rebuiltIndexes,
    message:
      rebuiltIndexes.length > 0
        ? `rebuilt indexes for ${rebuiltIndexes.join(', ')}`
        : 'no indexes rebuilt',
  };
}
