import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptLine } from '../src/crypto/aes.js';
import { writeKeycheck } from '../src/crypto/keycheck.js';
import {
  ErrorCode,
  FORMAT_VERSION,
  create,
  getCompatibilityInfo,
  getVersion,
  migrateDatabase,
  open,
} from '../src/index.js';
import { catalogFile, docsFile, pageFile, walFile } from '../src/utils/path.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');
const repoRoot = path.resolve(__dirname, '../../..');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v20-'));
  dirs.push(dir);
  return dir;
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliJs, ...args], {
      timeout: 20_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed) throw new Error(`CLI hung: ${args.join(' ')}`);
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

function walChecksum(entry: Record<string, unknown>): string {
  const copy = { ...entry, checksum: '' };
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex').slice(0, 16);
}

function walLine(entry: Record<string, unknown>): string {
  const checksum = walChecksum(entry);
  return JSON.stringify({ ...entry, checksum });
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v2.0.0 compatibility', () => {
  it('FT-V20-VER-01 version is 2.x and not LTS', () => {
    expect(getVersion().startsWith('2.')).toBe(true);
    expect(FORMAT_VERSION).toBe(2);
    const info = getCompatibilityInfo();
    expect(info.version.startsWith('2.')).toBe(true);
    expect(info.lts).toBe(false);
    expect(info.cliSurface.startsWith('2.')).toBe(true);
    expect(info.writers).toBe('single');
    expect(info.features).toEqual(
      expect.arrayContaining(['single-writer', 'repeatable-read', 'paged-storage', 'backup-chain']),
    );
  });

  it('FT-V20-REG-01 a second writer is still rejected', async () => {
    const storagePath = await tmpDir();
    const a = await open({ storagePath });
    await expect(open({ storagePath })).rejects.toMatchObject({
      code: ErrorCode.LOCK_FAILED,
    });
    await a.close();
  });

  it('FT-V20-GATE-01 recovery RFC is present', async () => {
    const rfc = await fs.readFile(
      path.join(repoRoot, 'devDocs/releases/v2.0/RFC-恢复与分页.md'),
      'utf8',
    );
    expect(rfc).toMatch(/WAL_CORRUPT/);
    expect(rfc).toMatch(/maxResidentDocs/);
    expect(rfc).toMatch(/REPEATABLE_READ/);
  });
});

