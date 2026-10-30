import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  JSONSQLiteError,
  getCompatibilityInfo,
  getVersion,
  open,
  parseSql,
  rekeyDatabase,
} from '../src/index.js';
import { helpIndex, helpRoot } from '../src/cli/help.js';
import { evaluateThresholds } from '../../../apps/bench/threshold.mjs';
import { coldDocsFile, pageFile } from '../src/utils/path.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');
const repoRoot = path.resolve(__dirname, '../../..');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v18-'));
  dirs.push(dir);
  return dir;
}

async function cli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliJs, ...args],
      { timeout: 20_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v1.8.0 index segments', () => {
  it('FT-V18-IDX-01 reopen serves from segment without rebuild', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, persistIndexes: true });
    for (let i = 0; i < 30; i++) {
      await db.insert('users', { name: `u${i}`, age: i });
    }
    await db.createIndex('users', 'age', 'tree');
    await db.close();

    const db2 = await open({ storagePath, lazyCollections: true });
    const before = db2.indexPersistence();
    expect(before.restored.some((k) => k.startsWith('users:'))).toBe(true);
    expect(before.buildCount).toBe(0);

    const rows = await db2.query({
      collection: 'users',
      filter: { age: { $gte: 10, $lte: 12 } },
    });
    expect(rows.map((r) => r.age).sort((a, b) => Number(a) - Number(b))).toEqual([
      10, 11, 12,
    ]);
    const after = db2.indexPersistence();
    expect(after.buildCount).toBe(0);
    expect(after.servedFromSegment).toContain('users');
    await db2.close();
  });

  it('FT-V18-IDX-02 corrupt segment is reported and rebuild keeps data', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const doc = (await db.insert('users', { name: 'keep', age: 3 })) as {
      _id: string;
    };
    await db.createIndex('users', 'name', 'object');
    await db.close();

    const idxDir = path.join(storagePath, 'meta', 'idx');
    const files = await fs.readdir(idxDir);
    expect(files.length).toBeGreaterThan(0);
    await fs.writeFile(path.join(idxDir, files[0]!), 'not-json', 'utf8');

    const db2 = await open({ storagePath });
    // 2.1+: corrupt segments are rebuilt on open (healable); data stays readable.
    expect(db2.indexPersistence().rebuilt).toContain('users');
    const still = await db2.findById('users', doc._id);
    expect(still?.name).toBe('keep');
    const again = await db2.doctor();
    expect(again.checks.find((c) => c.id === 'index-segments')?.ok).toBe(true);
    const hit = await db2.query({
      collection: 'users',
      filter: { name: 'keep' },
    });
    expect(hit).toHaveLength(1);
    await db2.close();
  });

  it('FT-V18-IDX-03 crash after WAL still matches the index', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { name: 'first', age: 1 });
    await db.createIndex('users', 'name', 'object');
    await db.close();

    const db2 = await open({ storagePath });
    db2._store.crashAfterWal = true;
    await expect(
      db2.insert('users', { name: 'from-wal', age: 2 }),
    ).rejects.toMatchObject({ code: ErrorCode.INTERNAL });
    await db2.close({ flush: false });

    const db3 = await open({ storagePath });
    const rows = await db3.query({ collection: 'users' });
    expect(rows.map((r) => r.name).sort()).toEqual(['first', 'from-wal']);
    const indexed = await db3.query({
      collection: 'users',
      filter: { name: 'from-wal' },
    });
    expect(indexed).toHaveLength(1);
    await db3.close();
  });
});

