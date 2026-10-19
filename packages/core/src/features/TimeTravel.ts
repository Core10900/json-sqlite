import type { Document } from '../types/index.js';
import type { ChangeEntry } from '../storage/ChangeLog.js';
import { executeJsonQuery } from '../query/JsonQuery.js';
import type { JsonQuery } from '../types/index.js';

export function reconstructAtTime(
  baseDocs: Document[],
  changes: ChangeEntry[],
  timestamp: number,
): Document[] {
  const map = new Map<string, Document>();
  for (const d of baseDocs) map.set(d._id, { ...d });

  // If we only have forward changelog from empty/current, rebuild by applying
  // changes with ts <= timestamp onto empty map when base is "current".
  // Strategy: start empty, apply all changes up to timestamp in order.
  // Caller should pass baseDocs = [] when using full changelog from origin.
  if (baseDocs.length === 0) {
    map.clear();
  }

  const ordered = changes
    .filter((c) => c.ts <= timestamp)
    .sort((a, b) => a.ts - b.ts);

  if (baseDocs.length === 0) {
    for (const c of ordered) {
      applyChange(map, c);
    }
  } else {
    // Walk backward from current using reverse of changes after timestamp
    const future = changes
      .filter((c) => c.ts > timestamp)
      .sort((a, b) => b.ts - a.ts);
    for (const c of future) {
      revertChange(map, c);
    }
  }

  return Array.from(map.values());
}

function applyChange(map: Map<string, Document>, c: ChangeEntry): void {
  if (c.op === 'delete') {
    map.delete(c.id);
  } else if (c.after) {
    map.set(c.id, { ...c.after });
  }
}

function revertChange(map: Map<string, Document>, c: ChangeEntry): void {
  if (c.op === 'insert') {
    map.delete(c.id);
  } else if (c.before && typeof c.before === 'object') {
    map.set(c.id, { ...c.before });
  } else {
    map.delete(c.id);
  }
}

export function queryAtTime(
  docsAtTime: Document[],
  query: Omit<JsonQuery, 'collection'>,
): Document[] {
  return executeJsonQuery(docsAtTime, query);
}

export function diffDocs(from: Document[], to: Document[]) {
  const fromMap = new Map(from.map((d) => [d._id, d]));
  const toMap = new Map(to.map((d) => [d._id, d]));
  const added = to.filter((d) => !fromMap.has(d._id));
  const removed = from.filter((d) => !toMap.has(d._id));
  const modified = to.filter((d) => {
    const old = fromMap.get(d._id);
    return old && JSON.stringify(old) !== JSON.stringify(d);
  });
  return { added, removed, modified };
}
