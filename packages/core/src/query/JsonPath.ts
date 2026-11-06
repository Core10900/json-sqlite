import type { Document } from '../types/index.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';

/**
 * JSONPath subset. Filters are an expression tree, never `new Function`.
 * Same path text returns the same tree from the LRU.
 *
 * Supported: `$.a.b`, `$[*].a`, `$[?(@.age>18)]`, `$[?(@.age>18)].name`,
 * existence `@.field`, comparisons `= == != > >= < <=`, `&&` and `||`.
 * Rejected: recursive descent `..`, scripts and calls.
 */

type CmpOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

type Expr =
  | { type: 'exists'; path: string[] }
  | { type: 'cmp'; path: string[]; op: CmpOp; value: unknown }
  | { type: 'and'; items: Expr[] }
  | { type: 'or'; items: Expr[] };

export interface JsonPathTree {
  /** Field tail after an optional filter. Empty means the document itself. */
  filter?: Expr;
  /** When there is no filter, `star` selects each root element (the documents). */
  star: boolean;
  fields: string[];
}

const CACHE_MAX = 128;
const cache = new Map<string, JsonPathTree>();

export function jsonPathTree(path: string): JsonPathTree {
  const key = path.trim();
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const tree = parseJsonPath(key);
  cache.set(key, tree);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return tree;
}

export function selectJsonPath(docs: Document[], path: string): unknown[] {
  const tree = jsonPathTree(path);
  let rows: unknown[] = docs;
  if (tree.filter) {
    rows = docs.filter((doc) => evalExpr(doc, tree.filter!));
  }
  if (tree.fields.length === 0) return rows;
  return rows.map((row) => readPath(row, tree.fields));
}

function parseJsonPath(path: string): JsonPathTree {
  if (!path.startsWith('$')) {
    throw pathError(`Invalid JSONPath (must start with $): ${path}`);
  }
  if (path.includes('..')) {
    throw pathError('Unsupported JSONPath recursive descent (..)');
  }
  const parser = new PathParser(path);
  parser.expect('$');
  let filter: Expr | undefined;
  let star = false;
  if (parser.peek() === '[') {
    parser.next();
    if (parser.peek() === '*') {
      parser.next();
      parser.expect(']');
      star = true;
    } else if (parser.peek() === '?') {
      parser.next();
      parser.expect('(');
      filter = parser.parseOr();
      parser.expect(')');
      parser.expect(']');
      star = true;
    } else {
      throw pathError(`Unsupported JSONPath script or syntax in: ${path}`);
    }
  }
  const fields: string[] = [];
  while (parser.peek() === '.') {
    parser.next();
    if (parser.peek() === '.') {
      throw pathError('Unsupported JSONPath recursive descent (..)');
    }
    fields.push(parser.parseIdent());
    if (parser.peek() === '(') {
      throw pathError('Unsupported JSONPath script');
    }
  }
  parser.skip();
  if (!parser.done()) {
    const rest = parser.rest();
    if (rest.includes('(') || rest.includes(')')) {
      throw pathError('Unsupported JSONPath script');
    }
    throw pathError(`Unsupported JSONPath script or syntax in: ${path}`);
  }
  if (!star && !filter && fields.length === 0 && path !== '$') {
    throw pathError(`Unsupported JSONPath script or syntax in: ${path}`);
  }
  return { filter, star: star || fields.length > 0 || path === '$', fields };
}

class PathParser {
  private i = 0;
  constructor(private readonly text: string) {}

  done(): boolean {
    this.skip();
    return this.i >= this.text.length;
  }

  rest(): string {
    return this.text.slice(this.i);
  }

  peek(): string {
    this.skip();
    return this.text[this.i] ?? '';
  }

  next(): string {
    this.skip();
    const ch = this.text[this.i] ?? '';
    this.i += 1;
    return ch;
  }

  expect(ch: string): void {
    const got = this.next();
    if (got !== ch) throw pathError(`Unsupported JSONPath script or syntax near '${got || 'end'}'`);
  }

  skip(): void {
    while (this.i < this.text.length && /\s/.test(this.text[this.i]!)) this.i += 1;
  }

  parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek() === '|' && this.text[this.i + 1] === '|') {
      this.i += 2;
      const right = this.parseAnd();
      left = { type: 'or', items: [left, right] };
    }
    return left;
  }

  parseAnd(): Expr {
    let left = this.parsePrimary();
    while (this.peek() === '&' && this.text[this.i + 1] === '&') {
      this.i += 2;
      const right = this.parsePrimary();
      left = { type: 'and', items: [left, right] };
    }
    return left;
  }

  parsePrimary(): Expr {
    if (this.peek() === '(') {
      this.next();
      const inner = this.parseOr();
      this.expect(')');
      return inner;
    }
    if (this.peek() !== '@') throw pathError('Unsupported JSONPath script');
    this.next();
    const path: string[] = [];
    if (this.peek() !== '.') throw pathError('Unsupported JSONPath script');
    while (this.peek() === '.') {
      this.next();
      if (this.peek() === '.') throw pathError('Unsupported JSONPath recursive descent (..)');
      path.push(this.parseIdent());
    }
    if (this.peek() === '(') throw pathError('Unsupported JSONPath script');
    const op = this.parseOp();
    if (!op) return { type: 'exists', path };
    const value = this.parseLiteral();
    return { type: 'cmp', path, op, value };
  }

  parseIdent(): string {
    this.skip();
    const start = this.i;
    if (!/[A-Za-z_]/.test(this.text[this.i] ?? '')) {
      throw pathError('Unsupported JSONPath script');
    }
    this.i += 1;
    while (/[A-Za-z0-9_]/.test(this.text[this.i] ?? '')) this.i += 1;
    return this.text.slice(start, this.i);
  }

  parseOp(): CmpOp | null {
    this.skip();
    const two = this.text.slice(this.i, this.i + 2);
    if (two === '==' || two === '!=') {
      this.i += 2;
      return two === '==' ? 'eq' : 'ne';
    }
    if (two === '>=') {
      this.i += 2;
      return 'gte';
    }
    if (two === '<=') {
      this.i += 2;
      return 'lte';
    }
    const ch = this.text[this.i];
    if (ch === '=') {
      this.i += 1;
      return 'eq';
    }
    if (ch === '>') {
      this.i += 1;
      return 'gt';
    }
    if (ch === '<') {
      this.i += 1;
      return 'lt';
    }
    return null;
  }

  parseLiteral(): unknown {
    this.skip();
    const ch = this.text[this.i] ?? '';
    if (ch === '"' || ch === "'") {
      const quote = ch;
      this.i += 1;
      let out = '';
      while (this.i < this.text.length && this.text[this.i] !== quote) {
        if (this.text[this.i] === '\\') {
          this.i += 1;
          out += this.text[this.i] ?? '';
          this.i += 1;
          continue;
        }
        out += this.text[this.i];
        this.i += 1;
      }
      if (this.text[this.i] !== quote) throw pathError('Unsupported JSONPath script');
      this.i += 1;
      return out;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = this.i;
      if (ch === '-') this.i += 1;
      while (/[0-9.]/.test(this.text[this.i] ?? '')) this.i += 1;
      const raw = this.text.slice(start, this.i);
      if (!/^-?\d+(\.\d+)?$/.test(raw)) throw pathError('Unsupported JSONPath script');
      return Number(raw);
    }
    if (this.text.startsWith('true', this.i)) {
      this.i += 4;
      return true;
    }
    if (this.text.startsWith('false', this.i)) {
      this.i += 5;
      return false;
    }
    if (this.text.startsWith('null', this.i)) {
      this.i += 4;
      return null;
    }
    throw pathError('Unsupported JSONPath script');
  }
}

function pathError(message: string): JSONSQLiteError {
  const text = message.startsWith('[')
    ? message
    : `[${ErrorCode.JSONPATH_UNSUPPORTED}] ${message}`;
  return new JSONSQLiteError(ErrorCode.JSONPATH_UNSUPPORTED, text);
}

function evalExpr(doc: Document, expr: Expr): boolean {
  switch (expr.type) {
    case 'exists':
      return readPath(doc, expr.path) !== undefined;
    case 'cmp':
      return compareOp(readPath(doc, expr.path), expr.op, expr.value);
    case 'and':
      return expr.items.every((item) => evalExpr(doc, item));
    case 'or':
      return expr.items.some((item) => evalExpr(doc, item));
    default:
      return false;
  }
}

function compareOp(value: unknown, op: CmpOp, expected: unknown): boolean {
  if (op === 'eq') return same(value, expected);
  if (op === 'ne') return !same(value, expected);
  const cmp = compare(value, expected);
  if (op === 'gt') return cmp > 0;
  if (op === 'gte') return cmp >= 0;
  if (op === 'lt') return cmp < 0;
  return cmp <= 0;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return String(a).localeCompare(String(b));
}

function readPath(obj: unknown, fields: string[]): unknown {
  let cur = obj;
  for (const field of fields) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[field];
  }
  return cur;
}
