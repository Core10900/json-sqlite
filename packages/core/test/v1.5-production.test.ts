import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  JSONSQLiteError,
  getVersion,
  open,
  parseSql,
  rekeyDatabase,
} from '../src/index.js';
const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v15-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v1.5.0 rekey', () => {
  it('FT-V15-KEY-01 rekey to new path', async () => {
    const source = await tmpDir();
    const target = await tmpDir();
    const db = await open({ storagePath: source, encryptionKey: 'old-key' });
    await db.insert('users', { name: '寒' });
    await db.close();

    await rekeyDatabase({
      storagePath: source,
      fromKey: 'old-key',
      toKey: 'new-key',
      targetPath: target,
    });

    const oldDb = await open({ storagePath: source, encryptionKey: 'old-key' });
    expect((await oldDb.query({ collection: 'users' }))[0]?.name).toBe('寒');
    await oldDb.close();

    const newDb = await open({ storagePath: target, encryptionKey: 'new-key' });
    expect((await newDb.query({ collection: 'users' }))[0]?.name).toBe('寒');
    await newDb.close();
  });

  it('FT-V15-KEY-02 wrong old key fails cleanly', async () => {
    const source = await tmpDir();
    const target = path.join(source, '..', `rekey-fail-${Date.now()}`);
    dirs.push(target);
    const db = await open({ storagePath: source, encryptionKey: 'correct' });
    await db.insert('users', { name: 'x' });
    await db.close();

    await expect(
      rekeyDatabase({
        storagePath: source,
        fromKey: 'wrong',
        toKey: 'new',
        targetPath: target,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.ENCRYPTION });

    // staging should not be a usable encrypted DB without cleanup leftovers
    const stagingExists = await fs
      .access(target)
      .then(() => true)
      .catch(() => false);
    expect(stagingExists).toBe(false);
  });

  it('FT-V15-KEY-03 inplace + yes', async () => {
    const source = await tmpDir();
    const db = await open({ storagePath: source, encryptionKey: 'old' });
    await db.insert('users', { name: 'inplace' });
    await db.close();

    await rekeyDatabase({
      storagePath: source,
      fromKey: 'old',
      toKey: 'fresh',
      inPlace: true,
      yes: true,
    });

    await expect(open({ storagePath: source, encryptionKey: 'old' })).rejects.toMatchObject({
      code: ErrorCode.ENCRYPTION,
    });
    const db2 = await open({ storagePath: source, encryptionKey: 'fresh' });
    expect((await db2.query({ collection: 'users' }))[0]?.name).toBe('inplace');
    await db2.close();
  });

  it('FT-V15-KEY-04 staging_ready journal rolls back', async () => {
    const source = await tmpDir();
    const staging = `${source}.rekey-tmp`;
    dirs.push(staging);
    const db = await open({ storagePath: source, encryptionKey: 'k' });
    await db.insert('users', { name: 'j' });
    await db.close();

    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(
      `${source}.rekey-journal.json`,
      JSON.stringify({
        op: 'rekey',
        phase: 'staging_ready',
        source,
        staging,
        backup: `${source}.rekey-bak`,
        startedAt: Date.now(),
      }),
    );

    const db2 = await open({ storagePath: source, encryptionKey: 'k' });
    expect((await db2.query({ collection: 'users' }))[0]?.name).toBe('j');
    await db2.close();
    await expect(fs.access(`${source}.rekey-journal.json`)).rejects.toBeTruthy();
  });

  it('FT-V15-KEY-05 CLI rekey non-TTY', async () => {
    const source = await tmpDir();
    const target = await tmpDir();
    const db = await open({ storagePath: source, encryptionKey: 'cli-old' });
    await db.insert('users', { name: 'cli' });
    await db.close();

    await execFileAsync(process.execPath, [
      cliJs,
      'rekey',
      '--path',
      source,
      '--out',
      target,
      '--from-key',
      'cli-old',
      '--to-key',
      'cli-new',
    ]);

    const db2 = await open({ storagePath: target, encryptionKey: 'cli-new' });
    expect(await db2.count('users')).toBe(1);
    await db2.close();
  });
});

describe('v1.5.0 lazy load / perf', () => {
  it('FT-V15-PERF-01/02 lazy open + first touch', async () => {
    const storagePath = await tmpDir();
    const seed = await open({
      storagePath,
      lazyCollections: false,
    });
    await seed.insert('a', { n: 1 });
    await seed.insert('b', { n: 2 });
    await seed.close();

    const db = await open({ storagePath, lazyCollections: true });
    expect(db.loadedCollectionCount()).toBe(0);
    const m0 = db.getMetrics();
    expect(m0.collectionsLoaded).toBe(0);

    const rows = await db.query({ collection: 'a' });
    expect(rows[0]?.n).toBe(1);
    expect(db.loadedCollectionCount()).toBe(1);
    expect(db.getMetrics().collectionsLoaded).toBeGreaterThanOrEqual(1);

    // second access should not bump load count again
    const loaded = db.getMetrics().collectionsLoaded;
    await db.query({ collection: 'a' });
    expect(db.getMetrics().collectionsLoaded).toBe(loaded);
    await db.close();
  });

  it('FT-V15-PERF-03 prefetch', async () => {
    const storagePath = await tmpDir();
    const seed = await open({ storagePath, lazyCollections: false });
    await seed.insert('hot', { x: 1 });
    await seed.insert('cold', { x: 2 });
    await seed.close();

    const db = await open({
      storagePath,
      lazyCollections: true,
      prefetchCollections: ['hot'],
    });
    expect(db.loadedCollectionCount()).toBe(1);
    expect(db.getMetrics().collectionsLoaded).toBe(1);
    await db.close();
  });

  it('FT-V15-PERF-04 bench smoke insert/query/JOIN', async () => {
    const db = await open({ storagePath: await tmpDir() });
    const N = 200;
    const batch = [];
    for (let i = 0; i < N; i++) batch.push({ name: `u${i}`, age: i % 50 });
    await db.insert('users', batch);
    const u0 = (await db.query({ collection: 'users', filter: { name: 'u0' } }))[0]!;
    await db.insert('orders', { userId: u0._id, total: 99 });

    const t0 = Date.now();
    await db.query({ collection: 'users', filter: { age: { $gte: 0, $lte: 10 } } });
    const join = await db.run(
      `SELECT u.name, o.total FROM users u INNER JOIN orders o ON u._id = o.userId`,
    );
    const ms = Date.now() - t0;
    expect(join.type).toBe('rows');
    expect(ms).toBeLessThan(10_000);
    await db.close();
  });
});

