/** Convert a SQL LIKE pattern to a RegExp (`%` any, `_` one char, `\` escapes). */
export function likePatternToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      out += escapeRegex(pattern[i + 1]!);
      i += 1;
      continue;
    }
    if (c === '%') {
      out += '.*';
      continue;
    }
    if (c === '_') {
      out += '.';
      continue;
    }
    out += escapeRegex(c);
  }
  out += '$';
  return new RegExp(out, 's');
}

export function matchLike(value: unknown, pattern: string): boolean {
  if (typeof value !== 'string') return false;
  return likePatternToRegExp(pattern).test(value);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
