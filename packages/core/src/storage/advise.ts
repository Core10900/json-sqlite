import type { Document } from '../types/index.js';

export type StorageMode = 'document' | 'columnar' | 'hybrid' | 'compressed';

export interface StorageAdvice {
  collection: string;
  /** Suggested layout. This call does not apply it. */
  suggestion: StorageMode;
  currentMode: StorageMode;
  applied: false;
  /** Distinct value counts for top-level fields. Not the field values. */
  cardinality: Record<string, number>;
  nestingDepth: number;
  /** How many queries filtered on each field name. Values are counts, not document text. */
  filterHistogram: Record<string, number>;
  compressionThreshold: number;
  maxBytes: number;
}

const SYSTEM = new Set(['_id', '_version', '_createdAt', '_updatedAt']);

function nesting(value: unknown, depth: number): number {
  if (!value || typeof value !== 'object') return depth;
  if (Array.isArray(value)) {
    let max = depth + 1;
    for (const item of value) max = Math.max(max, nesting(item, depth + 1));
    return max;
  }
  let max = depth + 1;
  for (const child of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, nesting(child, depth + 1));
  }
  return max;
}

/**
 * Recommend a storage mode from cardinality, nesting depth, the filter-field
 * histogram, and the compression threshold. Never mutates the table.
 * `compressed` means a large document would live in a compressed block and
 * still read back like document mode.
 */
export function adviseStorage(input: {
  collection: string;
  docs: Document[];
  currentMode: StorageMode;
  filterHistogram: Record<string, number>;
  compressionThreshold: number;
}): StorageAdvice {
  const cardinality: Record<string, number> = {};
  const sets = new Map<string, Set<string>>();
  let nestingDepth = 0;
  let maxBytes = 0;
  for (const doc of input.docs) {
    maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(doc)));
    nestingDepth = Math.max(nestingDepth, nesting(doc, 0));
    for (const [key, value] of Object.entries(doc)) {
      if (SYSTEM.has(key)) continue;
      let set = sets.get(key);
      if (!set) {
        set = new Set();
        sets.set(key, set);
      }
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        set.add(JSON.stringify(value));
      } else {
        set.add('nested');
      }
    }
  }
  for (const [key, set] of sets) cardinality[key] = set.size;

  const flatFiltered = Object.keys(input.filterHistogram).filter((field) => !field.includes('.'));
  const scalar = Object.entries(cardinality).filter(([, count]) => count > 0);
  let suggestion: StorageMode = 'document';
  if (input.docs.length > 0 && maxBytes >= input.compressionThreshold) {
    suggestion = 'compressed';
  } else if (nestingDepth >= 3 && flatFiltered.length > 0) {
    suggestion = 'hybrid';
  } else if (
    input.docs.length >= 4 &&
    nestingDepth <= 2 &&
    scalar.some(([, count]) => count / input.docs.length <= 0.5)
  ) {
    suggestion = 'columnar';
  }

  return {
    collection: input.collection,
    suggestion,
    currentMode: input.currentMode,
    applied: false,
    cardinality,
    nestingDepth,
    filterHistogram: { ...input.filterHistogram },
    compressionThreshold: input.compressionThreshold,
    maxBytes,
  };
}
