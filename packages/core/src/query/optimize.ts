import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { SqlStatement } from '../sql/ast.js';
import type { FilterCondition, JsonQuery } from '../types/index.js';

function isParam(value: unknown): value is { $param: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return Object.keys(rec).length === 1 && typeof rec.$param === 'number';
}

function isConst(filter: FilterCondition): boolean | undefined {
  if (Object.keys(filter).length !== 1 || !('$const' in filter)) return undefined;
  return typeof filter.$const === 'boolean' ? filter.$const : undefined;
}

/** Replace `$param` markers with bound values. Values are not written back into SQL text. */
export function bindValue(value: unknown, params: readonly unknown[]): unknown {
  if (Array.isArray(value)) return value.map((item) => bindValue(item, params));
  if (isParam(value)) {
    const index = value.$param;
    if (!Number.isInteger(index) || index < 0 || index >= params.length) {
      throw new JSONSQLiteError(
        ErrorCode.SQL_PARSE,
        `Missing bind parameter at index ${index}`,
      );
    }
    return params[index];
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = bindValue(child, params);
  }
  return out;
}

export function bindStatement<T extends SqlStatement>(stmt: T, params: readonly unknown[]): T {
  return bindValue(stmt, params) as T;
}

/** Drop true constant predicates and unwrap a single `$and` / `$or` child. */
export function foldFilter(filter?: FilterCondition): FilterCondition | undefined {
  if (!filter) return filter;
  const folded = foldNode(filter);
  return folded;
}

function foldNode(filter: FilterCondition): FilterCondition {
  const flag = isConst(filter);
  if (flag !== undefined) return { $const: flag } as FilterCondition;

  if ('$and' in filter && Array.isArray(filter.$and)) {
    const parts: FilterCondition[] = [];
    for (const child of filter.$and as FilterCondition[]) {
      const next = foldNode(child);
      const c = isConst(next);
      if (c === true) continue;
      if (c === false) return { $const: false } as FilterCondition;
      parts.push(next);
    }
    if (parts.length === 0) return { $const: true } as FilterCondition;
    if (parts.length === 1) return parts[0]!;
    return { $and: parts };
  }

  if ('$or' in filter && Array.isArray(filter.$or)) {
    const parts: FilterCondition[] = [];
    for (const child of filter.$or as FilterCondition[]) {
      const next = foldNode(child);
      const c = isConst(next);
      if (c === false) continue;
      if (c === true) return { $const: true } as FilterCondition;
      parts.push(next);
    }
    if (parts.length === 0) return { $const: false } as FilterCondition;
    if (parts.length === 1) return parts[0]!;
    return { $or: parts };
  }

  return filter;
}

export function foldStatement<T extends SqlStatement>(stmt: T): T {
  if (
    (stmt.kind === 'select' || stmt.kind === 'update' || stmt.kind === 'delete') &&
    stmt.filter
  ) {
    return { ...stmt, filter: foldFilter(stmt.filter) };
  }
  return stmt;
}

export function foldQuery(query: JsonQuery): JsonQuery {
  if (!query.filter) return query;
  return { ...query, filter: foldFilter(query.filter) };
}
