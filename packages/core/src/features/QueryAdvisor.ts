import type { IndexMeta } from '../index/types.js';
import type { FilterCondition, JsonQuery } from '../types/index.js';

export interface Advice {
  type: 'index' | 'structure' | 'rewrite' | 'info';
  message: string;
  suggestion?: unknown;
  /** Alternative JSONPath for the same filter. Present even when the query was not executed. */
  jsonPath?: string;
  /** Estimated from parse / optimize / indexScan / dataLoad / execute weights. No network. */
  estimatedCost?: number;
}

export interface CostEstimate {
  selectivity: number;
  indexWeight: number;
}

export function adviseQuery(
  query: JsonQuery,
  existingIndexes: IndexMeta[],
  lastDurationMs?: number,
  estimate?: CostEstimate,
  rejected?: Set<string>,
): Advice[] {
  const advice: Advice[] = [];
  const filter = query.filter;
  if (!filter) {
    advice.push({
      type: 'info',
      message: 'No filter — full collection scan',
    });
  } else {
    for (const field of Object.keys(filter)) {
      if (field === '$and' || field === '$or') continue;
      if (rejected?.has(`${query.collection}.${field}`)) continue;
      const has = existingIndexes.some(
        (i) => i.collection === query.collection && i.field === field,
      );
      if (!has) {
        const cond = filter[field];
        const type =
          cond &&
          typeof cond === 'object' &&
          !Array.isArray(cond) &&
          ('$gt' in cond || '$gte' in cond || '$lt' in cond || '$lte' in cond)
            ? 'tree'
            : cond &&
                typeof cond === 'object' &&
                !Array.isArray(cond) &&
                ('$contains' in cond || '$regex' in cond)
              ? 'inverted'
              : 'object';
        advice.push({
          type: 'index',
          message: `建议为 ${query.collection}.${field} 创建 ${type} 索引以加速查询`,
          suggestion: { collection: query.collection, field, type },
        });
      }
    }
  }

  if (query.limit === undefined) {
    advice.push({
      type: 'rewrite',
      message: '建议加 limit，避免一次拉回过大结果集',
      suggestion: { ...query, limit: 100 },
    });
  }

  if (!query.projection || query.projection.length === 0) {
    advice.push({
      type: 'rewrite',
      message: '建议加 projection，只取需要的字段',
      suggestion: {
        ...query,
        projection: query.projection ?? ['_id'],
      },
    });
  }

  if (lastDurationMs !== undefined && lastDurationMs > 50) {
    advice.push({
      type: 'structure',
      message: `最近一次类似查询耗时 ${lastDurationMs}ms，可考虑加 limit 或投影裁剪`,
      suggestion: { limit: query.limit ?? 100, projection: query.projection },
    });
  }

  const jsonPath = filterToJsonPath(query.filter);
  const selectivity = estimate?.selectivity ?? 1;
  const indexWeight = estimate?.indexWeight ?? 10;
  const estimatedCost = Number(
    (
      0.05 +
      0.05 +
      selectivity * indexWeight +
      selectivity * 2 +
      selectivity
    ).toFixed(4),
  );
  advice.push({
    type: 'rewrite',
    message:
      '替代 JSONPath 与预估代价（parse、optimize、indexScan、dataLoad、execute 加权，不访问网络）',
    jsonPath,
    estimatedCost,
    suggestion: { jsonPath, estimatedCost },
  });

  return advice;
}

/** Best-effort JSONPath for a filter. Unsupported operators fall back to `$[*]`. */
export function filterToJsonPath(filter?: FilterCondition): string {
  if (!filter || Object.keys(filter).length === 0) return '$[*]';
  const expr = filterToExpr(filter);
  if (!expr) return '$[*]';
  return `$[?(${expr})]`;
}

function filterToExpr(filter: FilterCondition): string | null {
  if ('$and' in filter && Array.isArray(filter.$and)) {
    const parts = (filter.$and as FilterCondition[]).map(filterToExpr);
    if (parts.some((part) => !part)) return null;
    return parts.join(' && ');
  }
  if ('$or' in filter && Array.isArray(filter.$or)) {
    const parts = (filter.$or as FilterCondition[]).map(filterToExpr);
    if (parts.some((part) => !part)) return null;
    return parts.join(' || ');
  }
  const parts: string[] = [];
  for (const [field, condition] of Object.entries(filter)) {
    if (field === '$and' || field === '$or' || field === '$const') continue;
    const expr = fieldExpr(field, condition);
    if (!expr) return null;
    parts.push(expr);
  }
  if (parts.length === 0) return null;
  return parts.join(' && ');
}

function fieldExpr(field: string, condition: unknown): string | null {
  const path = `@.${field}`;
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
    return `${path}==${literal(condition)}`;
  }
  const op = condition as Record<string, unknown>;
  if ('$eq' in op) return `${path}==${literal(op.$eq)}`;
  if ('$ne' in op) return `${path}!=${literal(op.$ne)}`;
  if ('$gt' in op) return `${path}>${literal(op.$gt)}`;
  if ('$gte' in op) return `${path}>=${literal(op.$gte)}`;
  if ('$lt' in op) return `${path}<${literal(op.$lt)}`;
  if ('$lte' in op) return `${path}<=${literal(op.$lte)}`;
  if ('$exists' in op) return op.$exists ? path : null;
  return null;
}

function literal(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}

export function profileStages(timings: {
  planMs: number;
  executeMs: number;
  totalMs: number;
  usedIndex?: string;
}) {
  return timings;
}

export function extractFilterFields(filter?: FilterCondition): string[] {
  if (!filter) return [];
  return Object.keys(filter).filter((k) => k !== '$and' && k !== '$or');
}
