import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '@webofcat/jsonsqlite';
import { evaluateThresholds } from './threshold.mjs';

const N = Number(process.env.BENCH_N ?? 2000);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-bench-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');
const factorsPath = path.join(here, 'thresholds.json');

function hr() {
  return process.hrtime.bigint();
}
function ms(start) {
  return Number(hr() - start) / 1e6;
}

const db = await open({
  storagePath: dir,
  lazyCollections: true,
  persistIndexes: true,
});

const tInsert = hr();
const batch = [];
for (let i = 0; i < N; i++) {
  batch.push({ name: `u${i}`, age: i % 100, bio: `hello world ${i}` });
  if (batch.length === 500) {
    await db.insert('users', batch.splice(0, batch.length));
  }
}
if (batch.length) await db.insert('users', batch);
const insertMs = ms(tInsert);

await db.createIndex('users', 'age', 'tree');
await db.createIndex('users', 'name', 'object');

const tPoint = hr();
const pointN = Math.min(1000, N);
for (let i = 0; i < pointN; i++) {
  await db.query({ collection: 'users', filter: { name: `u${i % N}` } });
}
const pointMs = ms(tPoint) / pointN;

const tRange = hr();
await db.query({
  collection: 'users',
  filter: { age: { $gte: 10, $lte: 20 } },
});
const rangeMs = ms(tRange);

const tConc = hr();
await Promise.all(
  Array.from({ length: Math.min(20, N) }, (_, i) =>
    db.query({ collection: 'users', filter: { name: `u${i}` } }),
  ),
);
const concurrentReadMs = ms(tConc);

const u0 = (await db.query({ collection: 'users', filter: { name: 'u0' } }))[0];
await db.insert('orders', [
  { userId: u0._id, total: 10 },
  { userId: u0._id, total: 20 },
]);
const tJoin = hr();
await db.run(
  `SELECT u.name, o.total FROM users u INNER JOIN orders o ON u._id = o.userId WHERE o.total > 5 LIMIT 10`,
);
const joinMs = ms(tJoin);

await db.close();

const tOpen = hr();
const db2 = await open({
  storagePath: dir,
  lazyCollections: true,
  persistIndexes: true,
});
const reopenMs = ms(tOpen);
const served = db2.indexPersistence().servedFromSegment.includes('users');
await db2.query({ collection: 'users', filter: { name: 'u0' } });
const servedAfterQuery = db2
  .indexPersistence()
  .servedFromSegment.includes('users');
const tRebuild = hr();
await db2.rebuildIndexes('users');
const rebuildMs = ms(tRebuild);
const metrics = db2.getMetrics();
await db2.close();

let baseline = null;
try {
  baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
} catch {
  baseline = null;
}
const factors = JSON.parse(await fs.readFile(factorsPath, 'utf8'));

const result = {
  version: '1.8.0',
  N,
  insertMs: Number(insertMs.toFixed(2)),
  insertPerSec: Math.round(N / (insertMs / 1000)),
  pointQueryAvgMs: Number(pointMs.toFixed(4)),
  rangeQueryMs: Number(rangeMs.toFixed(2)),
  concurrentReadMs: Number(concurrentReadMs.toFixed(2)),
  joinMs: Number(joinMs.toFixed(2)),
  reopenMs: Number(reopenMs.toFixed(2)),
  rebuildMs: Number(rebuildMs.toFixed(2)),
  indexServedFromSegment: served || servedAfterQuery,
  metrics,
  recordedAt: new Date().toISOString(),
};
result.threshold = evaluateThresholds(result, baseline, factors);

console.log(JSON.stringify(result, null, 2));

if (process.env.BENCH_OUT) {
  await fs.writeFile(
    process.env.BENCH_OUT,
    JSON.stringify(result, null, 2) + '\n',
  );
}

if (process.env.BENCH_WRITE_BASELINE === '1') {
  await fs.writeFile(baselinePath, JSON.stringify(result, null, 2) + '\n');
  console.error(`wrote baseline → ${baselinePath}`);
}

await fs.rm(dir, { recursive: true, force: true });

if (result.threshold.status === 'fail') {
  console.error(
    `bench threshold failed: ${result.threshold.failed.join(', ')}`,
  );
  process.exit(1);
}