describe('v2.0.0 migrate', () => {
  async function writeV1(root: string, doc: Record<string, unknown>, opts?: { encryptKey?: string; corrupt?: boolean }) {
    await fs.mkdir(path.join(root, 'meta'), { recursive: true });
    await fs.mkdir(path.join(root, 'collections', 'users', 'docs'), { recursive: true });
    await fs.writeFile(
      catalogFile(root),
      JSON.stringify(
        {
          formatVersion: 1,
          ...(opts?.encryptKey ? { encryption: true } : {}),
          collections: {
            users: { name: 'users', createdAt: 1, documentCount: 1 },
          },
        },
        null,
        2,
      ),
    );
    const line = JSON.stringify(doc);
    const stored = opts?.encryptKey
      ? encryptLine(line, Buffer.from(opts.encryptKey))
      : line;
    const body = opts?.corrupt ? `${stored}\nNOT-A-DOCUMENT\n` : `${stored}\n`;
    await fs.writeFile(docsFile(root, 'users'), body);
    if (opts?.encryptKey) await writeKeycheck(root, Buffer.from(opts.encryptKey));
  }

  it('FT-V20-MIG-01 plaintext 1.x library migrates', async () => {
    const from = path.join(await tmpDir(), 'src');
    const to = path.join(await tmpDir(), 'dst');
    await writeV1(from, {
      _id: 'u1',
      _version: 3,
      _createdAt: 1,
      _updatedAt: 2,
      name: '寒',
    });
    const result = await migrateDatabase({ from, to, yes: true });
    expect(result.formatVersion).toBe(2);
    expect(result.documentCounts.users).toBe(1);
    expect(result.sourceChecksum).toMatch(/^[a-f0-9]{64}$/);
    const db = await open({ storagePath: to });
    const doc = await db.findById('users', 'u1');
    expect(doc?.name).toBe('寒');
    expect(doc?._version).toBe(3);
    await db.close();
  });

  it('FT-V20-MIG-02 wrong key does not create the target', async () => {
    const from = path.join(await tmpDir(), 'src');
    const to = path.join(await tmpDir(), 'dst');
    await writeV1(
      from,
      { _id: 'u1', _version: 1, _createdAt: 1, _updatedAt: 1, name: 'secret' },
      { encryptKey: 'right-key' },
    );
    await expect(
      migrateDatabase({ from, to, encryptionKey: 'wrong-key', yes: true }),
    ).rejects.toMatchObject({ code: ErrorCode.ENCRYPTION });
    await expect(fs.access(to)).rejects.toThrow();

    const ok = await migrateDatabase({
      from,
      to,
      encryptionKey: 'right-key',
      yes: true,
    });
    expect(ok.documentCounts.users).toBe(1);
    const db = await open({ storagePath: to, encryptionKey: 'right-key' });
    expect((await db.findById('users', 'u1'))?.name).toBe('secret');
    await db.close();
  });

  it('FT-V20-MIG-03 corrupt source leaves no partial target', async () => {
    const from = path.join(await tmpDir(), 'src');
    const to = path.join(await tmpDir(), 'dst');
    await writeV1(
      from,
      { _id: 'u1', _version: 1, _createdAt: 1, _updatedAt: 1, name: 'x' },
      { corrupt: true },
    );
    await expect(migrateDatabase({ from, to, yes: true })).rejects.toMatchObject({
      code: ErrorCode.INTERNAL,
    });
    await expect(fs.access(to)).rejects.toThrow();
  });

  it('FT-V20-MIG-04 rerun without yes refuses and keeps the target', async () => {
    const from = path.join(await tmpDir(), 'src');
    const to = path.join(await tmpDir(), 'dst');
    await writeV1(from, {
      _id: 'u1',
      _version: 1,
      _createdAt: 1,
      _updatedAt: 1,
      name: 'once',
    });
    await migrateDatabase({ from, to, yes: true });
    await expect(migrateDatabase({ from, to })).rejects.toMatchObject({
      code: ErrorCode.DB_EXISTS,
    });
    const db = await open({ storagePath: to });
    expect((await db.findById('users', 'u1'))?.name).toBe('once');
    await db.close();
  });

  it('FT-V20-CLI-01 migrate --yes is the non-TTY path', async () => {
    const from = path.join(await tmpDir(), 'src');
    const to = path.join(await tmpDir(), 'dst');
    await writeV1(from, {
      _id: 'u1',
      _version: 1,
      _createdAt: 1,
      _updatedAt: 1,
      name: 'cli',
    });
    const denied = await cli(['migrate', '--from', from, '--to', to]);
    expect(denied.code).toBe(1);
    await expect(fs.access(to)).rejects.toThrow();
    const ok = await cli(['migrate', '--from', from, '--to', to, '--yes', '--json']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).ok).toBe(true);
  });
});

