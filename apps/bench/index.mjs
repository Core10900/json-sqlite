import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '@webofcat/jsonsqlite';

const N = Number(process.env.BENCH_N ?? 10_000);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-bench-'));
const baselinePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'baseline.json',
);

function hr() {
  return process.hrtime.bigint();
}
function ms(start) {
  return Number(hr() - start) / 1e6;
}

const db = await open({ storagePath: dir, lazyCollections: true });

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
for (let i = 0; i < 1000; i++) {
  await db.query({ collection: 'users', filter: { name: `u${i % N}` } });
}
const pointMs = ms(tPoint) / 1000;

const tRange = hr();
await db.query({
  collection: 'users',
  filter: { age: { $gte: 10, $lte: 20 } },
});
const rangeMs = ms(tRange);

// JOIN smoke (small)
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

const result = {
  version: '1.5.0',
  N,
  insertMs: Number(insertMs.toFixed(2)),
  insertPerSec: Math.round(N / (insertMs / 1000)),
  pointQueryAvgMs: Number(pointMs.toFixed(4)),
  rangeQueryMs: Number(rangeMs.toFixed(2)),
  joinMs: Number(joinMs.toFixed(2)),
  metrics: db.getMetrics(),
  recordedAt: new Date().toISOString(),
};

console.log(JSON.stringify(result, null, 2));

if (process.env.BENCH_WRITE_BASELINE === '1') {
  await fs.writeFile(baselinePath, JSON.stringify(result, null, 2) + '\n');
  console.error(`wrote baseline → ${baselinePath}`);
}

await db.close();
await fs.rm(dir, { recursive: true, force: true });
