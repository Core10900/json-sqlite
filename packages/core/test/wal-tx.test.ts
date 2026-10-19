import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode, open } from '../src/index.js';

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

describe('FT-P1 WAL & Transaction', () => {
  it('FT-P1-WAL-01 reopen keeps data', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const doc = (await db.insert('users', { name: 'persist' })) as { _id: string };
    await db.close();

    const db2 = await open({ storagePath });
    const found = await db2.findById('users', doc._id);
    expect(found?.name).toBe('persist');
    await db2.close();
  });

  it('FT-P1-WAL-02 crash after WAL still recovers on reopen', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    // Ensure collection exists on disk before simulated crash
    await db.createCollection('users');
    db._store.crashAfterWal = true;
    await expect(db.insert('users', { name: 'wal-only' })).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
    });
    // Simulate process death: release lock without snapshot flush; WAL remains
    await db.close({ flush: false });

    const db2 = await open({ storagePath });
    const rows = await db2.query({
      collection: 'users',
      filter: { name: 'wal-only' },
    });
    expect(rows.length).toBe(1);
    await db2.close();
  });

  it('FT-P1-TX-01/02 commit and rollback', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });

    const tx1 = await db.beginTransaction();
    await db.insert('users', { name: 'committed' });
    await db.commitTransaction(tx1);

    const tx2 = await db.beginTransaction();
    await db.insert('users', { name: 'aborted' });
    await db.rollbackTransaction(tx2);

    const rows = await db.query({ collection: 'users' });
    expect(rows.map((r) => r.name)).toEqual(['committed']);
    await db.close();

    const db2 = await open({ storagePath });
    const again = await db2.query({ collection: 'users' });
    expect(again.map((r) => r.name)).toEqual(['committed']);
    await db2.close();
  });

  it('FT-P1-TX-03 nested begin rejected', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.beginTransaction();
    await expect(db.beginTransaction()).rejects.toMatchObject({
      code: ErrorCode.TX_NESTED,
    });
    await db.rollbackTransaction();
    await db.close();
  });

  it('FT-P1-LOCK-01 second open fails while first holds lock', async () => {
    const storagePath = await tmpDir();
    const db1 = await open({ storagePath });
    await expect(open({ storagePath })).rejects.toMatchObject({
      code: ErrorCode.LOCK_FAILED,
    });
    await db1.close();
    const db2 = await open({ storagePath });
    await db2.close();
  });
});