describe('v1.5.0 ops', () => {
  it('FT-V15-OPS-01/02 vacuum', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const a = (await db.insert('users', { name: 'keep' })) as { _id: string };
    for (let i = 0; i < 20; i++) {
      const d = (await db.insert('users', { name: `del${i}` })) as { _id: string };
      await db.delete('users', d._id);
    }
    await db.vacuum({ collection: 'users' });
    expect(await db.count('users')).toBe(1);
    expect((await db.findById('users', a._id))?.name).toBe('keep');

    await db.insert('items', { sku: 1 });
    const all = await db.vacuum();
    expect(all.collections.sort()).toEqual(['items', 'users']);
    await db.close();
  });

  it('FT-V15-OPS-03/04 doctor --deep', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { name: 'ok' });
    const healthy = await db.doctor({ deep: true });
    expect(healthy.status).toBe('healthy');
    expect(healthy.checks.length).toBeGreaterThan(2);
    await db.close();

    // corrupt: orphan collection dir
    await fs.mkdir(path.join(storagePath, 'collections', 'ghost'), {
      recursive: true,
    });
    const db2 = await open({ storagePath });
    const bad = await db2.doctor({ deep: true });
    expect(bad.status).toBe('unhealthy');
    expect(bad.checks.some((c) => c.id.startsWith('orphan-dir:') && !c.ok)).toBe(
      true,
    );
    await db2.close();
  });

  it('FT-V15-OPS-05 CLI vacuum/doctor noninteractive', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { name: 'cli' });
    await db.close();

    await execFileAsync(process.execPath, [
      cliJs,
      'vacuum',
      '--path',
      storagePath,
    ]);
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliJs,
      'doctor',
      '--deep',
      '--path',
      storagePath,
    ]);
    void stderr;
    const report = JSON.parse(stdout) as { status: string };
    expect(report.status).toBe('healthy');
  });
});

describe('v1.5.0 SQL', () => {
  it('FT-V15-SQL-01 NOT LIKE', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', [{ name: '寒猫' }, { name: '大狗' }]);
    const r = await db.run(`SELECT * FROM users WHERE name NOT LIKE '%猫'`);
    if (r.type === 'rows') {
      expect(r.rows.map((x) => x.name)).toEqual(['大狗']);
    }
    await db.close();
  });

  it('FT-V15-SQL-02 COUNT(*)', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', [{ age: 10 }, { age: 20 }, { age: 30 }]);
    const api = await db.count('users', { age: { $gt: 15 } });
    const r = await db.run(`SELECT COUNT(*) FROM users WHERE age > 15`);
    expect(r.type).toBe('rows');
    if (r.type === 'rows') {
      expect(r.rows[0]?.count).toBe(api);
      expect(r.rows[0]?.count).toBe(2);
    }
    await db.close();
  });

  it('FT-V15-SQL-03 stable ErrorCode', () => {
    try {
      parseSql('SELECT * FROM a JOIN b');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JSONSQLiteError);
      expect((err as JSONSQLiteError).code).toBe(ErrorCode.SQL_PARSE);
    }
    try {
      parseSql('SELECT * FROM a FULL OUTER JOIN b ON a.id = b.id');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JSONSQLiteError);
      expect((err as JSONSQLiteError).code).toBe(ErrorCode.SQL_UNSUPPORTED);
    }
  });
});

describe('v1.5.0 QA / deprecation / version', () => {
  it('FT-V15-QA-01 crash after WAL still recovers', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, lazyCollections: false });
    db._store.crashAfterWal = true;
    await expect(db.insert('users', { name: 'x' })).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
    });
    db._store.crashAfterWal = false;
    await db.close({ flush: false });

    const db2 = await open({ storagePath });
    const rows = await db2.query({ collection: 'users' });
    expect(rows.some((r) => r.name === 'x')).toBe(true);
    await db2.close();
  });

  it('FT-V15-DEP-01 dropCollection still aliases dropTable', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.createTable('tmp');
    await db.insert('tmp', { a: 1 });
    await db.dropCollection('tmp');
    expect(await db.listTables()).toHaveLength(0);
    await db.close();
  });

  it('FT-V15-VER-01 getVersion matches package', async () => {
    const pkg = JSON.parse(
      await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(getVersion()).toBe(pkg.version);
  });
});
