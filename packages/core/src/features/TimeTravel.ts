import type { Document } from '../types/index.js';
import {
  applyPatchDoc,
  type ChangeEntry,
} from '../storage/ChangeLog.js';
import { executeJsonQuery } from '../query/JsonQuery.js';
import type { JsonQuery } from '../types/index.js';

export function reconstructAtTime(
  baseDocs: Document[],
  changes: ChangeEntry[],
  timestamp: number,
): Document[] {
  const map = new Map<string, Document>();
  for (const d of baseDocs) map.set(d._id, { ...d });

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
    // Prefer forward rebuild from empty when the log has patch entries.
    // Otherwise walk backward from current using reverse of later changes.
    const hasPatch = changes.some((c) => c.patch);
    if (hasPatch) {
      map.clear();
      for (const c of ordered) applyChange(map, c);
    } else {
      const future = changes
        .filter((c) => c.ts > timestamp)
        .sort((a, b) => b.ts - a.ts);
      for (const c of future) {
        revertChange(map, c);
      }
    }
  }

  return Array.from(map.values());
}

function applyChange(map: Map<string, Document>, c: ChangeEntry): void {
  if (c.op === 'delete') {
    map.delete(c.id);
    return;
  }
  if (c.op === 'insert') {
    const doc = applyPatchDoc(null, c);
    if (doc) map.set(c.id, doc as Document);
    return;
  }
  const prev = map.get(c.id) ?? null;
  const next = applyPatchDoc(prev, c);
  if (next) map.set(c.id, next as Document);
  else map.delete(c.id);
}

function revertChange(map: Map<string, Document>, c: ChangeEntry): void {
  if (c.op === 'insert') {
    map.delete(c.id);
  } else if (c.patch) {
    // Without the prior full document, reverse a field patch by restoring
    // the before patch values when present.
    const current = map.get(c.id);
    if (!current) return;
    if (c.before && typeof c.before === 'object') {
      Object.assign(current, c.before);
      map.set(c.id, current);
    }
  } else if (c.before && typeof c.before === 'object') {
    map.set(c.id, { ...(c.before as Document) });
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