describe('v2.0.0 backup chain', () => {
  it('FT-V20-BK-01 full then incremental restores the source sample', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'a', name: 'a' });
    await db.backupFull();
    await db.insert('users', { _id: 'b', name: 'b' });
    const inc = await db.backupIncremental();
    expect(inc).toBeTruthy();
    await db.delete('users', 'a');
    await db.insert('users', { _id: 'c', name: 'c' });
    await db.restoreChain({ type: 'incremental' });
    const names = (await db.query({ collection: 'users' }))
      .map((d) => d.name)
      .sort();
    expect(names).toEqual(['a', 'b']);
    await db.close();
  });

  it('FT-V20-BK-02 tampered checksum does not change the target', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'a', name: 'kept' });
    await db.backupFull();
    await db.close();
    const page = pageFile(storagePath, 'users', 1);
    const before = await fs.readFile(page);
    const manifestPath = path.join(storagePath, 'backups', 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { checksum: string }[];
    manifest[0]!.checksum = '0'.repeat(64);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const db2 = await open({ storagePath });
    await expect(db2.restoreChain({ type: 'full' })).rejects.toMatchObject({
      code: ErrorCode.BACKUP_CHECKSUM,
    });
    expect(await fs.readFile(page)).toEqual(before);
    expect((await db2.findById('users', 'a'))?.name).toBe('kept');
    await db2.close();
  });

  it('FT-V20-BK-03 restores one collection and leaves the other', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'u', name: 'old' });
    await db.insert('orders', { _id: 'o', sku: 'old' });
    await db.backupFull();
    await db.update('users', 'u', { name: 'new' });
    await db.update('orders', 'o', { sku: 'new' });
    await db.restoreChain({ type: 'full', collection: 'users' });
    expect((await db.findById('users', 'u'))?.name).toBe('old');
    expect((await db.findById('orders', 'o'))?.sku).toBe('new');
    await db.close();
  });

  it('FT-V20-BK-04 incremental without a full baseline does not apply', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'a', name: 'stay' });
    const inc = await db.backupIncremental();
    expect(inc?.type).toBe('incremental');
    await db.insert('users', { _id: 'b', name: 'also' });
    await expect(db.restoreChain({ type: 'incremental' })).rejects.toMatchObject({
      code: ErrorCode.BACKUP_BASELINE,
    });
    const names = (await db.query({ collection: 'users' })).map((d) => d.name).sort();
    expect(names).toEqual(['also', 'stay']);
    await db.close();
  });

  it('FT-V20-CLI-02 backup restore is scriptable', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'a', name: 'full' });
    await db.insert('orders', { _id: 'o', sku: 'keep' });
    await db.close();
    const full = await cli(['backup', '-p', storagePath, '--json']);
    expect(full.code).toBe(0);
    const db2 = await open({ storagePath });
    await db2.update('users', 'a', { name: 'dirty' });
    await db2.close();
    const restored = await cli([
      'backup',
      'restore',
      '--type',
      'full',
      '--collection',
      'users',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(restored.code).toBe(0);
    expect(JSON.parse(restored.stdout).action).toBe('backup.restore');
    const db3 = await open({ storagePath });
    expect((await db3.findById('users', 'a'))?.name).toBe('full');
    expect((await db3.findById('orders', 'o'))?.sku).toBe('keep');
    await db3.close();
  });
});

