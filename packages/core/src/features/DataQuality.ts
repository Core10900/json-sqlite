import type { Document } from '../types/index.js';

export interface QualityReport {
  completeness: number;
  uniqueness: number;
  suggestions: { type: string; message: string; details?: unknown }[];
}

export function analyzeQuality(
  docs: Document[],
  requiredFields: string[] = [],
): QualityReport {
  if (docs.length === 0) {
    return { completeness: 1, uniqueness: 1, suggestions: [] };
  }

  let present = 0;
  let total = 0;
  for (const field of requiredFields) {
    for (const doc of docs) {
      total += 1;
      if (doc[field] !== undefined && doc[field] !== null && doc[field] !== '') {
        present += 1;
      }
    }
  }
  const completeness =
    requiredFields.length === 0 ? 1 : present / Math.max(total, 1);

  const ids = new Set(docs.map((d) => d._id));
  const uniqueness = ids.size / docs.length;

  const suggestions: QualityReport['suggestions'] = [];
  if (completeness < 0.9) {
    suggestions.push({
      type: 'completeness',
      message: '必填字段完整度偏低',
      details: { completeness, requiredFields },
    });
  }
  if (uniqueness < 1) {
    suggestions.push({
      type: 'uniqueness',
      message: '存在重复 _id',
    });
  }

  return { completeness, uniqueness, suggestions };
}
