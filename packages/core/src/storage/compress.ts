import { gunzipSync, gzipSync } from 'node:zlib';

/** Text-line envelope for gzip-compressed JSON (before optional encryption). */
export const COMPRESS_PREFIX = 'JSQC1:';

/**
 * Gzip a JSON payload when it is at least `threshold` bytes and the
 * wrapped form is smaller. Shorter values stay plain so tiny docs are unchanged.
 */
export function compressLine(json: string, threshold: number): string {
  if (threshold < 0 || json.length < threshold) return json;
  const gz = gzipSync(Buffer.from(json, 'utf8'));
  const wrapped = COMPRESS_PREFIX + gz.toString('base64');
  return wrapped.length < json.length ? wrapped : json;
}

/** Undo `compressLine`. Plain JSON passes through. */
export function decompressLine(payload: string): string {
  if (!payload.startsWith(COMPRESS_PREFIX)) return payload;
  const gz = Buffer.from(payload.slice(COMPRESS_PREFIX.length), 'base64');
  return gunzipSync(gz).toString('utf8');
}
