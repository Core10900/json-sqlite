import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open } from '@webofcat/jsonsqlite';

const N = Number(process.env.BENCH_N ?? 1_000_000);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsql-p99-'));
const hr = () => process.hrtime.bigint();
const ms = (s) => Number(hr() - s) / 1e6;

function pct(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const db = await open({
  storagePath: dir,
  lazyCollections: true,
  persistIndexes: true,
  syncMode: 'none',
  pageSize: 8192,
  // Cover the 1M working set so P99 point / 100k-hit filter match §1.3 assumptions.
  maxResidentDocs: N,
  deltaSnapshotThreshold: N + 1,
  queryTimeout: 600_000,
});

process.stderr.write(`loading ${N} docs...\n`);
const tIns = hr();
const batch = [];
for (let i = 0; i < N; i++) {
  batch.push({ name: `u${i}`, age: i % 100, bio: `hello world ${i}` });
  if (batch.length === 10_000) {
    await db.beginTransaction();
    await db.insert('users', batch.splice(0, batch.length));
    await db.commitTransaction();
    if ((i + 1) % 100_000 === 0) process.stderr.write(`inserted ${i + 1}\n`);
  }
}
if (batch.length) {
  await db.beginTransaction();
  await db.insert('users', batch);
  await db.commitTransaction();
}
const loadMs = ms(tIns);
await db.createIndex('users', 'age', 'tree');
await db.createIndex('users', 'name', 'object');

for (let i = 0; i < 50; i++) {
  await db.query({ collection: 'users', filter: { name: `u${i}` } });
}

const nameSamples = [];
for (let i = 0; i < 1000; i++) {
  const id = (i * 997) % N;
  const t = hr();
  await db.query({ collection: 'users', filter: { name: `u${id}` } });
  nameSamples.push(ms(t));
}
nameSamples.sort((a, b) => a - b);

const idList = [];
for (let i = 0; i < 200; i++) {
  const row = (
    await db.query({
      collection: 'users',
      filter: { name: `u${(i * 1237) % N}` },
      limit: 1,
    })
  )[0];
  idList.push(row._id);
}
const idSamples = [];
for (let i = 0; i < 1000; i++) {
  const id = idList[i % idList.length];
  const t = hr();
  await db.findById('users', id);
  idSamples.push(ms(t));
}
idSamples.sort((a, b) => a - b);

const filterQuery = {
  collection: 'users',
  filter: { age: { $gte: 0, $lte: 9 } },
  limit: 100_000,
};
for (let i = 0; i < 2; i++) await db.query(filterQuery);
const filterSamples = [];
let filtered = [];
for (let i = 0; i < 11; i++) {
  const tFilter = hr();
  filtered = await db.query(filterQuery);
  filterSamples.push(ms(tFilter));
}
filterSamples.sort((a, b) => a - b);
const filterMs = pct(filterSamples, 95);

const tRead = hr();
await Promise.all(
  Array.from({ length: 100 }, (_, i) =>
    db.query({ collection: 'users', filter: { name: `u${i * 1000}` } }),
  ),
);
const concReadMs = ms(tRead);

const tWrite = hr();
await Promise.all(
  Array.from({ length: 100 }, (_, i) => db.insert('writes', { n: i, name: `w${i}` })),
);
const concWriteMs = ms(tWrite);

await db.close();
await fs.rm(dir, { recursive: true, force: true });

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const out = {
  version: '3.6.0',
  N,
  loadMs,
  pointByName: {
    avg: avg(nameSamples),
    p50: pct(nameSamples, 50),
    p95: pct(nameSamples, 95),
    p99: pct(nameSamples, 99),
  },
  pointById: {
    avg: avg(idSamples),
    p50: pct(idSamples, 50),
    p95: pct(idSamples, 95),
    p99: pct(idSamples, 99),
  },
  filter100kHits: filtered.length,
  filter100kMs: filterMs,
  filter100kP50: pct(filterSamples, 50),
  filter100kP95: pct(filterSamples, 95),
  concurrentRead100Ms: concReadMs,
  concurrentReadOpsPerSec: 100 / (concReadMs / 1000),
  concurrentWrite100Ms: concWriteMs,
  concurrentWriteOpsPerSec: 100 / (concWriteMs / 1000),
  recordedAt: new Date().toISOString(),
  node: process.version,
};
console.log(JSON.stringify(out, null, 2));
