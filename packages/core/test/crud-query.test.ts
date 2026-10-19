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
    const dir = dirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('FT-P1 CRUD & Query', () => {
  it('FT-P1-CRUD-01/02 insert single and batch', async () => {
    const db = await open({ storagePath: await tmpDir() });
    const one = await db.insert('users', { name: '寒', age: 30 });
    expect(Array.isArray(one)).toBe(false);
    if (!Array.isArray(one)) {
      expect(one._id).toBeTruthy();
      expect(one._version).toBe(1);
      expect(one.name).toBe('寒');
    }

    const many = await db.insert('users', [
      { name: 'a', age: 1 },
      { name: 'b', age: 2 },
    ]);
    expect(Array.isArray(many)).toBe(true);
    expect((many as unknown[]).length).toBe(2);

    const all = await db.query({ collection: 'users' });
    expect(all.length).toBe(3);
    await db.close();
  });

  it('FT-P1-CRUD-03/04 update and delete', async () => {
    const db = await open({ storagePath: await tmpDir() });
    const doc = (await db.insert('users', { name: 'x', age: 10 })) as {
      _id: string;
      _version: number;
    };
    const updated = await db.update('users', doc._id, { age: 11 });
    expect(updated.age).toBe(11);
    expect(updated._version).toBe(2);

    const ok = await db.delete('users', doc._id);
    expect(ok).toBe(true);
    expect(await db.findById('users', doc._id)).toBeNull();
    await db.close();
  });

  it('FT-P1-Q-01/02/06 filter order limit', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', [
      { name: 'a', age: 20 },
      { name: 'b', age: 30 },
      { name: 'c', age: 40 },
    ]);

    const eq = await db.query({
      collection: 'users',
      filter: { name: 'b' },
    });
    expect(eq).toHaveLength(1);
    expect(eq[0]?.name).toBe('b');

    const gt = await db.query({
      collection: 'users',
      filter: { age: { $gte: 30 } },
      orderBy: { age: 'desc' },
      limit: 2,
    });
    expect(gt.map((d) => d.age)).toEqual([40, 30]);
    await db.close();
  });

  it('FT-P1-COL-01 create and list collections', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.createCollection('orders');
    const list = await db.listCollections();
    expect(list.some((c) => c.name === 'orders')).toBe(true);
    await db.close();
  });
});
