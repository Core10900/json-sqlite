import type { Document, IndexType } from '../types/index.js';

export interface AutoSelectSample {
  /** Distinct values / total (0–1). Low → object index. */
  cardinalityRatio?: number;
  /** Share of values that are numbers. */
  numericRatio?: number;
  /** Average string length when string-like. */
  avgStringLength?: number;
  /** Number of filter fields (multi → composite candidate). */
  fieldCount?: number;
}

/**
 * Heuristic index-type picker (1.7).
 * - multi-field → composite
 * - low cardinality → object
 * - ordered numeric → tree
 * - long text → inverted
 * - default → object
 */
export function autoSelectIndexType(
  sample: AutoSelectSample | Document[] = {},
  field?: string | string[],
): IndexType {
  if (Array.isArray(field) && field.length > 1) return 'composite';
  if (Array.isArray(sample)) {
    return autoSelectFromDocs(sample, Array.isArray(field) ? field[0] : field);
  }

  const s = sample;
  if ((s.fieldCount ?? 1) > 1) return 'composite';
  if (s.cardinalityRatio !== undefined && s.cardinalityRatio < 0.05) {
    return 'object';
  }
  if (s.numericRatio !== undefined && s.numericRatio >= 0.8) {
    return 'tree';
  }
  if (s.avgStringLength !== undefined && s.avgStringLength >= 40) {
    return 'inverted';
  }
  if (s.cardinalityRatio !== undefined && s.cardinalityRatio < 0.2) {
    return 'object';
  }
  return 'object';
}

function autoSelectFromDocs(docs: Document[], field?: string): IndexType {
  if (!field || docs.length === 0) return 'object';
  const values = docs.map((d) => d[field]);
  const distinct = new Set(values.map((v) => JSON.stringify(v))).size;
  const cardinalityRatio = distinct / docs.length;
  let numeric = 0;
  let strLen = 0;
  let strCount = 0;
  for (const v of values) {
    if (typeof v === 'number') numeric += 1;
    if (typeof v === 'string') {
      strCount += 1;
      strLen += v.length;
    }
  }
  return autoSelectIndexType({
    cardinalityRatio,
    numericRatio: numeric / values.length,
    avgStringLength: strCount ? strLen / strCount : 0,
    fieldCount: 1,
  });
}
