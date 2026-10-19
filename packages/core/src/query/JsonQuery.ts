import type {
  Document,
  FilterCondition,
  FilterOp,
  FilterValue,
  JsonQuery,
  OrderBySpec,
} from '../types/index.js';

export function executeJsonQuery(
  docs: Document[],
  query: Omit<JsonQuery, 'collection'>,
): Document[] {
  let result = docs;

  if (query.filter && Object.keys(query.filter).length > 0) {
    result = result.filter((doc) => matchFilter(doc, query.filter!));
  }

  if (query.orderBy) {
    const specs = normalizeOrderBy(query.orderBy);
    result = [...result].sort((a, b) => compareByOrder(a, b, specs));
  }

  const offset = query.offset ?? 0;
  const limit = query.limit;
  if (offset > 0 || limit !== undefined) {
    result = result.slice(offset, limit === undefined ? undefined : offset + limit);
  }

  if (query.projection && query.projection.length > 0) {
    result = result.map((doc) => projectDoc(doc, query.projection!));
  }

  return result;
}

export function matchFilter(doc: Document, filter: FilterCondition): boolean {
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
  if ('$exists' in op) {
    return op.$exists ? value !== undefined : value === undefined;
  }

  // Plain object used as equality (rare)
  return deepEqual(value, condition);
}

function getPath(doc: Document, path: string): unknown {
  if (!path.includes('.')) return doc[path];
  const parts = path.split('.');
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
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

function normalizeOrderBy(orderBy: OrderBySpec | OrderBySpec[]): OrderBySpec[] {
  return Array.isArray(orderBy) ? orderBy : [orderBy];
}

function compareByOrder(a: Document, b: Document, specs: OrderBySpec[]): number {
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

function projectDoc(doc: Document, fields: string[]): Document {
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
