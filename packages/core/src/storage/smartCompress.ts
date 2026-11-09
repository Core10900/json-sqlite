import { gunzipSync, gzipSync } from 'node:zlib';
import { ErrorCode, JSONSQLiteError } from '../errors.js';

/** Block header magic. The algorithm name follows, then the payload. */
export const SMART_MAGIC = 'JSQB1';

export type SmartAlgorithm = 'delta' | 'dict' | 'rle' | 'gzip' | 'front';

export function isSmartBlock(text: string): boolean {
  return text.startsWith(`${SMART_MAGIC}|`);
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 4 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

function runCount(values: unknown[]): number {
  let runs = 1;
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== values[i - 1]) runs += 1;
  }
  return runs;
}

/**
 * Pick an algorithm for a JSON value.
 * - delta: numeric arrays (length >= 4)
 * - dict: string arrays whose unique count is at most 25%
 * - rle: string arrays with long repeated runs that are not low-cardinality enough for dict
 * - gzip: everything else (objects, long text, mixed values)
 */
export function selectAlgorithm(value: unknown): SmartAlgorithm {
  if (isNumberArray(value)) return 'delta';
  if (
    Array.isArray(value) &&
    value.length >= 4 &&
    value.every((v) => typeof v === 'string')
  ) {
    const uniq = new Set(value).size;
    if (uniq <= Math.max(1, Math.floor(value.length * 0.25))) return 'dict';
    if (runCount(value) <= Math.ceil(value.length / 3)) return 'rle';
  }
  return 'gzip';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Front-coding for a string array: shared prefix length plus the new suffix. */
function encodeFront(values: string[]): string {
  if (values.some((item) => item.includes('\n'))) {
    throw new Error('front-coding does not accept newlines');
  }
  let prev = '';
  const lines: string[] = [];
  for (const cur of values) {
    let prefix = 0;
    const max = Math.min(prev.length, cur.length);
    while (prefix < max && prev[prefix] === cur[prefix]) prefix += 1;
    lines.push(`${prefix}:${cur.slice(prefix)}`);
    prev = cur;
  }
  return lines.join('\n');
}

function decodeFront(payload: string): string[] {
  if (payload === '') return [];
  const out: string[] = [];
  let prev = '';
  for (const line of payload.split('\n')) {
    const sep = line.indexOf(':');
    if (sep < 0) throw new Error('front-coding line is missing a prefix length');
    const prefix = Number(line.slice(0, sep));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > prev.length) {
      throw new Error('front-coding prefix length is out of range');
    }
    const cur = prev.slice(0, prefix) + line.slice(sep + 1);
    out.push(cur);
    prev = cur;
  }
  return out;
}

function encodeBlock(algorithm: SmartAlgorithm, value: unknown, original: string): string {
  let payload: string;
  if (algorithm === 'gzip') {
    payload = gzipSync(Buffer.from(original, 'utf8')).toString('base64');
  } else if (algorithm === 'front') {
    if (!isStringArray(value)) throw new Error('front-coding requires a string array');
    payload = encodeFront(value);
  } else if (algorithm === 'delta') {
    const nums = value as number[];
    const diffs: number[] = [];
    for (let i = 1; i < nums.length; i++) diffs.push(nums[i]! - nums[i - 1]!);
    payload = JSON.stringify({ f: nums[0], d: diffs });
  } else if (algorithm === 'dict') {
    const arr = value as string[];
    const uniq: string[] = [];
    const index = new Map<string, number>();
    const ids: number[] = [];
    for (const item of arr) {
      let id = index.get(item);
      if (id === undefined) {
        id = uniq.length;
        index.set(item, id);
        uniq.push(item);
      }
      ids.push(id);
    }
    payload = JSON.stringify({ u: uniq, i: ids });
  } else {
    const arr = value as unknown[];
    const runs: [unknown, number][] = [];
    for (const item of arr) {
      const last = runs[runs.length - 1];
      if (last && last[0] === item) last[1] += 1;
      else runs.push([item, 1]);
    }
    payload = JSON.stringify(runs);
  }
  return `${SMART_MAGIC}|${algorithm}|${payload}`;
}

function decodeDelta(payload: string): number[] {
  const parsed = JSON.parse(payload) as { f?: number; d?: number[] };
  if (typeof parsed.f !== 'number' || !Array.isArray(parsed.d)) {
    throw new Error('delta payload is not { f, d }');
  }
  const out = [parsed.f];
  for (const diff of parsed.d) {
    if (typeof diff !== 'number' || !Number.isFinite(diff)) {
      throw new Error('delta diff is not a finite number');
    }
    out.push(out[out.length - 1]! + diff);
  }
  return out;
}

function decodeDict(payload: string): string[] {
  const parsed = JSON.parse(payload) as { u?: unknown; i?: unknown };
  if (!Array.isArray(parsed.u) || !Array.isArray(parsed.i)) {
    throw new Error('dict payload is not { u, i }');
  }
  const uniq = parsed.u as unknown[];
  return parsed.i.map((id) => {
    if (typeof id !== 'number' || uniq[id] === undefined) {
      throw new Error('dict index out of range');
    }
    return String(uniq[id]);
  });
}

