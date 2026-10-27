/**
 * Relative ceilings vs apps/bench/baseline.json when N matches.
 * These are regression guards, not published performance claims.
 * BENCH_SKIP_THRESHOLD=1 forces status "skip".
 */
export function evaluateThresholds(result, baseline, factors, env = process.env) {
  if (env.BENCH_SKIP_THRESHOLD === '1') {
    return { status: 'skip', reason: 'BENCH_SKIP_THRESHOLD' };
  }
  if (!baseline || baseline.N !== result.N) {
    return {
      status: 'skip',
      reason: `baseline N (${baseline?.N ?? 'none'}) differs from run N (${result.N})`,
    };
  }
  const failed = [];
  for (const [key, factor] of Object.entries(factors)) {
    if (key === 'note' || typeof factor !== 'number') continue;
    if (typeof baseline[key] !== 'number' || typeof result[key] !== 'number') {
      continue;
    }
    if (result[key] > baseline[key] * factor) failed.push(key);
  }
  if (failed.length > 0) return { status: 'fail', failed };
  return { status: 'pass' };
}
