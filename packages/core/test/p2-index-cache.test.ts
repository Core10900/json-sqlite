import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { open } from '../src/index.js';

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('P2 index / cache / aggregate', () => {
  it('FT-P2-IDX-01/02 object index equality + update', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', [
      { name: 'a', city: 'SH' },
      { name: 'b', city: 'BJ' },
      { name: 'c', city: 'SH' },
    ]);
    await db.createIndex('users', 'city', 'object');
    const rows = await db.query({
      collection: 'users',
      filter: { city: 'SH' },
    });
    expect(rows).toHaveLength(2);

    const one = rows[0]!;
    await db.update('users', one._id, { city: 'GZ' });
    const sh = await db.query({ collection: 'users', filter: { city: 'SH' } });
    expect(sh).toHaveLength(1);
    await db.close();
  });

  it('FT-P2-IDX-03 tree range index', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', [
      { name: 'a', age: 10 },
      { name: 'b', age: 20 },
      { name: 'c', age: 30 },
    ]);
    await db.createIndex('users', 'age', 'tree');
    const rows = await db.query({
      collection: 'users',
      filter: { age: { $gte: 20, $lte: 30 } },
    });
    expect(rows.map((r) => r.age).sort()).toEqual([20, 30]);
    await db.close();
  });

  it('FT-P2-IDX-04 inverted text search', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('posts', [
      { title: 'hello world database' },
      { title: 'json document store' },
      { title: 'world peace' },
    ]);
    await db.createIndex('posts', 'title', 'inverted');
    const rows = await db.query({
      collection: 'posts',
      filter: { title: { $contains: 'world' } },
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    await db.close();
  });

  it('FT-P2-CACHE-01/02 cache hit and invalidate', async () => {
    const db = await open({ storagePath: await tmpDir(), cacheSize: 100 });
    await db.insert('users', { name: 'x', age: 1 });
    const q = { collection: 'users', filter: { name: 'x' } };
    await db.query(q);
    await db.query(q);
    const m1 = db.getMetrics();
    expect(m1.cacheHitRate).toBeGreaterThan(0);

    await db.insert('users', { name: 'y', age: 2 });
    const after = await db.query({ collection: 'users' });
    expect(after.length).toBe(2);
    await db.close();
  });

  it('FT-P2-AGG-01 group sum count', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('orders', [
      { city: 'SH', amount: 10 },
      { city: 'SH', amount: 15 },
      { city: 'BJ', amount: 7 },
    ]);
    const rows = (await db.aggregate('orders', [
      { type: 'group', by: 'city', fields: { total: { op: 'sum', field: 'amount' }, n: { op: 'count' } } },
    ])) as { _id: string; total: number; n: number }[];
    const sh = rows.find((r) => r._id === 'SH');
    expect(sh?.total).toBe(25);
    expect(sh?.n).toBe(2);
    await db.close();
  });

  it('FT-P2-PATH-01 jsonPath', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { name: '寒', age: 30 });
    const names = await db.jsonPath('users', '$.name');
    expect(names).toContain('寒');
    await db.close();
  });
});
