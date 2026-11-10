import fs from 'node:fs/promises';
import { writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '@webofcat/jsonsqlite';
import { evaluateThresholds } from './threshold.mjs';

function logProgress(msg) {
  writeSync(2, `${msg}\n`);
}

const N = Number(process.env.BENCH_N ?? 2000);
const large = N >= 100_000;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-bench-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(here, 'baseline.json');
const factorsPath = path.join(here, 'thresholds.json');
const pkg = JSON.parse(
  await fs.readFile(path.join(here, '../../packages/core/package.json'), 'utf8'),
);

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
  syncMode: 'none',
  // Large-N envelope: bigger pages cut filesystem chatter; retention still default.
  pageSize: large ? 8192 : 32,
  maxResidentDocs: large ? 131_072 : 256,
  // Avoid mid-load full-collection snapshots; they dominate large-N wall time.
  deltaSnapshotThreshold: large ? N + 1 : 1000,
  queryTimeout: large ? 600_000 : 30_000,
});

const tInsert = hr();
const batch = [];
const insertBatch = large ? 10_000 : 500;
let inserted = 0;
async function flushInsert(rows) {
  if (!rows.length) return;
  if (large) {
    // Bulk load: one transaction per chunk keeps pages in memory until commit.
    await db.beginTransaction();
    try {
      await db.insert('users', rows);
      await db.commitTransaction();
    } catch (err) {
      await db.rollbackTransaction().catch(() => undefined);
      throw err;
    }
  } else {
    await db.insert('users', rows);
  }
}
for (let i = 0; i < N; i++) {
  batch.push({ name: `u${i}`, age: i % 100, bio: `hello world ${i}` });
  if (batch.length === insertBatch) {
    const rows = batch.splice(0, batch.length);
    await flushInsert(rows);
    inserted += rows.length;
    if (large && inserted % 100_000 === 0) {
      logProgress(`inserted ${inserted}/${N}`);
    }
  }
}
if (batch.length) {
  inserted += batch.length;
  await flushInsert(batch);
}
const insertMs = ms(tInsert);
if (large) logProgress(`insert done ${inserted} in ${insertMs.toFixed(0)}ms`);

await db.createIndex('users', 'age', 'tree');
await db.createIndex('users', 'name', 'object');
await db.createIndex('users', 'bio', 'inverted');

const tPoint = hr();
const pointN = Math.min(1000, N);
for (let i = 0; i < pointN; i++) {
  await db.query({ collection: 'users', filter: { name: `u${i % N}` } });
}
const pointMs = ms(tPoint) / pointN;

// ~10% of N when age is i%100; for N=1e6 this is a 100k-hit indexed filter.
const filterMaxAge = N >= 100_000 ? 9 : 99;
const tFilter = hr();
await db.query({
  collection: 'users',
  filter: { age: { $gte: 0, $lte: filterMaxAge } },
  limit: Math.min(100_000, N),
});
const filter100kMs = ms(tFilter);

const batchN = Math.min(100_000, N);
const tBatch = hr();
const batchWrite = [];
async function flushBatch(rows) {
  if (!rows.length) return;
  if (large) {
    await db.beginTransaction();
    try {
      await db.insert('batch', rows);
      await db.commitTransaction();
    } catch (err) {
      await db.rollbackTransaction().catch(() => undefined);
      throw err;
    }
  } else {
    await db.insert('batch', rows);
  }
}
for (let i = 0; i < batchN; i++) {
  batchWrite.push({ k: i, v: `b${i}` });
  if (batchWrite.length === (large ? 10_000 : 1000)) {
    await flushBatch(batchWrite.splice(0, batchWrite.length));
  }
}
if (batchWrite.length) await flushBatch(batchWrite);
const batchWrite100kMs = ms(tBatch);

const tRange = hr();
await db.query({
  collection: 'users',
  filter: { age: { $gte: 10, $lte: 20 } },
});
const rangeMs = ms(tRange);

const tText = hr();
await db.query({
  collection: 'users',
  filter: { bio: { $contains: 'hello' } },
  limit: 20,
});
const fulltextMs = ms(tText);

const tConc = hr();
await Promise.all(
  Array.from({ length: Math.min(20, N) }, (_, i) =>
    db.query({ collection: 'users', filter: { name: `u${i}` } }),
  ),
);
const concurrentReadMs = ms(tConc);

const tWrite = hr();
await Promise.all(
  Array.from({ length: Math.min(20, N) }, (_, i) =>
    db.insert('writes', { n: i, name: `w${i}` }),
  ),
);
const concurrentWriteMs = ms(tWrite);

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

let reopenMs = 0;
let rebuildMs = 0;
let served = false;
let servedAfterQuery = false;
let metrics;
if (large) {
  // Envelope run: skip full reopen+rebuild (dominates wall time; not §1.3 scenarios).
  const dbQuick = await open({
    storagePath: dir,
    lazyCollections: true,
    persistIndexes: true,
    syncMode: 'none',
    pageSize: 8192,
    maxResidentDocs: 131_072,
    deltaSnapshotThreshold: N + 1,
  });
  metrics = dbQuick.getMetrics();
  await dbQuick.close();
} else {
  const tOpen = hr();
  const db2 = await open({
    storagePath: dir,
    lazyCollections: true,
    persistIndexes: true,
  });
  reopenMs = ms(tOpen);
  served = db2.indexPersistence().servedFromSegment.includes('users');
  await db2.query({ collection: 'users', filter: { name: 'u0' } });
  servedAfterQuery = db2
    .indexPersistence()
    .servedFromSegment.includes('users');
  const tRebuild = hr();
  await db2.rebuildIndexes('users');
  rebuildMs = ms(tRebuild);
  metrics = db2.getMetrics();
  await db2.close();
}

let baseline = null;
try {
  baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
} catch {
  baseline = null;
}
const factors = JSON.parse(await fs.readFile(factorsPath, 'utf8'));

const result = {
  version: pkg.version,
  N,
  insertMs: Number(insertMs.toFixed(2)),
  insertPerSec: Math.round(N / (insertMs / 1000)),
  pointQueryAvgMs: Number(pointMs.toFixed(4)),
  filter100kMs: Number(filter100kMs.toFixed(2)),
  batchWrite100kMs: Number(batchWrite100kMs.toFixed(2)),
  rangeQueryMs: Number(rangeMs.toFixed(2)),
  fulltextMs: Number(fulltextMs.toFixed(2)),
  concurrentReadMs: Number(concurrentReadMs.toFixed(2)),
  concurrentWriteMs: Number(concurrentWriteMs.toFixed(2)),
  concurrentReadWriteMs: Number(
    (concurrentReadMs + concurrentWriteMs).toFixed(2),
  ),
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
