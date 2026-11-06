import type { Index } from '../index/types.js';
import type { Document, FilterCondition, FilterOp, JsonQuery } from '../types/index.js';
import { executeJsonQuery, matchFilter } from './JsonQuery.js';

export interface PlanResult {
  docs: Document[];
  usedIndex?: { collection: string; field: string; type: string };
  scanned: number;
}

export interface PlannedIndex {
  ids: string[];
  usedIndex: { collection: string; field: string; type: string };
  selectivity: number;
  indexWeight: number;
  indexChoice: 'cost' | 'rules';
}

/** Full scan weight used when no index qualifies. Lower cost is better. */
export const FULL_SCAN_WEIGHT = 10;

const INDEX_WEIGHT: Record<string, number> = {
  object: 1,
  composite: 1.2,
  tree: 1.5,
  geo: 2.5,
  inverted: 3,
};

/**
 * Prefer equality/range/text/composite indexes when filter matches.
 * With index stats, pick the lowest selectivity × type weight.
 * Without stats, keep the 2.5 rule order.
 */
export function planIndexIds(query: JsonQuery, indexes: Index[]): PlannedIndex | null {
  const choice = chooseIndex(query.filter, indexes);
  if (!choice) return null;
  return {
    ids: lookupIds(choice, query.limit),
    usedIndex: {
      collection: choice.index.meta.collection,
      field: choice.index.meta.field,
      type: choice.index.meta.type,
    },
    selectivity: choice.selectivity,
    indexWeight: choice.indexWeight,
    indexChoice: choice.indexChoice,
  };
}

export function chooseIndex(
  filter: FilterCondition | undefined,
  indexes: Index[],
): (Candidate & {
  selectivity: number;
  indexWeight: number;
  indexChoice: 'cost' | 'rules';
}) | null {
  const list = collectCandidates(filter, indexes);
  if (list.length === 0) return null;
  const stats = list.map((candidate) => readStats(candidate.index));
  const legacy = list[0]!;
  if (stats.some((item) => !item)) {
    return {
      ...legacy,
      selectivity: selectivityOf(legacy.mode, readStats(legacy.index)),
      indexWeight: weightOf(legacy.index),
      indexChoice: 'rules',
    };
  }
  let best = 0;
  let bestCost = selectivityOf(list[0]!.mode, stats[0]) * weightOf(list[0]!.index);
  for (let i = 1; i < list.length; i++) {
    const cost = selectivityOf(list[i]!.mode, stats[i]) * weightOf(list[i]!.index);
    if (cost < bestCost) {
      best = i;
      bestCost = cost;
    }
  }
  const chosen = list[best]!;
  return {
    ...chosen,
    selectivity: selectivityOf(chosen.mode, stats[best]),
    indexWeight: weightOf(chosen.index),
    indexChoice: 'cost',
  };
}

export function planAndExecute(
  allDocs: Document[],
  query: JsonQuery,
  indexes: Index[],
  resolveByIds: (ids: string[]) => Document[],
): PlanResult {
  const indexed = planIndexIds(query, indexes);
  if (!indexed) {
    const docs = executeJsonQuery(allDocs, query);
    return { docs, scanned: allDocs.length };
  }

  let docs = resolveByIds(indexed.ids);
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
    usedIndex: indexed.usedIndex,
    scanned: indexed.ids.length,
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

interface Candidate {
  index: Index;
  mode: 'eq' | 'range' | 'text' | 'composite' | 'geo';
  value?: unknown;
  min?: unknown;
  max?: unknown;
  text?: string;
  prefixValues?: unknown[];
  box?: {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
  };
}

function readStats(index: Index): { keys: number; docs: number } | null {
  const fn = (index as Index & { stats?: () => { keys: number; docs: number } }).stats;
  if (typeof fn !== 'function') return null;
  const stats = fn.call(index);
  if (!stats || stats.keys <= 0 || stats.docs <= 0) return null;
  return stats;
}

function weightOf(index: Index): number {
  return INDEX_WEIGHT[index.meta.type] ?? FULL_SCAN_WEIGHT;
}

function selectivityOf(
  mode: Candidate['mode'],
  stats: { keys: number; docs: number } | null,
): number {
  if (!stats) return 1;
  if (mode === 'eq' || mode === 'composite') return 1 / stats.keys;
  if (mode === 'range') return 0.3;
  if (mode === 'text') return 0.5;
  if (mode === 'geo') return 0.25;
  return 1;
}

function lookupIds(choice: Candidate, limit?: number): string[] {
  const { index, mode, value, min, max, text, prefixValues, box } = choice;
  if (mode === 'eq') return index.lookupEq(value);
  if (mode === 'range') return index.lookupRange(min, max);
  if (mode === 'text') return index.lookupText(String(text ?? ''), limit ?? 100);
  if (mode === 'composite' && prefixValues) {
    return index.lookupPrefix ? index.lookupPrefix(prefixValues) : index.lookupEq(prefixValues);
  }
  if (mode === 'geo' && box) return index.lookupGeo ? index.lookupGeo(box) : [];
  return [];
}

/**
 * 2.5 order: longest composite prefix first, otherwise the first usable
 * single-field index. Later entries exist so the cost model can compare them.
 */
function collectCandidates(
  filter: FilterCondition | undefined,
  indexes: Index[],
): Candidate[] {
  if (!filter) return [];
  const entries = Object.entries(filter).filter(([k]) => k !== '$and' && k !== '$or');
  const out: Candidate[] = [];

  const composites = indexes.filter((i) => i.meta.type === 'composite');
  let bestComposite: Candidate | null = null;
  const compositeRest: Candidate[] = [];
  for (const index of composites) {
    const fields = index.meta.fields ?? index.meta.field.split('+').filter(Boolean);
    const values: unknown[] = [];
    for (const field of fields) {
      const entry = entries.find(([key]) => key === field);
      if (!entry) break;
      const value = eqValue(entry[1]);
      if (value === undefined) break;
      values.push(value);
    }
    if (values.length === 0) continue;
    const candidate: Candidate = { index, mode: 'composite', prefixValues: values };
    if (
      !bestComposite ||
      values.length > (bestComposite.prefixValues?.length ?? 0)
    ) {
      if (bestComposite) compositeRest.push(bestComposite);
      bestComposite = candidate;
    } else {
      compositeRest.push(candidate);
    }
  }
  if (bestComposite) out.push(bestComposite, ...compositeRest);

  if (entries.length === 1) {
    const [field, condition] = entries[0]!;
    for (const index of indexes) {
      if (index.meta.field !== field || index.meta.type === 'composite') continue;
      const candidate = candidateFor(index, condition);
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

function candidateFor(index: Index, condition: unknown): Candidate | null {
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
  if (index.meta.type === 'geo' && op.$geoWithin && index.lookupGeo) {
    return { index, mode: 'geo', box: op.$geoWithin };
  }
  return null;
}

export function explainFilterMatch(
  docs: Document[],
  filter: FilterCondition,
): number {
  return docs.filter((d) => matchFilter(d, filter)).length;
}
