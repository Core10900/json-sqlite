import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type {
  FieldDef,
  FieldType,
  FilterCondition,
  FilterOp,
  FilterValue,
} from '../types/index.js';
import type { SqlStatement } from './ast.js';
import { tokenize, type Token } from './tokenize.js';

export function parseSql(sql: string): SqlStatement {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!trimmed) {
    throw new JSONSQLiteError(ErrorCode.SQL_PARSE, 'Empty SQL');
  }
  try {
    const tokens = tokenize(trimmed);
    const p = new Parser(tokens);
    const stmt = p.parseStatement();
    p.expectEof();
    return stmt;
  } catch (err) {
    if (err instanceof JSONSQLiteError) throw err;
    throw new JSONSQLiteError(
      ErrorCode.SQL_PARSE,
      err instanceof Error ? err.message : String(err),
    );
  }
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  parseStatement(): SqlStatement {
    const t = this.peek();
    if (t.kind === 'kw') {
      switch (t.value) {
        case 'SELECT':
          return this.parseSelect();
        case 'INSERT':
          return this.parseInsert();
        case 'UPDATE':
          return this.parseUpdate();
        case 'DELETE':
          return this.parseDelete();
        case 'CREATE':
          return this.parseCreate();
        case 'DROP':
          return this.parseDrop();
        case 'ALTER':
          return this.parseAlter();
        case 'SHOW':
          return this.parseShow();
        case 'DESCRIBE':
        case 'DESC':
          return this.parseDescribe();
        default:
          break;
      }
    }
    throw new JSONSQLiteError(
      ErrorCode.SQL_UNSUPPORTED,
      `Unsupported statement starting with '${t.raw || t.value}'`,
    );
  }

  private parseSelect(): SqlStatement {
    this.expectKw('SELECT');
    let columns: '*' | string[];
    if (this.matchPunct('*')) {
      columns = '*';
    } else {
      columns = [this.expectColumnRef()];
      while (this.matchPunct(',')) {
        columns.push(this.expectColumnRef());
      }
    }
    this.expectKw('FROM');
    const table = this.expectIdent();
    const alias = this.parseOptionalAlias();
    const join = this.parseJoinAfterFrom();
    let filter: FilterCondition | undefined;
    if (this.matchKw('WHERE')) {
      filter = this.parseOrExpr();
    }
    let orderBy: Record<string, 'asc' | 'desc'> | undefined;
    if (this.matchKw('ORDER')) {
      this.expectKw('BY');
      orderBy = {};
      do {
        const col = this.expectColumnRef();
        const dir = this.matchKw('DESC')
          ? 'desc'
          : this.matchKw('ASC')
            ? 'asc'
            : 'asc';
        orderBy[col] = dir;
      } while (this.matchPunct(','));
    }
    let limit: number | undefined;
    let offset: number | undefined;
    if (this.matchKw('LIMIT')) {
      limit = this.expectNumber();
    }
    if (this.matchKw('OFFSET')) {
      offset = this.expectNumber();
    }
    return {
      kind: 'select',
      table,
      alias,
      join,
      columns,
      filter,
      orderBy,
      limit,
      offset,
    };
  }

  private parseJoinAfterFrom(): import('./ast.js').JoinClause | undefined {
    let type: 'inner' | 'left' | undefined;
    if (this.matchKw('INNER')) {
      type = 'inner';
      this.expectKw('JOIN');
    } else if (this.matchKw('LEFT')) {
      this.matchKw('OUTER');
      this.expectKw('JOIN');
      type = 'left';
    } else if (this.matchKw('JOIN')) {
      type = 'inner';
    } else if (this.matchKw('RIGHT') || this.matchKw('FULL')) {
      throw new JSONSQLiteError(
        ErrorCode.SQL_UNSUPPORTED,
        'Only INNER JOIN and LEFT JOIN are supported',
      );
    } else {
      return undefined;
    }

    // Reject a second join later via expectEof / extra JOIN token
    const table = this.expectIdent();
    const alias = this.parseOptionalAlias();
    this.expectKw('ON');
    const onLeft = this.expectColumnRef();
    this.expectOp('=');
    const onRight = this.expectColumnRef();

    if (
      this.peekKw('INNER') ||
      this.peekKw('LEFT') ||
      this.peekKw('JOIN') ||
      this.peekKw('RIGHT') ||
      this.peekKw('FULL')
    ) {
      throw new JSONSQLiteError(
        ErrorCode.SQL_UNSUPPORTED,
        'Only a single JOIN is supported',
      );
    }

    return { type, table, alias, onLeft, onRight };
  }

  private parseOptionalAlias(): string | undefined {
    if (this.matchKw('AS')) {
      return this.expectIdent();
    }
    const t = this.peek();
    if (t.kind === 'ident') {
      return this.expectIdent();
    }
    return undefined;
  }

  private peekKw(kw: string): boolean {
    const t = this.peek();
    return t.kind === 'kw' && t.value === kw;
  }

  private parseInsert(): SqlStatement {
    this.expectKw('INSERT');
    this.expectKw('INTO');
    const table = this.expectIdent();
    let columns: string[] | undefined;
    if (this.matchPunct('(')) {
      columns = [this.expectIdent()];
      while (this.matchPunct(',')) columns.push(this.expectIdent());
      this.expectPunct(')');
    }
    this.expectKw('VALUES');
    const values: unknown[][] = [];
    do {
      this.expectPunct('(');
      const row: unknown[] = [this.parseValue()];
      while (this.matchPunct(',')) row.push(this.parseValue());
      this.expectPunct(')');
      values.push(row);
    } while (this.matchPunct(','));
    return { kind: 'insert', table, columns, values };
  }

  private parseUpdate(): SqlStatement {
    this.expectKw('UPDATE');
    const table = this.expectIdent();
    this.expectKw('SET');
    const set: Record<string, unknown> = {};
    do {
      const col = this.expectIdent();
      this.expectOp('=');
      set[col] = this.parseValue();
    } while (this.matchPunct(','));
    let filter: FilterCondition | undefined;
    if (this.matchKw('WHERE')) {
      filter = this.parseOrExpr();
    }
    return { kind: 'update', table, set, filter };
  }

  private parseDelete(): SqlStatement {
    this.expectKw('DELETE');
    this.expectKw('FROM');
    const table = this.expectIdent();
    let filter: FilterCondition | undefined;
    if (this.matchKw('WHERE')) {
      filter = this.parseOrExpr();
    }
    return { kind: 'delete', table, filter };
  }

  private parseCreate(): SqlStatement {
    this.expectKw('CREATE');
    this.expectKw('TABLE');
    const table = this.expectIdent();
    const fields: FieldDef[] = [];
    if (this.matchPunct('(')) {
      if (!this.checkPunct(')')) {
        do {
          fields.push(this.parseFieldDef());
        } while (this.matchPunct(','));
      }
      this.expectPunct(')');
    }
    return { kind: 'create_table', table, fields };
  }

  private parseDrop(): SqlStatement {
    this.expectKw('DROP');
    this.expectKw('TABLE');
    const table = this.expectIdent();
    return { kind: 'drop_table', table };
  }

  private parseAlter(): SqlStatement {
    this.expectKw('ALTER');
    this.expectKw('TABLE');
    const table = this.expectIdent();
    if (this.matchKw('RENAME')) {
      this.expectKw('TO');
      return { kind: 'alter_table', table, renameTo: this.expectIdent() };
    }
    if (this.matchKw('ADD')) {
      this.matchKw('COLUMN');
      return { kind: 'alter_table', table, addField: this.parseFieldDef() };
    }
    if (this.matchKw('DROP')) {
      this.matchKw('COLUMN');
      return { kind: 'alter_table', table, dropField: this.expectIdent() };
    }
    throw new JSONSQLiteError(
      ErrorCode.SQL_UNSUPPORTED,
      'ALTER TABLE supports RENAME TO / ADD COLUMN / DROP COLUMN',
    );
  }

  private parseShow(): SqlStatement {
    this.expectKw('SHOW');
    this.expectKw('TABLES');
    return { kind: 'show_tables' };
  }

  private parseDescribe(): SqlStatement {
    if (!this.matchKw('DESCRIBE') && !this.matchKw('DESC')) {
      throw new JSONSQLiteError(ErrorCode.SQL_PARSE, 'Expected DESCRIBE');
    }
    return { kind: 'describe', table: this.expectIdent() };
  }

  private parseFieldDef(): FieldDef {
    const name = this.expectIdent();
    let type: FieldType = 'any';
    if (this.peek().kind === 'ident' || this.peek().kind === 'kw') {
      const raw = this.next().value.toLowerCase();
      type = mapSqlType(raw);
    }
    return { name, type };
  }

  private parseOrExpr(): FilterCondition {
    let left = this.parseAndExpr();
    while (this.matchKw('OR')) {
      const right = this.parseAndExpr();
      left = { $or: [left, right] };
    }
    return left;
  }

  private parseAndExpr(): FilterCondition {
    let left = this.parsePredicate();
    while (this.matchKw('AND')) {
      const right = this.parsePredicate();
      left = { $and: [left, right] };
    }
    return left;
  }

  private parsePredicate(): FilterCondition {
    if (this.matchPunct('(')) {
      const inner = this.parseOrExpr();
      this.expectPunct(')');
      return inner;
    }
    const col = this.expectColumnRef();
    if (this.matchKw('IS')) {
      const negated = this.matchKw('NOT');
      this.expectKw('NULL');
      if (negated) {
        return {
          $and: [{ [col]: { $exists: true } }, { [col]: { $ne: null } }],
        } as FilterCondition;
      }
      return {
        $or: [{ [col]: null }, { [col]: { $exists: false } }],
      } as FilterCondition;
    }
    if (this.matchKw('LIKE')) {
      const v = this.parseValue();
      if (typeof v !== 'string') {
        throw new JSONSQLiteError(ErrorCode.SQL_PARSE, 'LIKE expects a string');
      }
      return { [col]: { $like: v } } as FilterCondition;
    }
    if (this.matchKw('IN')) {
      this.expectPunct('(');
      const values: unknown[] = [this.parseValue()];
      while (this.matchPunct(',')) values.push(this.parseValue());
      this.expectPunct(')');
      return { [col]: { $in: values } } as FilterCondition;
    }
    if (this.matchKw('BETWEEN')) {
      const lo = this.parseValue();
      this.expectKw('AND');
      const hi = this.parseValue();
      return {
        $and: [
          { [col]: { $gte: lo as number | string } },
          { [col]: { $lte: hi as number | string } },
        ],
      } as FilterCondition;
    }
    const opTok = this.peek();
    if (opTok.kind !== 'op') {
      throw new JSONSQLiteError(
        ErrorCode.SQL_PARSE,
        `Expected comparison operator after ${col}`,
      );
    }
    this.next();
    const val = this.parseValue() as FilterValue;
    const op = opTok.value;
    if (op === '=') return { [col]: val } as FilterCondition;
    if (op === '!=' || op === '<>') {
      return { [col]: { $ne: val } } as FilterCondition;
    }
    const filterOp: FilterOp = {};
    if (op === '>') filterOp.$gt = val as number | string;
    else if (op === '>=') filterOp.$gte = val as number | string;
    else if (op === '<') filterOp.$lt = val as number | string;
    else if (op === '<=') filterOp.$lte = val as number | string;
    else {
      throw new JSONSQLiteError(ErrorCode.SQL_PARSE, `Unknown operator ${op}`);
    }
    return { [col]: filterOp } as FilterCondition;
  }

  private parseValue(): unknown {
    const t = this.peek();
    if (t.kind === 'string') {
      this.next();
      return t.value;
    }
    if (t.kind === 'number') {
      this.next();
      return Number(t.value);
    }
    if (t.kind === 'kw') {
      if (t.value === 'NULL') {
        this.next();
        return null;
      }
      if (t.value === 'TRUE') {
        this.next();
        return true;
      }
      if (t.value === 'FALSE') {
        this.next();
        return false;
      }
    }
    throw new JSONSQLiteError(
      ErrorCode.SQL_PARSE,
      `Expected literal, got '${t.raw || t.value}'`,
    );
  }

  private peek(): Token {
    return this.tokens[this.i] ?? { kind: 'eof', value: '', raw: '' };
  }

  private next(): Token {
    const t = this.peek();
    this.i += 1;
    return t;
  }

  private matchKw(kw: string): boolean {
    const t = this.peek();
    if (t.kind === 'kw' && t.value === kw) {
      this.next();
      return true;
    }
    return false;
  }

  private expectKw(kw: string): void {
    if (!this.matchKw(kw)) {
      throw new JSONSQLiteError(
        ErrorCode.SQL_PARSE,
        `Expected ${kw}, got '${this.peek().raw || this.peek().value}'`,
      );
    }
  }

  private matchPunct(p: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === p) {
      this.next();
      return true;
    }
    return false;
  }

  private checkPunct(p: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === p;
  }

  private expectPunct(p: string): void {
    if (!this.matchPunct(p)) {
      throw new JSONSQLiteError(ErrorCode.SQL_PARSE, `Expected '${p}'`);
    }
  }

  private expectOp(op: string): void {
    const t = this.peek();
    if (t.kind === 'op' && t.value === op) {
      this.next();
      return;
    }
    throw new JSONSQLiteError(ErrorCode.SQL_PARSE, `Expected '${op}'`);
  }

  private expectIdent(): string {
    const t = this.peek();
    if (t.kind === 'ident') {
      this.next();
      return t.value;
    }
    // allow some keywords as identifiers when needed (e.g. table named "order")
    if (t.kind === 'kw') {
      this.next();
      return t.raw;
    }
    throw new JSONSQLiteError(
      ErrorCode.SQL_PARSE,
      `Expected identifier, got '${t.raw || t.value}'`,
    );
  }

  /** Identifier, optionally qualified: `col` or `alias.col`. */
  private expectColumnRef(): string {
    const first = this.expectIdent();
    if (this.matchPunct('.')) {
      return `${first}.${this.expectIdent()}`;
    }
    return first;
  }

  private expectNumber(): number {
    const t = this.peek();
    if (t.kind !== 'number') {
      throw new JSONSQLiteError(ErrorCode.SQL_PARSE, 'Expected number');
    }
    this.next();
    return Number(t.value);
  }

  expectEof(): void {
    if (this.peek().kind !== 'eof') {
      throw new JSONSQLiteError(
        ErrorCode.SQL_PARSE,
        `Unexpected token '${this.peek().raw}'`,
      );
    }
  }
}

function mapSqlType(raw: string): FieldType {
  switch (raw) {
    case 'text':
    case 'string':
    case 'varchar':
    case 'char':
      return 'string';
    case 'int':
    case 'integer':
    case 'float':
    case 'double':
    case 'real':
    case 'number':
      return 'number';
    case 'bool':
    case 'boolean':
      return 'boolean';
    case 'json':
    case 'object':
      return 'json';
    case 'any':
      return 'any';
    default:
      throw new JSONSQLiteError(
        ErrorCode.SQL_PARSE,
        `Unknown column type '${raw}' (use string|number|boolean|json|any)`,
      );
  }
}
