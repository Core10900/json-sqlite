import type { Document, FilterCondition } from '../types/index.js';
import { matchFilter } from './JsonQuery.js';

export type AggregateOp = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'push';

export interface AggregateField {
  op: AggregateOp;
  field?: string;
}

export type AggregateStage =
  | { type: 'match'; filter: FilterCondition }
  | { type: 'group'; by: string; fields: Record<string, AggregateField> }
  | { type: 'sort'; orderBy: Record<string, 'asc' | 'desc'> }
  | { type: 'limit'; limit: number }
  | { type: 'project'; fields: string[] }
  | { type: 'unwind'; path: string; /** Keep docs with empty/missing array */ preserveNullAndEmpty?: boolean }
  | {
      type: 'lookup';
      /** Foreign collection name (resolved via AggregateContext.getCollection). */
      from: string;
      /** Local field on current docs. */
      localField: string;
      /** Field on foreign docs. */
      foreignField: string;
      /** Output array field name. */
      as: string;
    };

export interface AggregateContext {
  getCollection?: (name: string) => Document[];
}

export function executeAggregate(
  docs: Document[],
  pipeline: AggregateStage[],
  ctx: AggregateContext = {},
): unknown[] {
  let current: unknown[] = docs;
  for (const stage of pipeline) {
    current = runStage(current, stage, ctx);
  }
  return current;
}

function runStage(
  data: unknown[],
  stage: AggregateStage,
  ctx: AggregateContext,
): unknown[] {
  switch (stage.type) {
    case 'match':
      return (data as Document[]).filter((d) => matchFilter(d, stage.filter));
    case 'group':
      return groupBy(data as Document[], stage.by, stage.fields);
    case 'sort': {
      const entries = Object.entries(stage.orderBy);
      return [...data].sort((a, b) => {
        for (const [field, dir] of entries) {
          const av = (a as Record<string, unknown>)[field];
          const bv = (b as Record<string, unknown>)[field];
          const cmp =
            typeof av === 'number' && typeof bv === 'number'
              ? av - bv
              : String(av).localeCompare(String(bv));
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }
    case 'limit':
      return data.slice(0, stage.limit);
    case 'project':
      return data.map((item) => {
        const src = item as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const f of stage.fields) out[f] = src[f];
        return out;
      });
    case 'unwind':
      return unwind(data as Document[], stage.path, stage.preserveNullAndEmpty);
    case 'lookup':
      return lookup(
        data as Document[],
        stage,
        ctx.getCollection?.(stage.from) ?? [],
      );
    default:
      return data;
  }
}

function unwind(
  docs: Document[],
  path: string,
  preserveNullAndEmpty?: boolean,
): Document[] {
  const out: Document[] = [];
  for (const doc of docs) {
    const raw = doc[path];
    if (!Array.isArray(raw) || raw.length === 0) {
      if (preserveNullAndEmpty) {
        out.push({ ...doc, [path]: Array.isArray(raw) ? null : raw ?? null });
      }
      continue;
    }
    for (const item of raw) {
      out.push({ ...doc, [path]: item });
    }
  }
  return out;
}

function lookup(
  docs: Document[],
  stage: Extract<AggregateStage, { type: 'lookup' }>,
  foreign: Document[],
): Document[] {
  const hash = new Map<string, Document[]>();
  for (const f of foreign) {
    const key = JSON.stringify(f[stage.foreignField]);
    const list = hash.get(key) ?? [];
    list.push(f);
    hash.set(key, list);
  }
  return docs.map((doc) => {
    const key = JSON.stringify(doc[stage.localField]);
    const matches = hash.get(key) ?? [];
    return { ...doc, [stage.as]: matches.map((m) => ({ ...m })) };
  });
}

function groupBy(
  docs: Document[],
  by: string,
  fields: Record<string, AggregateField>,
): Record<string, unknown>[] {
  const groups = new Map<string, Document[]>();
  for (const doc of docs) {
    const key = JSON.stringify(doc[by]);
    const list = groups.get(key) ?? [];
    list.push(doc);
    groups.set(key, list);
  }

  const out: Record<string, unknown>[] = [];
  for (const [key, items] of groups) {
    const row: Record<string, unknown> = { _id: JSON.parse(key) };
    for (const [name, cfg] of Object.entries(fields)) {
      const values = items.map((i) =>
        cfg.field ? i[cfg.field] : undefined,
      );
      switch (cfg.op) {
        case 'count':
          row[name] = items.length;
          break;
        case 'sum':
          row[name] = values.reduce<number>(
            (a, b) => a + (typeof b === 'number' ? b : 0),
            0,
          );
          break;
        case 'avg': {
          const nums = values.filter((v): v is number => typeof v === 'number');
          row[name] = nums.length
            ? nums.reduce((a, b) => a + b, 0) / nums.length
            : 0;
          break;
        }
        case 'min':
          row[name] = Math.min(
            ...values.filter((v): v is number => typeof v === 'number'),
          );
          break;
        case 'max':
          row[name] = Math.max(
            ...values.filter((v): v is number => typeof v === 'number'),
          );
          break;
        case 'push':
          row[name] = values;
          break;
      }
    }
    out.push(row);
  }
  return out;
}
