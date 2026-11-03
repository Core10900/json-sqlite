import type { Document, JsonQuery } from '../types/index.js';
import { executeJsonQuery, matchFilter } from './JsonQuery.js';

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
): ChunkExecution {
  if (chunkSize <= 0 || docs.length <= chunkSize) {
    return { docs: executeJsonQuery(docs, query), chunked: false, chunks: 1 };
  }
  const matched: Document[] = [];
  let chunks = 0;
  const filter = query.filter;
  const hasFilter = Boolean(filter && Object.keys(filter).length > 0);
  for (let i = 0; i < docs.length; i += chunkSize) {
    chunks += 1;
    const slice = docs.slice(i, i + chunkSize);
    for (const doc of slice) {
      if (!hasFilter || matchFilter(doc, filter!)) matched.push(doc);
    }
  }
  return {
    docs: executeJsonQuery(matched, {
      projection: query.projection,
      orderBy: query.orderBy,
      limit: query.limit,
      offset: query.offset,
    }),
    chunked: true,
    chunks,
  };
}
