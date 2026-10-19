import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode, JSONSQLite, open } from '../src/index.js';

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

describe('FT-P0 lifecycle', () => {
  it('FT-P0-LIFE-01 open creates data directory', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    expect(db.isReady).toBe(true);
    const meta = await fs.stat(path.join(storagePath, 'meta', 'catalog.json'));
    expect(meta.isFile()).toBe(true);
    await db.close();
  });

  it('FT-P0-LIFE-02 close is idempotent', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.close();
    await expect(db.close()).resolves.toBeUndefined();
  });

  it('FT-P0-LIFE-03 write before open throws NOT_READY', async () => {
    const db = new JSONSQLite({ storagePath: await tmpDir() });
    await expect(db.insert('users', { name: 'a' })).rejects.toMatchObject({
      code: ErrorCode.NOT_READY,
    });
  });

  it('FT-P0-CFG-01 empty storagePath fails', () => {
    expect(() => new JSONSQLite({ storagePath: '' })).toThrow();
  });
});