describe('v2.0.0 WAL fail-closed', () => {
  it('FT-V20-WAL-01 a torn tail keeps the committed prefix', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'base', name: 'base' });
    await db.close();
    const entry = {
      ts: 10,
      txId: null,
      committed: true,
      op: 'insert',
      collection: 'users',
      payload: {
        _id: 'kept',
        _version: 1,
        _createdAt: 10,
        _updatedAt: 10,
        name: 'kept',
      },
      seq: 1,
    };
    const file = walFile(storagePath, 'users');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${walLine(entry)}\n{"torn":`, 'utf8');
    const db2 = await open({ storagePath });
    expect((await db2.findById('users', 'base'))?.name).toBe('base');
    expect((await db2.findById('users', 'kept'))?.name).toBe('kept');
    expect(await db2.findById('users', 'torn')).toBeNull();
    const report = await db2.doctor({ deep: true });
    const wal = report.checks.find((c) => c.id === 'wal:users');
    expect(wal?.message).toMatch(/torn-tail/);
    await db2.close();
  });

  it('FT-V20-WAL-02 a middle checksum failure refuses open', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'base', name: 'base' });
    await db.close();
    const page = pageFile(storagePath, 'users', 1);
    const before = await fs.readFile(page);
    const good = walLine({
      ts: 2,
      txId: null,
      committed: true,
      op: 'insert',
      collection: 'users',
      payload: {
        _id: 'sneaky',
        _version: 1,
        _createdAt: 2,
        _updatedAt: 2,
        name: 'sneaky',
      },
      seq: 2,
    });
    const bad = walLine({
      ts: 1,
      txId: null,
      committed: true,
      op: 'insert',
      collection: 'users',
      payload: {
        _id: 'bad',
        _version: 1,
        _createdAt: 1,
        _updatedAt: 1,
        name: 'bad',
      },
      seq: 1,
    }).replace(/"checksum":"[a-f0-9]+"/, '"checksum":"0000000000000000"');
    const file = walFile(storagePath, 'users');
    await fs.writeFile(file, `${bad}\n${good}\n`, 'utf8');
    await expect(open({ storagePath })).rejects.toMatchObject({
      code: ErrorCode.WAL_CORRUPT,
    });
    expect(await fs.readFile(page)).toEqual(before);
    const doctor = await cli(['doctor', '-p', storagePath, '--json']);
    expect(doctor.code).not.toBe(0);
    expect(doctor.stdout + doctor.stderr).toMatch(/middle/);
  });

  it('FT-V20-WAL-03 committed rows survive a crash and uncommitted rows do not', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'yes', name: 'committed' });
    db._store.crashAfterWal = true;
    await expect(
      db.insert('users', { _id: 'wal', name: 'after-wal' }),
    ).rejects.toMatchObject({ code: ErrorCode.INTERNAL });
    await db.close({ flush: false });

    const db2 = await open({ storagePath });
    const tx = await db2.beginTransaction();
    await db2.insert('users', { _id: 'no', name: 'open-tx' });
    await db2.close({ flush: false });

    const db3 = await open({ storagePath });
    const names = (await db3.query({ collection: 'users' })).map((d) => d.name).sort();
    expect(names).toEqual(['after-wal', 'committed']);
    expect(names).not.toContain('open-tx');
    void tx;
    await db3.close();
  });
});

describe('v2.0.0 isolation and pages', () => {
  it('FT-V20-ISO-01/02 snapshot reads ignore later commits; RC sees them', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('items', { _id: 'a', n: 1 });
    const snap = await db.beginTransaction('REPEATABLE_READ');
    const write = await db.beginTransaction('READ_COMMITTED');
    await db.insert('items', { _id: 'b', n: 2 });
    await db.commitTransaction(write);
    const frozen = await db.query({ collection: 'items' }, { txId: snap });
    expect(frozen.map((d) => d.n).sort()).toEqual([1]);
    const again = await db.query({ collection: 'items' }, { txId: snap });
    expect(again.map((d) => d._id)).toEqual(frozen.map((d) => d._id));
    const latest = await db.query({ collection: 'items' });
    expect(latest.map((d) => d.n).sort()).toEqual([1, 2]);
    await db.commitTransaction(snap);
    await db.close();
  });

  it('FT-V20-ISO-03 unimplemented levels are rejected', async () => {
    await expect(
      open({
        storagePath: await tmpDir(),
        defaultIsolation: 'SERIALIZABLE',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_CONFIG });
    const db = await open({ storagePath: await tmpDir() });
    await expect(db.beginTransaction('READ_UNCOMMITTED')).rejects.toMatchObject({
      code: ErrorCode.ISOLATION_UNSUPPORTED,
    });
    await expect(db.beginTransaction('SERIALIZABLE')).rejects.toMatchObject({
      code: ErrorCode.ISOLATION_UNSUPPORTED,
    });
    await db.close();
  });

  it('FT-V20-PAGE-01/02 resident docs stay within the budget', async () => {
    const storagePath = await tmpDir();
    const N = 80;
    const db = await open({
      storagePath,
      pageSize: 4,
      maxResidentDocs: 8,
      syncMode: 'none',
      lazyCollections: true,
    });
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const doc = (await db.insert('docs', { n: i, name: `n${i}` })) as { _id: string };
      ids.push(doc._id);
    }
    await db.createIndex('docs', 'name', 'object');
    await db.close();

    const db2 = await open({
      storagePath,
      pageSize: 4,
      maxResidentDocs: 8,
      syncMode: 'none',
      lazyCollections: true,
    });
    expect(db2.pagingStats().residentDocs).toBe(0);
    const first = await db2.findById('docs', ids[0]!);
    expect(first?.n).toBe(0);
    expect(db2.pagingStats().pageReads).toBe(1);
    expect(db2.pagingStats().residentDocs).toBeLessThanOrEqual(8);
    expect(db2.indexPersistence().rebuilt).not.toContain('docs');

    const before = db2.pagingStats().pageReads;
    const far = await db2.findById('docs', ids[N - 1]!);
    expect(far?.n).toBe(N - 1);
    expect(db2.pagingStats().pageReads - before).toBeLessThanOrEqual(1);
    expect(db2.pagingStats().residentDocs).toBeLessThanOrEqual(8);

    const all = await db2.query({ collection: 'docs', filter: { missing: true } });
    expect(all).toHaveLength(0);
    expect(await db2.count('docs')).toBe(N);
    expect(db2.pagingStats().residentDocs).toBeLessThanOrEqual(8);
    await db2.close();
  });

  it('FT-V20-IDX-01 a corrupt segment is not served; open rebuilds it (2.1 heal)', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'u', name: 'real' });
    await db.createIndex('users', 'name', 'object');
    await db.close();
    const idxDir = path.join(storagePath, 'meta', 'idx');
    const files = await fs.readdir(idxDir);
    const target = path.join(idxDir, files[0]!);
    const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as { checksum: string };
    parsed.checksum = 'f'.repeat(64);
    await fs.writeFile(target, JSON.stringify(parsed));
    const db2 = await open({ storagePath });
    expect(db2.indexPersistence().servedFromSegment).not.toContain('users');
    expect(db2.indexPersistence().rebuilt).toContain('users');
    const hit = await db2.query({ collection: 'users', filter: { name: 'real' } });
    expect(hit).toHaveLength(1);
    await db2.close();
  });
});

describe('v2.0.0 admin TLS and envelope', () => {
  it('FT-V20-TLS-01 non-loopback without TLS is refused', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await expect(
      db.startServer({ host: '0.0.0.0', port: 0, adminToken: 'tok' }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_CONFIG });
    await db.close();
  });

  it('FT-V20-TLS-02 loopback without a token warns and listens', async () => {
    const db = await open({ storagePath: await tmpDir() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = await db.startServer({ host: '127.0.0.1', port: 0 });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/loopback|adminToken/i);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  });

  it('FT-V20-PERF-01 bench report has the six §12.3 scenarios', async () => {
    const out = path.join(await tmpDir(), 'bench.json');
    await execFileAsync(process.execPath, [path.join(repoRoot, 'apps/bench/index.mjs')], {
      cwd: repoRoot,
      timeout: 60_000,
      env: { ...process.env, BENCH_N: '30', BENCH_OUT: out },
    });
    const report = JSON.parse(await fs.readFile(out, 'utf8')) as Record<string, unknown>;
    for (const key of [
      'pointQueryAvgMs',
      'rangeQueryMs',
      'fulltextMs',
      'insertMs',
      'concurrentReadMs',
      'concurrentWriteMs',
    ]) {
      expect(typeof report[key]).toBe('number');
    }
    const note = await fs.readFile(
      path.join(repoRoot, 'devDocs/releases/v2.0/性能包络.md'),
      'utf8',
    );
    for (const label of ['点查', '范围', '全文', '批量插入', '并发读', '并发写']) {
      expect(note).toContain(label);
    }
    expect(note).toMatch(/非 LTS/);
  });

  it('FT-V20-DOC-01 API and CLI document the 2.0 contract', async () => {
    const api = await fs.readFile(path.join(repoRoot, 'API.md'), 'utf8');
    const cliApi = await fs.readFile(path.join(repoRoot, 'CLI-API.md'), 'utf8');
    expect(api).toMatch(/单写者/);
    expect(api).toMatch(/READ_COMMITTED/);
    expect(api).toMatch(/REPEATABLE_READ/);
    expect(api).toMatch(/maxResidentDocs/);
    expect(cliApi).toMatch(/migrate/);
    expect(cliApi).toMatch(/backup restore/);
    expect(cliApi).toMatch(/plugin/);
    expect(cliApi).toMatch(/replica/);
    expect(cliApi.toLowerCase()).not.toMatch(/^jsonsqlite plugin/m);
    expect(cliApi.toLowerCase()).not.toMatch(/^jsonsqlite replica/m);
    expect(cliApi.toLowerCase()).not.toMatch(/^jsonsqlite cluster/m);
  });
});
