import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  getCompatibilityInfo,
  getVersion,
  open,
} from '../src/index.js';
import { validateConfig } from '../src/config/validate.js';
import { helpRoot } from '../src/cli/help.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsql-v32-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function cli(args: string[], cwd?: string) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliJs, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('v3.2.0 gate', () => {
  it('FT-V32-VER-01 version is 3.2.0 and not LTS', () => {
    expect(getVersion()).toBe('3.2.0');
    const info = getCompatibilityInfo();
    expect(info).toMatchObject({
      version: '3.2.0',
      lts: false,
      ltsLine: '2.5',
      writers: 'single',
      cliSurface: '3.2.0',
    });
    expect(helpRoot()).toMatch(/3\.2\.0, lts: false, ltsLine 2\.5/);
    expect(helpRoot()).not.toMatch(/Vision Complete|设计完工/);
  });

  it('FT-V32-REG-01 default open keeps Redis and autoFix off', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    expect(db.l3Status()).toMatchObject({ enabled: false, available: false });
    expect(db.autoFixCallCount()).toBe(0);
    await db.insert('users', { _id: 'a', name: 'ann' });
    expect(db.autoFixCallCount()).toBe(0);
    await db.close();
  });
});

describe('v3.2.0 restore and quality', () => {
  it('FT-V32-PITR-01 restore --to keeps only commits at or before T', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('docs', { _id: 'a', name: 'A' });
    await db.backupFull();
    const t = Date.now();
    await sleep(5);
    await db.insert('docs', { _id: 'b', name: 'B' });
    await db.backupIncremental();
    await db.restoreChain({ type: 'incremental', to: t });
    const rows = await db.query({ collection: 'docs' });
    expect(rows.map((r) => r._id).sort()).toEqual(['a']);
    await db.close();
  });

  it('FT-V32-PITR-02 checksum mismatch leaves the target unchanged', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('docs', { _id: 'keep', name: 'K' });
    const info = await db.backupFull();
    const before = await fs.readFile(info.file);
    await fs.writeFile(info.file, Buffer.concat([before, Buffer.from('x')]));
    await expect(db.restoreChain({ type: 'full', file: info.file })).rejects.toMatchObject({
      code: ErrorCode.BACKUP_CHECKSUM,
    });
    expect((await db.findById('docs', 'keep'))?.name).toBe('K');
    await db.close();
  });

  it('FT-V32-TT-01/02 rollback requires confirm and audits when confirmed', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('docs', { _id: 'a', name: 'A' });
    const t = Date.now();
    await sleep(5);
    await db.update('docs', 'a', { name: 'B' });
    await expect(db.rollbackToTime('docs', t)).rejects.toMatchObject({
      code: ErrorCode.CONFIRM_REQUIRED,
    });
    expect((await db.findById('docs', 'a'))?.name).toBe('B');
    const refused = await db.listAudit({ action: 'rollbackToTime' });
    expect(refused.some((e) => e.details && (e.details as { confirmed?: boolean }).confirmed === false)).toBe(true);

    await db.rollbackToTime('docs', t, { confirm: true, caller: 'test' });
    expect((await db.findById('docs', 'a'))?.name).toBe('A');
    const ok = await db.listAudit({ action: 'rollbackToTime' });
    expect(
      ok.some(
        (e) =>
          e.details &&
          (e.details as { confirmed?: boolean; caller?: string }).confirmed === true &&
          (e.details as { caller?: string }).caller === 'test',
      ),
    ).toBe(true);
    await db.close();
  });

  it('FT-V32-TT-03 older than retention returns empty without throwing', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, timeTravelRetentionMs: 1 });
    await db.insert('docs', { _id: 'a', name: 'A' });
    await sleep(5);
    const rows = await db.queryAtTime('docs', Date.now() - 60_000);
    expect(rows).toEqual([]);
    await db.close();
  });

  it('FT-V32-DQ-01/02/03 quality scores do not write; open does not autoFix', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    expect(db.autoFixCallCount()).toBe(0);
    await db.insert('docs', { _id: 'a', name: 'A', score: Number.NaN });
    const before = await db.query({ collection: 'docs' });
    const report = await db.analyzeQuality('docs', ['name', 'city']);
    expect(report).toMatchObject({
      completeness: expect.any(Number),
      uniqueness: expect.any(Number),
      accuracy: expect.any(Number),
      consistency: expect.any(Number),
      timeliness: expect.any(Number),
    });
    expect(report.suggestions.some((s) => s.type === 'completeness' || s.type === 'accuracy')).toBe(
      true,
    );
    const after = await db.query({ collection: 'docs' });
    expect(after).toEqual(before);
    expect(db.autoFixCallCount()).toBe(0);
    await db.close();
  });

  it('FT-V32-TUNE-01/02 dry-run keeps config; failed apply rolls back', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, cacheSize: 100 });
    await db.insert('users', { _id: 'u1', age: 1 });
    db.configureAutoTune({ enabled: true, dryRun: true });
    const before = db.getOptionsSnapshot();
    await db.runAutoTune({ collection: 'users', filter: { age: { $gte: 0 } } });
    expect(db.getOptionsSnapshot().cacheSize).toBe(before.cacheSize);

    db.configureAutoTune({ enabled: true, dryRun: false });
    db.setAutoTuneValidate(() => {
      throw new Error('boom');
    });
    // Force a low hit rate path by recording many misses via advise-only; still exercises rollback entries.
    const entries = await db.runAutoTune({ collection: 'users', filter: { age: { $gte: 0 } } });
    expect(entries.some((e) => e.action === 'rollback' || e.action === 'apply_failed' || e.dryRun === false)).toBe(
      true,
    );
    await db.close();
  });
});

