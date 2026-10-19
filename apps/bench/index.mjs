import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open } from '@jsonsqlite/core';

const N = Number(process.env.BENCH_N ?? 10_000);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-bench-'));

function hr() {
  return process.hrtime.bigint();
}
function ms(start) {
  return Number(hr() - start) / 1e6;
}

const db = await open({ storagePath: dir });

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

console.log(
  JSON.stringify(
    {
      N,
      insertMs: Number(insertMs.toFixed(2)),
      insertPerSec: Math.round(N / (insertMs / 1000)),
      pointQueryAvgMs: Number(pointMs.toFixed(4)),
      rangeQueryMs: Number(rangeMs.toFixed(2)),
      metrics: db.getMetrics(),
    },
    null,
    2,
  ),
);

await db.close();
await fs.rm(dir, { recursive: true, force: true });
