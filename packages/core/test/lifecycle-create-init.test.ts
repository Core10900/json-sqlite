import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  create,
  getVersion,
  init,
  open,
} from '../src/index.js';

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v11-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v1.1.0 create / init / version', () => {
  it('FT-V11-VER-01 getVersion matches package', async () => {
    const pkg = JSON.parse(
      await fs.readFile(
        path.join(__dirname, '../package.json'),
        'utf8',
      ),
    ) as { version: string };
    expect(getVersion()).toBe(pkg.version);
  });

  it('FT-V11-CRT-01/02 create new then reject duplicate', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    const r = await create({ storagePath });
    expect(r.created).toBe(true);
    expect(r.storagePath).toBe(path.resolve(storagePath));
    const catalog = await fs.readFile(
      path.join(r.storagePath, 'meta', 'catalog.json'),
      'utf8',
    );
    expect(catalog).toContain('formatVersion');

    await expect(create({ storagePath })).rejects.toMatchObject({
      code: ErrorCode.DB_EXISTS,
    });
  });

  it('FT-V11-CRT-03 create --force recreates', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.insert('users', { name: 'old' });
    await db.close();

    const r = await create({ storagePath, force: true });
    expect(r.created).toBe(true);
    const db2 = await open({ storagePath });
    const rows = await db2.query({ collection: 'users' });
    expect(rows).toHaveLength(0);
    await db2.close();
  });

  it('FT-V11-INI-01/02 init create then idempotent keep data', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    const first = await init({ storagePath });
    expect(first.created).toBe(true);
    expect(first.initialized).toBe(true);

    const db = await open({ storagePath });
    await db.insert('users', { name: 'keep' });
    await db.close();

    const second = await init({ storagePath });
    expect(second.created).toBe(false);

    const db2 = await open({ storagePath });
    const rows = await db2.query({ collection: 'users' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('keep');
    await db2.close();
  });

  it('FT-V11-VER-02 CLI --version', async () => {
    const root = path.join(__dirname, '..');
    const cli = path.join(root, 'dist/cli.js');
    try {
      await fs.access(cli);
    } catch {
      const build = spawnSync('pnpm', ['run', 'build'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(build.status).toBe(0);
    }
    const r = spawnSync(process.execPath, [cli, '--version'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(getVersion());
  });
});