describe('v1.8.0 cache / compression / tiering', () => {
  it('FT-V18-CACHE-01 L2 off matches single-level cache', async () => {
    const db = await open({ storagePath: await tmpDir(), l2Cache: false });
    await db.insert('users', { name: 'a' });
    const first = await db.query({ collection: 'users', filter: { name: 'a' } });
    const second = await db.query({ collection: 'users', filter: { name: 'a' } });
    expect(second).toEqual(first);
    const metrics = db.getMetrics();
    expect(metrics.l2.enabled).toBe(false);
    expect(metrics.l2.hits).toBe(0);
    expect(metrics.cacheHitRate).toBeGreaterThan(0);
    await db.close();
  });

  it('FT-V18-CACHE-02 L2 hits then drops after a write', async () => {
    const db = await open({
      storagePath: await tmpDir(),
      l2Cache: true,
      cacheSize: 1,
    });
    await db.insert('users', { name: 'a', n: 1 });
    await db.insert('users', { name: 'b', n: 2 });
    await db.query({ collection: 'users', filter: { name: 'a' } });
    await db.query({ collection: 'users', filter: { name: 'b' } });
    await db.query({ collection: 'users', filter: { name: 'a' } });
    const mid = db.getMetrics();
    expect(mid.l2.enabled).toBe(true);
    expect(mid.l2.hits).toBeGreaterThan(0);

    const hits = mid.l2.hits;
    const misses = mid.l2.misses;
    await db.insert('users', { name: 'c', n: 3 });
    await db.query({ collection: 'users', filter: { name: 'a' } });
    const after = db.getMetrics();
    expect(after.l2.hits).toBe(hits);
    expect(after.l2.misses).toBeGreaterThan(misses);
    await db.close();
  });

  it('FT-V18-STOR-01 compression round-trip, including encryption', async () => {
    const plainPath = await tmpDir();
    const blob = 'x'.repeat(4000);
    const plain = await open({
      storagePath: plainPath,
      compression: true,
      compressionThreshold: 64,
    });
    const doc = (await plain.insert('notes', { body: blob })) as { _id: string };
    await plain.close();
    const file = await fs.readFile(pageFile(plainPath, 'notes', 1), 'utf8');
    expect(file).toContain('JSQC1:');
    const plain2 = await open({ storagePath: plainPath, compression: false });
    expect((await plain2.findById('notes', doc._id))?.body).toBe(blob);
    await plain2.close();

    const encPath = await tmpDir();
    const enc = await open({
      storagePath: encPath,
      encryptionKey: 'k1',
      compression: true,
      compressionThreshold: 64,
    });
    await enc.insert('notes', { body: blob, tag: 'enc' });
    await enc.vacuum({ compress: true });
    await enc.close();

    const enc2 = await open({ storagePath: encPath, encryptionKey: 'k1' });
    const rows = await enc2.query({ collection: 'notes' });
    expect(rows[0]?.body).toBe(blob);
    await enc2.close();

    const target = await tmpDir();
    await rekeyDatabase({
      storagePath: encPath,
      fromKey: 'k1',
      toKey: 'k2',
      targetPath: target,
    });
    const enc3 = await open({ storagePath: target, encryptionKey: 'k2' });
    expect((await enc3.query({ collection: 'notes' }))[0]?.tag).toBe('enc');
    await enc3.close();
  });

  it('FT-V18-STOR-02 tiering off has no cold file', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, tiering: false });
    const a = (await db.insert('users', { name: 'hot' })) as { _id: string };
    await db.insert('users', { name: 'other' });
    await db.findById('users', a._id);
    await db.close();
    await expect(fs.access(coldDocsFile(storagePath, 'users'))).rejects.toThrow();
    const db2 = await open({ storagePath, tiering: false });
    expect(db2.getMetrics().tiers).toEqual({
      enabled: false,
      hot: 0,
      cold: 0,
      delayedLoads: 0,
    });
    expect(await db2.count('users')).toBe(2);
    await db2.close();
  });

  it('FT-V18-STOR-03 cold docs load on read and show up in metrics', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, tiering: true, tierColdAfter: 0 });
    const hot = (await db.insert('users', { name: 'hot' })) as { _id: string };
    const cold = (await db.insert('users', { name: 'cold' })) as { _id: string };
    await db.findById('users', hot._id);
    await db.close();

    const coldFile = await fs.readFile(coldDocsFile(storagePath, 'users'), 'utf8');
    expect(coldFile).toContain('cold');

    const db2 = await open({
      storagePath,
      tiering: true,
      tierColdAfter: 0,
      prefetchCollections: ['users'],
    });
    const before = db2.getMetrics().tiers;
    expect(before.enabled).toBe(true);
    expect(before.cold).toBeGreaterThanOrEqual(1);
    expect(before.hot).toBeGreaterThanOrEqual(1);
    expect(before.delayedLoads).toBe(0);
    expect((await db2.findById('users', cold._id))?.name).toBe('cold');
    expect(db2.getMetrics().tiers.delayedLoads).toBeGreaterThanOrEqual(1);
    await db2.close();
  });
});

