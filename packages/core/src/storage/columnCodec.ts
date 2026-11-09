/** Column file magic. The kind segment is `num`, `dict`, or `json`. */
export const COLUMN_MAGIC = 'JSQC2';

const KIND = {
  num: 'num',
  dict: 'dict',
  json: 'json',
} as const;

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function zigzag(n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function unzigzag(n: number): number {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

function writeVarint(n: number, out: number[]): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error('varint requires a non-negative safe integer');
  }
  let value = n;
  while (value >= 128) {
    out.push((value % 128) + 128);
    value = Math.floor(value / 128);
  }
  out.push(value);
}

function readVarints(buf: Buffer): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < buf.length) {
    let value = 0;
    let shift = 1;
    let byte = 0;
    do {
      if (i >= buf.length) throw new Error('truncated varint');
      byte = buf[i]!;
      i += 1;
      value += (byte & 0x7f) * shift;
      shift *= 128;
    } while (byte >= 128);
    out.push(value);
  }
  return out;
}

function encodeNums(values: number[]): string {
  const bytes: number[] = [];
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const cur = values[i]!;
    const delta = i === 0 ? cur : cur - prev;
    prev = cur;
    writeVarint(zigzag(delta), bytes);
  }
  return Buffer.from(bytes).toString('base64');
}

function decodeNums(payload: string): number[] {
  const bytes = Buffer.from(payload, 'base64');
  const deltas = readVarints(bytes).map(unzigzag);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < deltas.length; i++) {
    const cur = i === 0 ? deltas[i]! : prev + deltas[i]!;
    out.push(cur);
    prev = cur;
  }
  return out;
}

function encodeDict(values: string[]): string {
  const uniq: string[] = [];
  const index = new Map<string, number>();
  const bytes: number[] = [];
  for (const value of values) {
    let id = index.get(value);
    if (id === undefined) {
      id = uniq.length;
      index.set(value, id);
      uniq.push(value);
    }
    writeVarint(id, bytes);
  }
  const dict = Buffer.from(JSON.stringify(uniq), 'utf8').toString('base64');
  const ids = Buffer.from(bytes).toString('base64');
  return `${dict}|${ids}`;
}

function decodeDict(payload: string): string[] {
  const sep = payload.indexOf('|');
  if (sep < 0) throw new Error('dict column is missing the id list');
  const uniq = JSON.parse(
    Buffer.from(payload.slice(0, sep), 'base64').toString('utf8'),
  ) as unknown;
  if (!Array.isArray(uniq)) throw new Error('dict column dictionary is not an array');
  const ids = readVarints(Buffer.from(payload.slice(sep + 1), 'base64'));
  return ids.map((id) => {
    const value = uniq[id];
    if (typeof value !== 'string') throw new Error('dict column index out of range');
    return value;
  });
}

/**
 * Encode one column.
 * Safe integers use delta + zigzag varint. Strings use a dictionary plus varint ids.
 * Mixed values stay JSON so a bad decode can fall back to the document pages.
 */
export function encodeColumn(values: unknown[]): string {
  if (values.every(isSafeInt)) {
    return `${COLUMN_MAGIC}|${KIND.num}|${encodeNums(values)}`;
  }
  if (values.length > 0 && values.every((value) => typeof value === 'string')) {
    return `${COLUMN_MAGIC}|${KIND.dict}|${encodeDict(values)}`;
  }
  return `${COLUMN_MAGIC}|${KIND.json}|${JSON.stringify(values)}`;
}

/** Decode a column file. Legacy raw JSON arrays (2.3) still parse. */
export function decodeColumn(text: string): unknown[] {
  if (!text.startsWith(`${COLUMN_MAGIC}|`)) {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) throw new Error('column payload is not an array');
    return parsed;
  }
  const rest = text.slice(COLUMN_MAGIC.length + 1);
  const sep = rest.indexOf('|');
  if (sep < 0) throw new Error('column header is truncated');
  const kind = rest.slice(0, sep);
  const payload = rest.slice(sep + 1);
  if (kind === KIND.num) return decodeNums(payload);
  if (kind === KIND.dict) return decodeDict(payload);
  if (kind === KIND.json) {
    const parsed = JSON.parse(payload) as unknown;
    if (!Array.isArray(parsed)) throw new Error('json column is not an array');
    return parsed;
  }
  throw new Error(`unknown column kind ${kind}`);
}
