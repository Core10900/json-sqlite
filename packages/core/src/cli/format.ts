import type { Document, FieldDef, SqlResult, TableInfo } from '../types/index.js';

export function formatTables(tables: TableInfo[]): string {
  if (tables.length === 0) {
    return '(没有表)';
  }
  const rows = tables.map((t) => ({
    name: t.name,
    documents: String(t.documentCount),
    fields: t.fields?.map((f) => f.name).join(', ') || '-',
    createdAt: new Date(t.createdAt).toISOString(),
  }));
  return renderTable(['name', 'documents', 'fields', 'createdAt'], rows);
}

export function formatSchema(
  table: string,
  fields: FieldDef[],
  documentCount: number,
): string {
  const lines = [
    `表: ${table}`,
    `文档数: ${documentCount}`,
    '',
  ];
  if (fields.length === 0) {
    lines.push('(无软 Schema 字段定义 — 任意 JSON 字段均可写入)');
  } else {
    lines.push(
      renderTable(
        ['name', 'type', 'required'],
        fields.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required ? 'yes' : 'no',
        })),
      ),
    );
  }
  return lines.join('\n');
}

export function formatDocsPage(
  rows: Document[],
  columns: string[],
  page: number,
  pageSize: number,
  total: number,
): string {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const plain = rows.map((r) => {
    const o: Record<string, string> = {};
    for (const c of columns) {
      o[c] = stringifyCell(r[c]);
    }
    return o;
  });
  const table = renderTable(columns, plain);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const footer = `\n第 ${page}/${totalPages} 页 · 显示 ${from}-${to} / 共 ${total} 条`;
  return `${table}${footer}`;
}

export function formatSqlResult(result: SqlResult): string {
  switch (result.type) {
    case 'rows':
      return formatDocsPage(
        result.rows,
        result.columns,
        1,
        Math.max(result.rowCount, 1),
        result.total ?? result.rowCount,
      );
    case 'ok':
      return `OK  ${result.message ?? ''}  changes=${result.changes}${
        result.lastId ? `  lastId=${result.lastId}` : ''
      }`.trim();
    case 'tables':
      return formatTables(result.tables);
    case 'schema':
      return formatSchema(result.table, result.fields, result.documentCount);
    default:
      return JSON.stringify(result, null, 2);
  }
}

export function renderTable(
  columns: string[],
  rows: Record<string, string>[],
): string {
  if (columns.length === 0) return '(空)';
  const widths = columns.map((c) =>
    Math.min(
      40,
      Math.max(
        c.length,
        ...rows.map((r) => displayWidth(r[c] ?? '')),
      ),
    ),
  );

  const sep = `├${widths.map((w) => '─'.repeat(w + 2)).join('┼')}┤`;
  const top = `┌${widths.map((w) => '─'.repeat(w + 2)).join('┬')}┐`;
  const bottom = `└${widths.map((w) => '─'.repeat(w + 2)).join('┴')}┘`;

  const fmt = (vals: string[]) =>
    `│${vals
      .map((v, i) => ` ${pad(v, widths[i]!)} `)
      .join('│')}│`;

  const lines = [
    top,
    fmt(columns),
    sep,
    ...rows.map((r) => fmt(columns.map((c) => truncate(r[c] ?? '', widths[columns.indexOf(c)]!)))),
    bottom,
  ];
  if (rows.length === 0) {
    return [top, fmt(columns), sep, fmt(columns.map(() => '')), bottom].join(
      '\n',
    );
  }
  return lines.join('\n');
}

function stringifyCell(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function displayWidth(s: string): number {
  // rough: CJK as width 2
  let w = 0;
  for (const ch of s) {
    w += ch.codePointAt(0)! > 0xff ? 2 : 1;
  }
  return w;
}

function pad(s: string, width: number): string {
  const w = displayWidth(s);
  if (w >= width) return truncate(s, width);
  return s + ' '.repeat(width - w);
}

function truncate(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = ch.codePointAt(0)! > 0xff ? 2 : 1;
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}
