export function evaluateThresholds(
  result: { N?: number; [key: string]: unknown },
  baseline: { N?: number; [key: string]: unknown } | null,
  factors: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): { status: 'pass' | 'fail' | 'skip'; reason?: string; failed?: string[] };
