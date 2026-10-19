import type { Document } from '../types/index.js';

/**
 * Minimal safe JSONPath subset:
 * - `$.field`
 * - `$.a.b`
 * - `$[*].field` over array root (document list → values)
 * No script expressions / recursive descent to avoid injection.
 */
export function selectJsonPath(docs: Document[], path: string): unknown[] {
  const normalized = path.trim();
  if (!normalized.startsWith('$')) {
    throw new Error(`Invalid JSONPath (must start with $): ${path}`);
  }
  if (/[()=!]/.test(normalized) || normalized.includes('..')) {
    throw new Error(`Unsupported JSONPath features in: ${path}`);
  }

  // $[*].field or $.field
  if (normalized.startsWith('$[*]')) {
    const rest = normalized.slice(4); // .field...
    const fields = rest.startsWith('.')
      ? rest.slice(1).split('.').filter(Boolean)
      : [];
    return docs.map((doc) => getPath(doc, fields));
  }

  if (normalized === '$') return docs;
  const fields = normalized.slice(2).split('.').filter(Boolean);
  return docs.map((doc) => getPath(doc, fields));
}

function getPath(obj: unknown, fields: string[]): unknown {
  let cur: unknown = obj;
  for (const f of fields) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[f];
  }
  return cur;
}