function decodeRle(payload: string): unknown[] {
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) throw new Error('rle payload is not an array');
  const out: unknown[] = [];
  for (const run of parsed) {
    if (!Array.isArray(run) || run.length !== 2 || typeof run[1] !== 'number') {
      throw new Error('rle run is not [value, count]');
    }
    for (let i = 0; i < run[1]; i++) out.push(run[0]);
  }
  return out;
}

/** Undo a smart block. A bad header or payload throws DATA_CORRUPT. */
export function decompressSmart(text: string): string {
  if (!isSmartBlock(text)) {
    throw new JSONSQLiteError(
      ErrorCode.DATA_CORRUPT,
      'Not a smart compression block',
    );
  }
  const rest = text.slice(SMART_MAGIC.length + 1);
  const sep = rest.indexOf('|');
  if (sep < 0) {
    throw new JSONSQLiteError(
      ErrorCode.DATA_CORRUPT,
      'Smart compression block header is truncated',
    );
  }
  const algorithm = rest.slice(0, sep);
  const payload = rest.slice(sep + 1);
  try {
    switch (algorithm) {
      case 'delta':
        return JSON.stringify(decodeDelta(payload));
      case 'dict':
        return JSON.stringify(decodeDict(payload));
      case 'rle':
        return JSON.stringify(decodeRle(payload));
      case 'gzip':
        return gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
      case 'front':
        return JSON.stringify(decodeFront(payload));
      default:
        throw new JSONSQLiteError(
          ErrorCode.DATA_CORRUPT,
          `Unknown smart compression algorithm: ${algorithm}`,
          { algorithm },
        );
    }
  } catch (err) {
    if (err instanceof JSONSQLiteError) throw err;
    throw new JSONSQLiteError(
      ErrorCode.DATA_CORRUPT,
      `Smart compression round-trip failed for algorithm ${algorithm}`,
      {
        algorithm,
        cause: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/** Header fields: magic `JSQB1`, then `algorithm`, then the payload. */
export function readSmartHeader(text: string): { magic: string; algorithm: string } {
  if (!isSmartBlock(text)) {
    throw new JSONSQLiteError(ErrorCode.DATA_CORRUPT, 'Not a smart compression block');
  }
  const rest = text.slice(SMART_MAGIC.length + 1);
  const sep = rest.indexOf('|');
  if (sep < 0) {
    throw new JSONSQLiteError(
      ErrorCode.DATA_CORRUPT,
      'Smart compression block header is truncated',
    );
  }
  return { magic: SMART_MAGIC, algorithm: rest.slice(0, sep) };
}

function encodedSize(
  algorithm: SmartAlgorithm,
  value: unknown,
  json: string,
): number | null {
  try {
    const text = encodeBlock(algorithm, value, json);
    if (decompressSmart(text) !== json) return null;
    return Buffer.byteLength(text);
  } catch {
    return null;
  }
}

/**
 * Compress a JSON string. A sample window compares candidate sizes, including
 * front-coding for string arrays, and the winning name is written to the
 * `algorithm` header field. Reopen reads that field and does not re-sample.
 * If nothing round-trips, throws DATA_CORRUPT and the caller must not persist the block.
 */
export function compressSmart(
  json: string,
  sampleWindow = 64,
): { text: string; algorithm: SmartAlgorithm } {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    value = json;
  }
  const preferred = selectAlgorithm(value);
  const window = Math.max(1, sampleWindow);
  const sample = Array.isArray(value) ? value.slice(0, window) : value;
  const sampleJson = JSON.stringify(sample);
  // Delta, dict, and RLE stay when selectAlgorithm already picked them.
  // The sample window compares front-coding with gzip for the remaining strings.
  let best: SmartAlgorithm = preferred;
  if (preferred === 'gzip' && isStringArray(value)) {
    const gzipSize = encodedSize('gzip', sample, sampleJson) ?? Number.POSITIVE_INFINITY;
    const frontSize = encodedSize('front', sample, sampleJson);
    if (frontSize !== null && frontSize < gzipSize) best = 'front';
  }

  const order: SmartAlgorithm[] = [];
  for (const algorithm of [best, preferred, 'gzip' as const]) {
    if (!order.includes(algorithm)) order.push(algorithm);
  }
  let lastCause = 'mismatch';
  for (const algorithm of order) {
    try {
      const text = encodeBlock(algorithm, value, json);
      if (decompressSmart(text) !== json) {
        lastCause = 'decoded bytes differ from input';
        continue;
      }
      return { text, algorithm };
    } catch (err) {
      lastCause = err instanceof Error ? err.message : String(err);
    }
  }
  throw new JSONSQLiteError(
    ErrorCode.DATA_CORRUPT,
    `Smart compression round-trip failed for algorithm ${preferred}`,
    { algorithm: preferred, cause: lastCause },
  );
}
