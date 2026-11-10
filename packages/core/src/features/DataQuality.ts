import type { Document } from '../types/index.js';

export interface QualitySuggestion {
  type:
    | 'completeness'
    | 'uniqueness'
    | 'accuracy'
    | 'consistency'
    | 'timeliness';
  message: string;
  details?: unknown;
}

export interface QualityReport {
  completeness: number;
  uniqueness: number;
  accuracy: number;
  consistency: number;
  timeliness: number;
  suggestions: QualitySuggestion[];
}

export interface AutoFixResult {
  fixed: number;
  skipped: number;
  actions: string[];
}

/**
 * Five quality scores. Suggestions never write to the database.
 * `autoFix` is a separate explicit API.
 */
export function analyzeQuality(
  docs: Document[],
  requiredFields: string[] = [],
  opts?: { now?: number; freshMs?: number },
): QualityReport {
  if (docs.length === 0) {
    return {
      completeness: 1,
      uniqueness: 1,
      accuracy: 1,
      consistency: 1,
      timeliness: 1,
      suggestions: [],
    };
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

  let accurate = 0;
  let accuracyTotal = 0;
  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      if (key.startsWith('_')) continue;
      if (typeof value !== 'number') continue;
      accuracyTotal += 1;
      if (Number.isFinite(value)) accurate += 1;
    }
  }
  const accuracy = accuracyTotal === 0 ? 1 : accurate / accuracyTotal;

  let consistent = 0;
  for (const doc of docs) {
    const ok =
      typeof doc._id === 'string' &&
      typeof doc._version === 'number' &&
      typeof doc._createdAt === 'number' &&
      typeof doc._updatedAt === 'number' &&
      doc._updatedAt >= doc._createdAt;
    if (ok) consistent += 1;
  }
  const consistency = consistent / docs.length;

  const now = opts?.now ?? Date.now();
  const freshMs = opts?.freshMs ?? 7 * 86_400_000;
  let fresh = 0;
  for (const doc of docs) {
    if (typeof doc._updatedAt === 'number' && now - doc._updatedAt <= freshMs) {
      fresh += 1;
    }
  }
  const timeliness = fresh / docs.length;

  const suggestions: QualitySuggestion[] = [];
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
  if (accuracy < 0.9) {
    suggestions.push({
      type: 'accuracy',
      message: '存在非有限数值字段',
      details: { accuracy },
    });
  }
  if (consistency < 1) {
    suggestions.push({
      type: 'consistency',
      message: '系统字段不一致（_id/_version/_createdAt/_updatedAt）',
      details: { consistency },
    });
  }
  if (timeliness < 0.5) {
    suggestions.push({
      type: 'timeliness',
      message: '近期更新比例偏低',
      details: { timeliness, freshMs },
    });
  }

  return {
    completeness,
    uniqueness,
    accuracy,
    consistency,
    timeliness,
    suggestions,
  };
}

/**
 * Explicit repair helper. Open and timers must not call this.
 * Only fills missing required string fields with empty string for
 * reporting demos — callers decide whether to persist.
 */
export function autoFixDocs(
  docs: Document[],
  requiredFields: string[] = [],
): { docs: Document[]; result: AutoFixResult } {
  const actions: string[] = [];
  let fixed = 0;
  let skipped = 0;
  const out = docs.map((doc) => {
    const next = { ...doc };
    let changed = false;
    for (const field of requiredFields) {
      if (next[field] === undefined || next[field] === null) {
        next[field] = '';
        actions.push(`fill ${doc._id}.${field}`);
        changed = true;
      }
    }
    if (changed) fixed += 1;
    else skipped += 1;
    return next;
  });
  return { docs: out, result: { fixed, skipped, actions } };
}