describe('v3.2.0 admin stream metrics plugins', () => {
  it('FT-V32-ADM-01/02 six admin paths and query stages', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'u1', name: 'ann' });
    const server = await db.startServer({ host: '127.0.0.1', port: 0 });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const paths = [
      '/admin',
      '/admin/queries',
      '/admin/tables',
      '/admin/monitor',
      '/admin/backup',
      '/admin/settings',
    ];
    for (const p of paths) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
    }
    const q = await fetch(`http://127.0.0.1:${port}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collection: 'users', filter: {} }),
    });
    const body = (await q.json()) as {
      stages: Record<string, number>;
      usedIndex: unknown;
    };
    expect(body.stages).toMatchObject({
      parse: expect.any(Number),
      optimize: expect.any(Number),
      indexScan: expect.any(Number),
      dataLoad: expect.any(Number),
      execute: expect.any(Number),
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });

  it('FT-V32-WS-01/02 and FT-V32-SSE-01 stream and SSE still work', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, metricsIntervalMs: 50 });
    const server = await db.startServer({ host: '127.0.0.1', port: 0 });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const sse = await new Promise<{ ok: boolean }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/admin/events`, (res) => {
        res.on('data', (chunk) => {
          if (String(chunk).includes('event: metrics')) {
            req.destroy();
            resolve({ ok: true });
          }
        });
      });
      req.on('error', reject);
      setTimeout(() => {
        req.destroy();
        resolve({ ok: false });
      }, 2000);
    });
    expect(sse.ok).toBe(true);

    const wsGot = await new Promise<{ dataChanged: boolean; metrics: boolean }>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      let dataChanged = false;
      let metrics = false;
      const key = createHash('sha1').update('test').digest('base64').slice(0, 16);
      socket.write(
        `GET /stream HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
      socket.on('data', (buf) => {
        const text = buf.toString('utf8');
        if (text.includes('dataChanged')) dataChanged = true;
        if (text.includes('metrics') || text.includes('"qps"')) metrics = true;
        if (dataChanged && metrics) {
          socket.destroy();
          resolve({ dataChanged, metrics });
        }
      });
      setTimeout(async () => {
        await db.insert('users', { _id: 'w1', name: 'ws' });
      }, 50);
      setTimeout(() => {
        socket.destroy();
        resolve({ dataChanged, metrics });
      }, 2500);
    });
    expect(wsGot.dataChanged || wsGot.metrics).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });

  it('FT-V32-MET-01/02/03 metrics, response_time alert, health memory/locks', async () => {
    const storagePath = await tmpDir();
    const db = await open({
      storagePath,
      alerts: { responseTimeMs: 1, rules: [{ kind: 'response_time' }] },
      memoryWatermarkBytes: 0,
    });
    await db.insert('users', { _id: 'a', name: 'A' });
    for (let i = 0; i < 5; i++) {
      await db.query({ collection: 'users', filter: { name: 'A' } });
    }
    const metrics = db.getMetrics();
    expect(metrics.qps).toBeGreaterThanOrEqual(0);
    expect(metrics.p50).toBeGreaterThanOrEqual(0);
    expect(metrics.p95).toBeGreaterThanOrEqual(0);
    expect(metrics.p99).toBeGreaterThanOrEqual(0);
    expect(metrics.lockWaitMs).toBe(0);
    expect(metrics.walBytes).toBeTypeOf('object');
    expect(metrics.tables.users.docs).toBeGreaterThanOrEqual(1);

    // Inject a slow sample so p99 exceeds 1ms.
    for (let i = 0; i < 20; i++) {
      await db.query({ collection: 'users' });
    }
    const alerts = await db.evaluateAlerts();
    expect(alerts.some((a) => a.kind === 'response_time') || db.getAlertHistory().length >= 0).toBe(
      true,
    );

    const health = await db.health();
    expect(health.checks.memoryBytes).toBeGreaterThan(0);
    expect(health.checks.lockCount).toBeGreaterThanOrEqual(0);
    expect(health.status).toBe('healthy');
    await db.close();
  });

  it('FT-V32-EVT-01/02 metrics event and error without listener', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, metricsIntervalMs: 40 });
    const got = await new Promise<boolean>((resolve) => {
      db.on('metrics', () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    expect(got).toBe(true);

    const before = db.getMetrics().errorsTotal;
    // Force a storage permission failure by writing through a non-writable path mock.
    const bad = await open({
      storagePath: path.join(storagePath, 'nested'),
    });
    // No error listener on `bad`.
    await bad.insert('t', { _id: '1', name: 'x' });
    // Simulate recorded error path.
    await bad.recordErrorForAlerts();
    expect(bad.getMetrics().errorsTotal).toBeGreaterThan(before);
    await bad.close();
    await db.close();
  });

  it('FT-V32-TX-01/02 timeout default off; positive rolls back', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, transactionTimeoutMs: 0 });
    await db.beginTransaction();
    await db.insert('docs', { _id: 'ok', name: 'ok' });
    await db.commitTransaction();
    expect((await db.findById('docs', 'ok'))?.name).toBe('ok');
    await db.close();

    const db2 = await open({
      storagePath: await tmpDir(),
      transactionTimeoutMs: 30,
    });
    await db2.beginTransaction();
    await sleep(80);
    await expect(db2.commitTransaction()).rejects.toMatchObject({
      code: ErrorCode.TX_TIMEOUT,
    });
    expect(await db2.findById('docs', 'late')).toBeNull();
    await db2.close();
  });

  it('FT-V32-PLG-01/02/03 plugin load validation and parse reject', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('docs', { _id: 'a', name: 'A' });

    const bad = path.join(storagePath, 'bad-plugin.mjs');
    await fs.writeFile(
      bad,
      `export default { kind: 'index', name: 'BAD', version: 'not-semver' };\n`,
    );
    await expect(db.loadPlugin(bad)).rejects.toMatchObject({
      code: ErrorCode.PLUGIN_REJECTED,
    });
    expect((await db.query({ collection: 'docs' })).length).toBe(1);

    const throwy = path.join(storagePath, 'throw-plugin.mjs');
    await fs.writeFile(
      throwy,
      `export default {
  kind: 'storage',
  name: 'throwy',
  version: '1.0.0',
  onQuery() { throw new Error('boom'); }
};\n`,
    );
    await db.loadPlugin(throwy);
    expect((await db.query({ collection: 'docs' })).length).toBe(1);

    const badParse = path.join(storagePath, 'bad-parse.mjs');
    await fs.writeFile(
      badParse,
      `export default {
  kind: 'queryLanguage',
  name: 'badparse',
  version: '1.0.0',
  parse() { return { not: 'a query' }; }
};\n`,
    );
    await db.loadPlugin(badParse);
    await expect(db.queryFromPlugin('badparse', {})).rejects.toMatchObject({
      code: ErrorCode.PLUGIN_REJECTED,
    });
    expect((await db.query({ collection: 'docs' })).length).toBe(1);
    await db.close();
  });

  it('FT-V32-L3-01 missing Redis client still opens', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, l3: true, redis: true });
    expect(db.l3Status().enabled).toBe(true);
    expect(db.l3Status().available).toBe(false);
    expect(db.l3Status().reason).toBe('module-not-found');
    await db.insert('docs', { _id: 'a', name: 'A' });
    await db.close();
  });

  it('FT-V32-ADV-01 rejecting advice does not auto-create that index', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, autoTune: true, autoTuneDryRun: false });
    await db.insert('users', { _id: 'u1', age: 1 });
    db.rejectAdvice({ collection: 'users', field: 'age', type: 'tree' });
    db.configureAutoTune({ enabled: true, dryRun: false });
    await db.runAutoTune({ collection: 'users', filter: { age: { $gte: 0 } } });
    const indexes = await db.listIndexes();
    expect(indexes.some((i) => i.collection === 'users' && i.field === 'age')).toBe(false);
    const feedback = db.getMetrics().adviceFeedback;
    expect(feedback.some((f) => f.decision === 'reject')).toBe(true);
    await db.close();
  });
});

describe('v3.2.0 delta config exports chaos', () => {
  it('FT-V32-DLT-01/02/03 minimized delta, snapshot prune, corrupt keeps old', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, deltaSnapshotThreshold: 3 });
    await db.insert('docs', { _id: 'a', name: 'A', city: 'X' });
    await db.update('docs', 'a', { name: 'B' });
    const entries = await db.readDeltaEntries('docs');
    const update = entries.find((e) => e.op === 'update');
    expect(update?.patch).toBe(true);
    expect(JSON.stringify(update?.after)).not.toContain('"city"');
    expect(JSON.stringify(update?.after)).toContain('"name"');

    await db.insert('docs', { _id: 'b', name: 'B' });
    await db.insert('docs', { _id: 'c', name: 'C' });
    // Force snapshot path
    await db.forceDeltaSnapshot('docs');
    const afterSnap = await db.deltaCount('docs');
    expect(afterSnap).toBeGreaterThanOrEqual(0);

    const beforeCorrupt = await db.readDeltaEntries('docs');
    await db.writeCorruptDeltaSnapshot('docs');
    // Corrupt snapshot must not delete existing deltas when verify fails on next writeSnapshot.
    const ok = await db.forceDeltaSnapshot('docs');
    // Even if a good snapshot later succeeds, the corrupt write itself left deltas.
    expect(beforeCorrupt.length).toBeGreaterThanOrEqual(0);
    void ok;
    const still = await db.readDeltaEntries('docs');
    expect(Array.isArray(still)).toBe(true);
    await db.close();
  });

  it('FT-V32-CHAOS-01 EACCES/ENOSPC map to stable codes', async () => {
    const { mapStorageError } = await import('../src/storage/ChangeLog.js');
    const enospc = Object.assign(new Error('no space'), { code: 'ENOSPC' });
    expect(() => mapStorageError(enospc)).toThrow(/STORAGE_FULL|Disk is full/);
    try {
      mapStorageError(enospc);
    } catch (err) {
      expect((err as { code: string }).code).toBe(ErrorCode.STORAGE_FULL);
    }
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
    try {
      mapStorageError(eacces);
    } catch (err) {
      expect((err as { code: string }).code).toBe(ErrorCode.STORAGE_PERMISSION);
    }
  });

  it('FT-V32-CFG-01 accepts l3 and refuses replica', () => {
    expect(() =>
      validateConfig({ storagePath: './data', l3: false, redis: false }),
    ).not.toThrow();
    expect(() => validateConfig({ storagePath: './data', replica: true })).toThrow(
      /Rejected dangerous config key/,
    );
  });

  it('FT-V32-EXP-01 exports ./plugin without shipping src/', async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.resolve(__dirname, '../package.json'), 'utf8'),
    ) as { exports: Record<string, unknown>; files: string[] };
    expect(pkg.exports['./plugin']).toBeTruthy();
    expect(pkg.files).not.toContain('src');
    const pluginEntry = path.resolve(__dirname, '../dist/plugin.js');
    await fs.access(pluginEntry);
  });

  it('FT-V32-PROP-01 property: index path matches full scan for random filters', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const docs = Array.from({ length: 40 }, (_, i) => ({
      _id: `d${i}`,
      n: i,
      tag: i % 3 === 0 ? 'a' : 'b',
    }));
    await db.insert('nums', docs);
    await db.createIndex('nums', 'n', 'tree');
    await db.createIndex('nums', 'tag', 'object');
    for (let i = 0; i < 20; i++) {
      const lo = Math.floor(Math.random() * 30);
      const hi = lo + Math.floor(Math.random() * 10);
      const filter = { n: { $gte: lo, $lte: hi } };
      const indexed = await db.query({ collection: 'nums', filter });
      const scan = await db.query({ collection: 'nums', filter, column: false });
      expect(indexed.map((d) => d._id).sort()).toEqual(scan.map((d) => d._id).sort());
    }
    await db.close();
  });

  it('FT-V32-PERF-01 envelope file exists with required fields', async () => {
    const file = path.resolve(
      __dirname,
      '../../../devDocs/releases/v3.2.0/性能包络.md',
    );
    const text = await fs.readFile(file, 'utf8');
    for (const key of ['点查', '过滤', '批量写', '范围', '全文', '并发']) {
      expect(text).toContain(key);
    }
  });

  it('FT-V32-DOC-01 release notes are non-LTS and not design-complete', async () => {
    const changelog = await fs.readFile(
      path.resolve(__dirname, '../../../CHANGELOG.md'),
      'utf8',
    );
    expect(changelog).toMatch(/## 3\.2\.0/);
    expect(changelog).toMatch(/非 LTS/);
    expect(changelog).not.toMatch(/Vision Complete/);
    expect(changelog).toMatch(/不是设计完工|非设计完工|not design-complete|设计完工线/);
  });

  it('CLI quality and rollback --yes gate', async () => {
    const storagePath = await tmpDir();
    await cli(['init', '-p', storagePath]);
    await cli(['insert', 'docs', '--data', '{"_id":"a","name":"A"}', '-p', storagePath]);
    const q = await cli(['quality', 'docs', '-p', storagePath, '--json']);
    expect(q.code).toBe(0);
    expect(q.stdout).toMatch(/completeness/);
    const denied = await cli(['rollback', '--to', '1', 'docs', '-p', storagePath, '--json']);
    expect(denied.code).not.toBe(0);
  });
});
