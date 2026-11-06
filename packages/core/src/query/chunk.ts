import type { Document, JsonQuery } from '../types/index.js';
import { checkpoint, type ExecContext } from './checkpoint.js';
import { executeJsonQuery, matchFilter, projectDoc, projectionIsPushed } from './JsonQuery.js';

export interface ChunkExecution {
  docs: Document[];
  chunked: boolean;
  chunks: number;
}

/**
 * Filter the scan in chunks, then sort, page, and project once.
 * When `chunkSize` is 0 or the collection fits in one chunk, this is
 * the same call as `executeJsonQuery`.
 */
export function executeChunked(
  docs: Document[],
  query: Omit<JsonQuery, 'collection'>,
  chunkSize: number,
  ctx?: ExecContext,
): ChunkExecution {
  if (chunkSize <= 0 || docs.length <= chunkSize) {
    return { docs: executeJsonQuery(docs, query, ctx), chunked: false, chunks: 1 };
  }
  const matched: Document[] = [];
  let chunks = 0;
  const filter = query.filter;
  const hasFilter = Boolean(filter && Object.keys(filter).length > 0);
  const pushed = projectionIsPushed(query);
  const offset = query.offset ?? 0;
  const limit = query.limit;
  const early = !query.orderBy && limit !== undefined;
  const stopAt = early ? offset + limit : Number.POSITIVE_INFINITY;
  let stopped = false;
  for (let i = 0; i < docs.length; i += chunkSize) {
    chunks += 1;
    const slice = docs.slice(i, i + chunkSize);
    for (const doc of slice) {
      checkpoint(ctx);
      if (ctx?.recordScan) ctx.scanned += 1;
      const ok = ctx?.predicate
        ? ctx.predicate(doc)
        : !hasFilter || matchFilter(doc, filter!);
      if (!ok) continue;
      matched.push(pushed && query.projection ? projectDoc(doc, query.projection) : doc);
    }
    if (early && matched.length >= stopAt) {
      stopped = i + chunkSize < docs.length;
      break;
    }
  }
  if (ctx) ctx.earlyStop = stopped;
  const saved = ctx?.recordScan;
  if (ctx) ctx.recordScan = false;
  const page = executeJsonQuery(matched, {
    projection: pushed ? undefined : query.projection,
    orderBy: query.orderBy,
    limit: query.limit,
    offset: query.offset,
  });
  if (ctx) {
    ctx.recordScan = saved ?? true;
    ctx.earlyStop = stopped;
    ctx.projectionPushed = pushed;
  }
  return { docs: page, chunked: true, chunks };
}
