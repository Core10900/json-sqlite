import { createHash } from 'node:crypto';
import type { IndexMeta, IndexSnapshot } from './types.js';

/** On-disk index segment format. Bump when the body shape changes. */
export const INDEX_SEGMENT_FORMAT = 1;

export interface SegmentBody {
  format: number;
  meta: IndexMeta;
  docCount: number;
  revisionSum: number;
  snapshot: IndexSnapshot;
}

export interface SegmentStamp {
  checksum: string;
  docCount: number;
  revisionSum: number;
}

export function revisionSum(docs: { _version: number }[]): number {
  let sum = 0;
  for (const doc of docs) sum += doc._version;
  return sum;
}

export function checksumBody(body: SegmentBody): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function segmentFileName(collection: string, field: string): string {
  return `${encodeURIComponent(collection)}__${encodeURIComponent(field)}.seg.json`;
}
