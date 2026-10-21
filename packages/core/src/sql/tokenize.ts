export type TokenKind =
  | 'ident'
  | 'number'
  | 'string'
  | 'op'
  | 'punct'
  | 'kw'
  | 'eof';

export interface Token {
  kind: TokenKind;
  value: string;
  raw: string;
}

const KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'ORDER',
  'BY',
  'ASC',
  'DESC',
  'LIMIT',
  'OFFSET',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'CREATE',
  'TABLE',
  'DROP',
  'ALTER',
  'RENAME',
  'TO',
  'ADD',
  'COLUMN',
  'SHOW',
  'TABLES',
  'DESCRIBE',
  'DESC',
  'AND',
  'OR',
  'NOT',
  'LIKE',
  'NULL',
  'TRUE',
  'FALSE',
  'AS',
  'IN',
  'IS',
  'BETWEEN',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'OUTER',
  'ON',
  'COUNT',
]);

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = sql;

  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      let val = '';
      while (i < s.length) {
        if (s[i] === quote) {
          if (s[i + 1] === quote) {
            val += quote;
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        val += s[i];
        i += 1;
      }
      tokens.push({ kind: 'string', value: val, raw: val });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j]!)) j += 1;
      const raw = s.slice(i, j);
      tokens.push({ kind: 'number', value: raw, raw });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j]!)) j += 1;
      const raw = s.slice(i, j);
      const upper = raw.toUpperCase();
      if (KEYWORDS.has(upper)) {
        tokens.push({ kind: 'kw', value: upper, raw });
      } else {
        tokens.push({ kind: 'ident', value: raw, raw });
      }
      i = j;
      continue;
    }
    // multi-char ops
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '<>', '!='].includes(two)) {
      tokens.push({ kind: 'op', value: two, raw: two });
      i += 2;
      continue;
    }
    if ('=<>'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch, raw: ch });
      i += 1;
      continue;
    }
    if ('(),.*;'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, raw: ch });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }

  tokens.push({ kind: 'eof', value: '', raw: '' });
  return tokens;
}
