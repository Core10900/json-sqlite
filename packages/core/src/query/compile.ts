import type { Document, FilterCondition, FilterOp } from '../types/index.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { matchFilter } from './JsonQuery.js';

const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How many whitelist predicates this process has compiled. Default queries stay at 0. */
export let whitelistCompilations = 0;

/** Source of the last whitelist compilation. Bound values are not in this string. */
export let lastCompiledSource: string | null = null;

const REJECT =
  'compileFilters rejects user source strings; only engine whitelist operators may be compiled';

/**
 * Refuse to compile a caller-supplied string. The engine never concatenates
 * that string into a function body.
 */
export function compileUserSource(source: string): never {
  void source;
  throw new JSONSQLiteError(ErrorCode.INVALID_CONFIG, REJECT);
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return String(a).localeCompare(String(b));
}

function isOp(value: unknown): value is FilterOp {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Compile a flat whitelist filter. Returns null when the shape is not a
 * simple conjunction the engine knows how to compile; the caller interprets.
 * User values are closed over as `v[i]` and never interpolated into the source.
 */
export function compileWhitelistFilter(
  filter: FilterCondition | string,
): ((doc: Document) => boolean) | null {
  if (typeof filter === 'string') compileUserSource(filter);
  if ('$and' in filter || '$or' in filter || '$const' in filter) return null;

  const values: unknown[] = [];
  const checks: string[] = [];

  for (const [field, condition] of Object.entries(filter)) {
    if (!SAFE_FIELD.test(field)) return null;
    const fieldLit = JSON.stringify(field);
    if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
      values.push(condition);
      checks.push(`ops.eq(doc[${fieldLit}], v[${values.length - 1}])`);
      continue;
    }
    if (!isOp(condition)) return null;
    const op = condition;
    const keys = Object.keys(op);
    if (keys.length !== 1) return null;
    const key = keys[0]!;
    if (key === '$eq') {
      values.push(op.$eq);
      checks.push(`ops.eq(doc[${fieldLit}], v[${values.length - 1}])`);
    } else if (key === '$ne') {
      values.push(op.$ne);
      checks.push(`!ops.eq(doc[${fieldLit}], v[${values.length - 1}])`);
    } else if (key === '$gt') {
      values.push(op.$gt);
      checks.push(`ops.cmp(doc[${fieldLit}], v[${values.length - 1}]) > 0`);
    } else if (key === '$gte') {
      values.push(op.$gte);
      checks.push(`ops.cmp(doc[${fieldLit}], v[${values.length - 1}]) >= 0`);
    } else if (key === '$lt') {
      values.push(op.$lt);
      checks.push(`ops.cmp(doc[${fieldLit}], v[${values.length - 1}]) < 0`);
    } else if (key === '$lte') {
      values.push(op.$lte);
      checks.push(`ops.cmp(doc[${fieldLit}], v[${values.length - 1}]) <= 0`);
    } else if (key === '$exists') {
      values.push(Boolean(op.$exists));
      checks.push(
        `(v[${values.length - 1}] ? doc[${fieldLit}] !== undefined : doc[${fieldLit}] === undefined)`,
      );
    } else {
      return null;
    }
  }

  if (checks.length === 0) return null;
  const source = `"use strict"; return ${checks.join(' && ')};`;
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0 && source.includes(value)) {
      throw new JSONSQLiteError(ErrorCode.INVALID_CONFIG, REJECT);
    }
  }

  whitelistCompilations += 1;
  lastCompiledSource = source;
  const ops = {
    eq: (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b),
    cmp,
  };
  const fn = new Function('doc', 'v', 'ops', source) as (
    doc: Document,
    v: unknown[],
    ops: { eq: (a: unknown, b: unknown) => boolean; cmp: (a: unknown, b: unknown) => number },
  ) => boolean;
  return (doc) => fn(doc, values, ops);
}

/** Interpreter fallback used when compilation is off or the filter is not a whitelist shape. */
export function interpretFilter(filter: FilterCondition): (doc: Document) => boolean {
  return (doc) => matchFilter(doc, filter);
}
