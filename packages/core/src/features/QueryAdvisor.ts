import type { IndexMeta } from '../index/types.js';
import type { FilterCondition, JsonQuery } from '../types/index.js';

export interface Advice {
  type: 'index' | 'structure' | 'rewrite' | 'info';
  message: string;
  suggestion?: unknown;
}

export function adviseQuery(
  query: JsonQuery,
  existingIndexes: IndexMeta[],
  lastDurationMs?: number,
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

  return advice;
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
