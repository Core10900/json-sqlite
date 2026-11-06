import type { FieldDef, FieldType, FilterCondition, OrderBySpec } from '../types/index.js';

export type SqlStatement =
  | SelectStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | CreateTableStmt
  | DropTableStmt
  | AlterTableStmt
  | ShowTablesStmt
  | DescribeStmt;

export interface JoinClause {
  type: 'inner' | 'left';
  table: string;
  alias?: string;
  /** Equality join: leftField = rightField (may be qualified `alias.col`). */
  onLeft: string;
  onRight: string;
}

export type SqlAggFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface SqlAggregate {
  fn: SqlAggFn;
  /** Omitted for COUNT(*). */
  field?: string;
  alias: string;
}

export interface SelectStmt {
  kind: 'select';
  table: string;
  alias?: string;
  join?: JoinClause;
  columns: '*' | string[];
  /** When set, SELECT COUNT(*) shortcut (no JOIN, no GROUP BY). */
  aggregate?: 'count';
  /** Aggregates in the select list. Single-field GROUP BY may use any of them. */
  aggregates?: SqlAggregate[];
  /** Single-column GROUP BY. Multiple columns are rejected. */
  groupBy?: string;
  filter?: FilterCondition;
  orderBy?: OrderBySpec;
  limit?: number;
  offset?: number;
}

export interface InsertStmt {
  kind: 'insert';
  table: string;
  columns?: string[];
  values: unknown[][];
}

export interface UpdateStmt {
  kind: 'update';
  table: string;
  set: Record<string, unknown>;
  filter?: FilterCondition;
}

export interface DeleteStmt {
  kind: 'delete';
  table: string;
  filter?: FilterCondition;
}

export interface CreateTableStmt {
  kind: 'create_table';
  table: string;
  fields: FieldDef[];
}

export interface DropTableStmt {
  kind: 'drop_table';
  table: string;
}

export interface AlterTableStmt {
  kind: 'alter_table';
  table: string;
  renameTo?: string;
  addField?: FieldDef;
  dropField?: string;
}

export interface ShowTablesStmt {
  kind: 'show_tables';
}

export interface DescribeStmt {
  kind: 'describe';
  table: string;
}

export type SqlFieldType = FieldType;