describe('v1.8.0 sql / bench / cli / compat', () => {
  it('FT-V18-SQL group by count and clearer SQL_* errors', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('events', { city: 'hz', n: 1 });
    await db.insert('events', { city: 'hz', n: 2 });
    await db.insert('events', { city: 'sh', n: 3 });
    const result = await db.run(
      'SELECT city, COUNT(*) FROM events GROUP BY city ORDER BY city ASC',
    );
    expect(result.type).toBe('rows');
    if (result.type !== 'rows') return;
    expect(result.rows.map((r) => ({ city: r.city, count: r.count }))).toEqual([
      { city: 'hz', count: 2 },
      { city: 'sh', count: 1 },
    ]);
    await db.close();

    try {
      parseSql('SELECT * FROM events GROUP BY city');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JSONSQLiteError);
      expect((err as JSONSQLiteError).code).toBe(ErrorCode.SQL_UNSUPPORTED);
      expect((err as JSONSQLiteError).message).toContain('[SQL_UNSUPPORTED]');
    }
  });

  it('FT-V18-PERF-01/02 bench smoke and threshold helper', async () => {
    const out = path.join(await tmpDir(), 'bench.json');
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(repoRoot, 'apps/bench/index.mjs')],
      {
        cwd: repoRoot,
        timeout: 60_000,
        env: { ...process.env, BENCH_N: '40', BENCH_OUT: out },
      },
    );
    const report = JSON.parse(await fs.readFile(out, 'utf8')) as {
      version: string;
      N: number;
      insertMs: number;
      pointQueryAvgMs: number;
      rangeQueryMs: number;
      concurrentReadMs: number;
      reopenMs: number;
      rebuildMs: number;
      threshold: { status: string };
    };
    expect(stdout).toContain('"N": 40');
    expect(report.version).toBe(getVersion());
    expect(report.insertMs).toBeGreaterThan(0);
    expect(report.pointQueryAvgMs).toBeGreaterThanOrEqual(0);
    expect(report.concurrentReadMs).toBeGreaterThanOrEqual(0);
    expect(typeof report.reopenMs).toBe('number');
    expect(typeof report.rebuildMs).toBe('number');
    expect(['pass', 'skip']).toContain(report.threshold.status);

    expect(
      evaluateThresholds(
        { N: 10, insertMs: 5, pointQueryAvgMs: 1 },
        { N: 10, insertMs: 4, pointQueryAvgMs: 1 },
        { insertMs: 2, pointQueryAvgMs: 2 },
        {},
      ).status,
    ).toBe('pass');
    expect(
      evaluateThresholds(
        { N: 10, insertMs: 100 },
        { N: 10, insertMs: 4 },
        { insertMs: 2 },
        {},
      ).status,
    ).toBe('fail');
    expect(
      evaluateThresholds(
        { N: 10, insertMs: 100 },
        { N: 10, insertMs: 4 },
        { insertMs: 2 },
        { BENCH_SKIP_THRESHOLD: '1' },
      ).status,
    ).toBe('skip');
  }, 60_000);

  it('FT-V18-CLI-01/02/03 index rebuild, doctor fields, help ⊆ CLI-API', async () => {
    const storagePath = await tmpDir();
    expect((await cli(['init', '-p', storagePath, '--json'])).code).toBe(0);
    expect(
      (await cli(['insert', 'users', '--data', '{"name":"a"}', '-p', storagePath]))
        .code,
    ).toBe(0);
    expect(
      (
        await cli([
          'index',
          'create',
          'users',
          'name',
          '--type',
          'object',
          '-p',
          storagePath,
          '--json',
        ])
      ).code,
    ).toBe(0);
    const rebuilt = await cli([
      'index',
      'rebuild',
      'users',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(rebuilt.code).toBe(0);
    expect(JSON.parse(rebuilt.stdout).action).toBe('index.rebuild');

    const doctor = await cli(['doctor', '-p', storagePath, '--json']);
    expect(doctor.code).toBe(0);
    const body = JSON.parse(doctor.stdout) as {
      indexSegments: { persist: boolean };
      compression: { enabled: boolean };
      tiering: { enabled: boolean };
      l2: { enabled: boolean };
    };
    expect(body.indexSegments.persist).toBe(true);
    expect(body.compression.enabled).toBe(false);
    expect(body.tiering.enabled).toBe(false);
    expect(typeof body.l2.enabled).toBe('boolean');

    const stats = await cli(['stats', '-p', storagePath, '--json']);
    expect(stats.code).toBe(0);
    const statsBody = JSON.parse(stats.stdout) as { l2: unknown; tiers: unknown };
    expect(statsBody.l2).toBeTruthy();
    expect(statsBody.tiers).toBeTruthy();

    const cliApi = await fs.readFile(path.join(repoRoot, 'CLI-API.md'), 'utf8');
    for (const token of ['rebuild', 'compress', 'indexSegments']) {
      expect(helpRoot().toLowerCase() + helpIndex().toLowerCase()).toContain(
        token === 'indexSegments' ? 'rebuild' : token,
      );
      expect(cliApi).toContain(token);
    }
    expect(helpIndex()).toContain('index rebuild');
  });

  it('FT-V18-REG-01 a directory without segments still opens', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { name: 'legacy' });
    await db.createIndex('users', 'name', 'object');
    await db.close();
    await fs.rm(path.join(storagePath, 'meta', 'idx'), { recursive: true, force: true });
    const db2 = await open({ storagePath });
    const rows = await db2.query({ collection: 'users', filter: { name: 'legacy' } });
    expect(rows).toHaveLength(1);
    expect(db2.getMetrics().indexes.rebuilt).toContain('users');
    await db2.close();
  });

  it('FT-V18-VER-01 getVersion is 1.8.0 on the 1.8 line', () => {
    const info = getCompatibilityInfo();
    expect(info.lts).toBe(false);
    expect(info.version).toBe(getVersion());
    if (info.version.startsWith('1.8.')) {
      expect(getVersion()).toBe('1.8.0');
      expect(info.cliSurface).toBe('1.8.0');
    }
    expect(info.features).toEqual(
      expect.arrayContaining([
        'index-segments',
        'l2-cache',
        'compression',
        'tiering',
        'group-by-count',
        'cli-1.8',
      ]),
    );
  });
});
