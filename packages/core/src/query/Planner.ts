import type { Index } from '../index/types.js';
import type { Document, FilterCondition, FilterOp, JsonQuery } from '../types/index.js';
import { executeJsonQuery, matchFilter } from './JsonQuery.js';

export interface PlanResult {
  docs: Document[];
  usedIndex?: { collection: string; field: string; type: string };
  scanned: number;
}

/**
 * Prefer equality/range/text/composite indexes when filter matches.
 */
export function planAndExecute(
  allDocs: Document[],
  query: JsonQuery,
  indexes: Index[],
  resolveByIds: (ids: string[]) => Document[],
): PlanResult {
  const candidate = pickIndex(query.filter, indexes);
  if (!candidate) {
    const docs = executeJsonQuery(allDocs, query);
    return { docs, scanned: allDocs.length };
  }

  const { index, mode, value, min, max, text, prefixValues } = candidate;
  let ids: string[] = [];
  if (mode === 'eq') ids = index.lookupEq(value);
  else if (mode === 'range') ids = index.lookupRange(min, max);
  else if (mode === 'text') ids = index.lookupText(String(text ?? ''), query.limit ?? 100);
  else if (mode === 'composite' && prefixValues) {
    ids = index.lookupPrefix
      ? index.lookupPrefix(prefixValues)
      : index.lookupEq(prefixValues);
  }

  let docs = resolveByIds(ids);
  // Apply remaining filter / sort / limit via shared executor
  docs = executeJsonQuery(docs, {
    filter: query.filter,
    projection: query.projection,
    orderBy: query.orderBy,
    limit: query.limit,
    offset: query.offset,
  });

  return {
    docs,
    usedIndex: {
      collection: index.meta.collection,
      field: index.meta.field,
      type: index.meta.type,
    },
    scanned: ids.length,
  };
}

function eqValue(condition: unknown): unknown | undefined {
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
    return condition;
  }
  const op = condition as FilterOp;
  if ('$eq' in op) return op.$eq;
  return undefined;
}

function pickIndex(
  filter: FilterCondition | undefined,
  indexes: Index[],
):
  | {
      index: Index;
      mode: 'eq' | 'range' | 'text' | 'composite';
      value?: unknown;
      min?: unknown;
      max?: unknown;
      text?: string;
      prefixValues?: unknown[];
    }
  | null {
  if (!filter) return null;
  const entries = Object.entries(filter).filter(
    ([k]) => k !== '$and' && k !== '$or',
  );

  // Prefer composite indexes when filter has equality prefix on fields
  const composites = indexes.filter((i) => i.meta.type === 'composite');
  let bestComposite: {
    index: Index;
    prefixValues: unknown[];
  } | null = null;
  for (const index of composites) {
    const fields =
      index.meta.fields ?? index.meta.field.split('+').filter(Boolean);
    const values: unknown[] = [];
    for (const f of fields) {
      const entry = entries.find(([k]) => k === f);
      if (!entry) break;
      const v = eqValue(entry[1]);
      if (v === undefined) break;
      values.push(v);
    }
    if (values.length === 0) continue;
    if (
      !bestComposite ||
      values.length > bestComposite.prefixValues.length
    ) {
      bestComposite = { index, prefixValues: values };
    }
  }
  if (bestComposite) {
    return {
      index: bestComposite.index,
      mode: 'composite',
      prefixValues: bestComposite.prefixValues,
    };
  }

  if (entries.length !== 1) return null;
  const [field, condition] = entries[0]!;
  const index = indexes.find(
    (i) => i.meta.field === field && i.meta.type !== 'composite',
  );
  if (!index) return null;

  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
    if (index.meta.type === 'object' || index.meta.type === 'tree') {
      return { index, mode: 'eq', value: condition };
    }
    return null;
  }

  const op = condition as FilterOp;
  if ('$eq' in op && (index.meta.type === 'object' || index.meta.type === 'tree')) {
    return { index, mode: 'eq', value: op.$eq };
  }
  if (
    index.meta.type === 'tree' &&
    ('$gt' in op || '$gte' in op || '$lt' in op || '$lte' in op)
  ) {
    const min =
      op.$gte !== undefined ? op.$gte : op.$gt !== undefined ? op.$gt : undefined;
    const max =
      op.$lte !== undefined ? op.$lte : op.$lt !== undefined ? op.$lt : undefined;
    return { index, mode: 'range', min, max };
  }
  if (index.meta.type === 'inverted' && '$contains' in op) {
    return { index, mode: 'text', text: String(op.$contains ?? '') };
  }
  return null;
}

export function explainFilterMatch(
  docs: Document[],
  filter: FilterCondition,
): number {
  return docs.filter((d) => matchFilter(d, filter)).length;
}
