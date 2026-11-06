import type {
  Document,
  FilterCondition,
  FilterOp,
  FilterValue,
  JsonQuery,
  OrderBySpec,
} from '../types/index.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { assertGeoBox, pointInBox } from '../index/geo.js';
import { checkpoint, type ExecContext } from './checkpoint.js';
import { matchLike } from './like.js';

export function executeJsonQuery(
  docs: Document[],
  query: Omit<JsonQuery, 'collection'>,
  ctx?: ExecContext,
): Document[] {
  const offset = query.offset ?? 0;
  const limit = query.limit;
  const early = !query.orderBy && limit !== undefined;
  const stopAt = early ? offset + limit : Number.POSITIVE_INFINITY;
  const pushed = projectionIsPushed(query);
  if (ctx) ctx.projectionPushed = pushed;

  if (stopAt <= 0) {
    if (ctx) ctx.earlyStop = docs.length > 0;
    return [];
  }

  const matched: Document[] = [];
  for (let i = 0; i < docs.length; i++) {
    checkpoint(ctx);
    if (ctx?.recordScan) ctx.scanned += 1;
    const doc = docs[i]!;
    if (!docMatches(doc, query, ctx)) continue;
    const fields = query.projection ?? [];
    matched.push(pushed ? projectDoc(doc, fields) : doc);
    if (matched.length >= stopAt) {
      if (ctx) ctx.earlyStop = i < docs.length - 1;
      break;
    }
  }

  let result = matched;
  if (query.orderBy) {
    const specs = normalizeOrderBy(query.orderBy);
    result = [...result].sort((a, b) => compareByOrder(a, b, specs));
  }
  if (offset > 0 || limit !== undefined) {
    result = result.slice(offset, limit === undefined ? undefined : offset + limit);
  }
  const projection = query.projection;
  if (projection && projection.length > 0 && !pushed) {
    result = result.map((doc) => projectDoc(doc, projection));
  }
  return result;
}

function docMatches(
  doc: Document,
  query: Omit<JsonQuery, 'collection'>,
  ctx?: ExecContext,
): boolean {
  if (ctx?.predicate) return ctx.predicate(doc);
  if (!query.filter || Object.keys(query.filter).length === 0) return true;
  return matchFilter(doc, query.filter);
}

export function matchFilter(doc: Document, filter: FilterCondition): boolean {
  if (Object.keys(filter).length === 1 && typeof filter.$const === 'boolean') {
    return filter.$const;
  }
  if ('$and' in filter && Array.isArray(filter.$and)) {
    return (filter.$and as FilterCondition[]).every((f) => matchFilter(doc, f));
  }
  if ('$or' in filter && Array.isArray(filter.$or)) {
    return (filter.$or as FilterCondition[]).some((f) => matchFilter(doc, f));
  }

  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') continue;
    const value = getPath(doc, key);
    if (!matchCondition(value, condition)) return false;
  }
  return true;
}

function matchCondition(value: unknown, condition: FilterValue): boolean {
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
    return deepEqual(value, condition);
  }

  const op = condition as FilterOp;
  if ('$eq' in op) return deepEqual(value, op.$eq);
  if ('$ne' in op) return !deepEqual(value, op.$ne);
  if ('$gt' in op && op.$gt !== undefined) return compare(value, op.$gt) > 0;
  if ('$gte' in op && op.$gte !== undefined) return compare(value, op.$gte) >= 0;
  if ('$lt' in op && op.$lt !== undefined) return compare(value, op.$lt) < 0;
  if ('$lte' in op && op.$lte !== undefined) return compare(value, op.$lte) <= 0;
  if ('$in' in op && Array.isArray(op.$in)) {
    return op.$in.some((v) => deepEqual(value, v));
  }
  if ('$nin' in op && Array.isArray(op.$nin)) {
    return !op.$nin.some((v) => deepEqual(value, v));
  }
  if ('$contains' in op && typeof op.$contains === 'string') {
    return typeof value === 'string' && value.includes(op.$contains);
  }
  if ('$like' in op && typeof op.$like === 'string') {
    return matchLike(value, op.$like);
  }
  if ('$nlike' in op && typeof op.$nlike === 'string') {
    return !matchLike(value, op.$nlike);
  }
  if ('$regex' in op && op.$regex !== undefined) {
    return matchRegex(value, op.$regex);
  }
  if ('$exists' in op) {
    return op.$exists ? value !== undefined : value === undefined;
  }
  if ('$geoWithin' in op && op.$geoWithin) {
    try {
      assertGeoBox(op.$geoWithin);
    } catch (err) {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        err instanceof Error ? err.message : String(err),
      );
    }
    return pointInBox(value, op.$geoWithin);
  }

  // Plain object used as equality (rare)
  return deepEqual(value, condition);
}

export function getPath(doc: Document, path: string): unknown {
  // Prefer exact key (JOIN flat rows use "alias.field")
  if (Object.prototype.hasOwnProperty.call(doc, path)) return doc[path];
  if (!path.includes('.')) return doc[path];
  const parts = path.split('.');
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function matchRegex(
  value: unknown,
  spec: string | { pattern: string; flags?: string },
): boolean {
  if (typeof value !== 'string') return false;
  let pattern: string;
  let flags = '';
  if (typeof spec === 'string') {
    pattern = spec;
  } else if (spec && typeof spec === 'object' && typeof spec.pattern === 'string') {
    pattern = spec.pattern;
    flags = typeof spec.flags === 'string' ? spec.flags : '';
  } else {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      '$regex requires a string pattern or { pattern, flags? }',
    );
  }
  try {
    return new RegExp(pattern, flags).test(value);
  } catch (err) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `Invalid $regex: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return String(a).localeCompare(String(b));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Projection can run before sort when every sort key is kept. */
export function projectionIsPushed(query: {
  projection?: string[];
  orderBy?: OrderBySpec | OrderBySpec[];
}): boolean {
  if (!query.projection || query.projection.length === 0) return false;
  if (!query.orderBy) return true;
  const fields = normalizeOrderBy(query.orderBy).flatMap((spec) => Object.keys(spec));
  return fields.every((field) => query.projection!.includes(field));
}

export function normalizeOrderBy(orderBy: OrderBySpec | OrderBySpec[]): OrderBySpec[] {
  return Array.isArray(orderBy) ? orderBy : [orderBy];
}

export function compareByOrder(a: Document, b: Document, specs: OrderBySpec[]): number {
  for (const spec of specs) {
    for (const [field, dir] of Object.entries(spec)) {
      const av = getPath(a, field);
      const bv = getPath(b, field);
      const cmp = compare(av, bv);
      if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
    }
  }
  return 0;
}

export function projectDoc(doc: Document, fields: string[]): Document {
  const out: Document = {
    _id: doc._id,
    _version: doc._version,
    _createdAt: doc._createdAt,
    _updatedAt: doc._updatedAt,
  };
  for (const f of fields) {
    if (f in doc) out[f] = doc[f];
  }
  return out;
}
