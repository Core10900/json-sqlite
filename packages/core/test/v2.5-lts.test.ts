import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { helpRoot } from '../src/cli/help.js';
import {
  ErrorCode,
  JSONSQLiteError,
  getCompatibilityInfo,
  getVersion,
  isRetryableError,
  migrateDatabase,
  open,
} from '../src/index.js';
import { catalogFile, docsFile } from '../src/utils/path.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');
const workerJs = path.resolve(__dirname, 'v24-worker.mjs');
const repoRoot = path.resolve(__dirname, '../../..');

const FROZEN_COMMANDS = [
  'create',
  'init',
  'tables',
  'collections',
  'table',
  'insert',
  'update',
  'delete',
  'get',
  'count',
  'run',
  'sql',
  'query',
  'index',
  'stats',
  'explain',
  'advise',
  'aggregate',
  'admin',
  'watch',
  'compat',
  'version',
  'backup',
  'vacuum',
  'rekey',
  'tune',
  'audit',
  'migrate',
  'doctor',
  'config',
] as const;

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v25-'));
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

function runWorker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerJs, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`worker hung: ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, 20_000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseReport(stdout: string): {
  ok: boolean;
  code?: string;
  retryable?: boolean;
  name?: string;
  role?: string;
} {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  if (!line) throw new Error(`worker produced no JSON: ${stdout}`);
  return JSON.parse(line) as {
    ok: boolean;
    code?: string;
    retryable?: boolean;
    name?: string;
    role?: string;
  };
}

function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    child.on('exit', () => resolve(child.pid ?? 0));
    child.on('error', reject);
  });
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v2.5.0 LTS-3', () => {
  it('FT-V25-VER-01 / FT-V25-LTS-01 version is 2.5.0 and the line is 2.5', () => {
    const info = getCompatibilityInfo();
    expect(info.version).toBe(getVersion());
    expect(info.writers).toBe('single');
    expect(info.formatVersion).toBe(2);
    expect(info.ltsLine).toBe('2.5');
    if (getVersion().startsWith('2.5.')) {
      expect(getVersion()).toBe('2.5.0');
      expect(info.lts).toBe(true);
      expect(info.cliSurface).toBe('2.5.0');
    }
    expect(info.features).toEqual(
      expect.arrayContaining([
        'lts-2',
        'lts-3',
        'single-writer',
        'multi-writer',
        'savepoint',
        'serializable',
        'deadlock-detection',
        'cli-2.4',
      ]),
    );
    expect(info.features).not.toEqual(
      expect.arrayContaining(['cluster', 'replica', 'raft', 'graphql']),
    );
    expect(info.ltsLine).not.toBe(info.version);
  });

  it('FT-V25-REG-01 single keeps the LTS-2 correctness line', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    expect((await db.lockReport()).writers).toBe('single');
    await expect(open({ storagePath })).rejects.toMatchObject({ code: ErrorCode.LOCK_FAILED });
    try {
      await open({ storagePath });
    } catch (err) {
      expect(isRetryableError(err)).toBe(false);
    }
    await expect(db.beginTransaction('SERIALIZABLE')).rejects.toMatchObject({
      code: ErrorCode.ISOLATION_UNSUPPORTED,
    });
    await db.insert('docs', { _id: 'a', n: 1, name: 'ok' });
    await db.createIndex('docs', 'name', 'object');
    await db.beginTransaction();
    await db.update('docs', 'a', { n: 2, name: 'staged' });
    await db.rollbackTransaction();
    expect((await db.findById('docs', 'a'))?.n).toBe(1);
    await db.beginTransaction();
    await db.update('docs', 'a', { n: 3, name: 'kept' });
    await db.commitTransaction();
    expect((await db.query({ collection: 'docs', filter: { name: 'kept' } })).map((row) => row._id)).toEqual([
      'a',
    ]);
    await db.close();

    const again = await open({ storagePath, defaultIsolation: 'REPEATABLE_READ' });
    expect((await again.lockReport()).writers).toBe('single');
    expect((await again.findById('docs', 'a'))?.name).toBe('kept');
    await expect(open({ storagePath })).rejects.toMatchObject({ code: ErrorCode.LOCK_FAILED });
    await again.close();

    await expect(
      open({ storagePath: await tmpDir(), defaultIsolation: 'SERIALIZABLE' }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_CONFIG });

    const crashPath = await tmpDir();
    const crashed = await open({ storagePath: crashPath });
    await crashed.insert('docs', { _id: 'doc1', name: 'ok' });
    await crashed.createIndex('docs', 'name', 'object');
    crashed._store.crashBeforeWalFsync = true;
    await expect(crashed.update('docs', 'doc1', { name: 'torn' })).rejects.toThrow(/before WAL fsync/);
    await crashed.close({ flush: false });
    const recovered = await open({ storagePath: crashPath });
    expect((await recovered.findById('docs', 'doc1'))?.name).toBe('ok');
    expect(await recovered.query({ collection: 'docs', filter: { name: 'torn' } })).toEqual([]);
    await recovered.close();
  });

  it('FT-V25-OPEN-01 a formatVersion 2 library opens as single-writer', async () => {
    const storagePath = await tmpDir();
    await fs.mkdir(path.join(storagePath, 'meta'), { recursive: true });
    await fs.mkdir(path.join(storagePath, 'collections', 'users', 'docs'), { recursive: true });
    await fs.writeFile(
      catalogFile(storagePath),
      JSON.stringify({
        formatVersion: 2,
        collections: { users: { name: 'users', createdAt: 1, documentCount: 1 } },
      }),
    );
    await fs.writeFile(
      docsFile(storagePath, 'users'),
      `${JSON.stringify({
        _id: 'u1',
        _version: 1,
        _createdAt: 1,
        _updatedAt: 1,
        name: '寒',
      })}\n`,
    );

    const db = await open({ storagePath });
    expect((await db.lockReport()).writers).toBe('single');
    expect((await db.findById('users', 'u1'))?.name).toBe('寒');
    await expect(open({ storagePath })).rejects.toMatchObject({ code: ErrorCode.LOCK_FAILED });
    await db.close();

    const pid = await deadPid();
    expect(pid).toBeGreaterThan(0);
    await fs.writeFile(
      path.join(storagePath, 'meta', '.lock'),
      JSON.stringify({ pid, createdAt: 1 }),
    );
    const reclaimed = await open({ storagePath });
    expect((await reclaimed.lockReport()).writers).toBe('single');
    expect((await reclaimed.lockReport()).lockHolder).toEqual({ pid: process.pid });
    await reclaimed.close();
  });

  it('FT-V25-OPEN-01 migrate from formatVersion 1 stays single-writer', async () => {
    const from = path.join(await tmpDir(), 'src');
    const to = path.join(await tmpDir(), 'dst');
    await fs.mkdir(path.join(from, 'meta'), { recursive: true });
    await fs.mkdir(path.join(from, 'collections', 'users', 'docs'), { recursive: true });
    await fs.writeFile(
      catalogFile(from),
      JSON.stringify({
        formatVersion: 1,
        collections: { users: { name: 'users', createdAt: 1, documentCount: 1 } },
      }),
    );
    await fs.writeFile(
      docsFile(from, 'users'),
      `${JSON.stringify({
        _id: 'u1',
        _version: 1,
        _createdAt: 1,
        _updatedAt: 1,
        name: '寒',
      })}\n`,
    );
    await expect(open({ storagePath: from })).rejects.toMatchObject({
      code: ErrorCode.MIGRATION_REQUIRED,
    });
    const migrated = await migrateDatabase({ from, to, yes: true });
    expect(migrated.formatVersion).toBe(2);
    const db = await open({ storagePath: to });
    expect((await db.lockReport()).writers).toBe('single');
    expect((await db.findById('users', 'u1'))?.name).toBe('寒');
    await expect(open({ storagePath: to })).rejects.toMatchObject({ code: ErrorCode.LOCK_FAILED });
    await db.close();
  });

  it('FT-V25-REG-02 multi conflict, distinct rows, serializable, and deadlock stay frozen', async () => {
    const conflictPath = await tmpDir();
    const seed = await open({ storagePath: conflictPath, writers: 'multi' });
    await seed.insert('docs', { _id: 'doc1', name: 'seed' });
    await seed.close();
    const [left, right] = await Promise.all([
      runWorker(['conflict', conflictPath, 'left', 'left', 'doc1']),
      runWorker(['conflict', conflictPath, 'right', 'right', 'doc1']),
    ]);
    const conflict = [parseReport(left.stdout), parseReport(right.stdout)];
    const wins = conflict.filter((row) => row.ok);
    const losses = conflict.filter((row) => !row.ok);
    expect(wins).toHaveLength(1);
    expect(losses[0]?.code).toBe(ErrorCode.WRITE_CONFLICT);
    expect(losses[0]?.retryable).toBe(true);
    expect(isRetryableError(new JSONSQLiteError(ErrorCode.WRITE_CONFLICT, 'lost', { retryable: true }))).toBe(
      true,
    );
    expect(isRetryableError(new JSONSQLiteError(ErrorCode.LOCK_FAILED, 'busy'))).toBe(false);
    const conflictDb = await open({ storagePath: conflictPath });
    expect((await conflictDb.findById('docs', 'doc1'))?.name).toBe(wins[0]?.name);
    await conflictDb.close();

    const distinctPath = await tmpDir();
    const distinctSeed = await open({ storagePath: distinctPath, writers: 'multi' });
    await distinctSeed.insert('docs', { _id: 'a', name: 'a0' });
    await distinctSeed.insert('docs', { _id: 'b', name: 'b0' });
    await distinctSeed.close();
    const [a, b] = await Promise.all([
      runWorker(['distinct', distinctPath, 'a', 'a1', 'a']),
      runWorker(['distinct', distinctPath, 'b', 'b1', 'b']),
    ]);
    expect(parseReport(a.stdout).ok).toBe(true);
    expect(parseReport(b.stdout).ok).toBe(true);
    const distinctDb = await open({ storagePath: distinctPath });
    expect((await distinctDb.findById('docs', 'a'))?.name).toBe('a1');
    expect((await distinctDb.findById('docs', 'b'))?.name).toBe('b1');
    await distinctDb.close();

    const serialPath = await tmpDir();
    const serialSeed = await open({ storagePath: serialPath, writers: 'multi' });
    await serialSeed.insert('docs', { _id: 'doc1', name: 'seed' });
    await serialSeed.close();
    const [sLeft, sRight] = await Promise.all([
      runWorker(['serializable', serialPath, 'left', 'left', 'doc1']),
      runWorker(['serializable', serialPath, 'right', 'right', 'doc1']),
    ]);
    const serial = [parseReport(sLeft.stdout), parseReport(sRight.stdout)];
    expect(serial.filter((row) => row.ok)).toHaveLength(1);
    const serialLoss = serial.find((row) => !row.ok);
    expect(serialLoss?.code).toBe(ErrorCode.SERIALIZABLE_CONFLICT);
    expect(serialLoss?.retryable).toBe(true);

    const deadPath = await tmpDir();
    const deadSeed = await open({ storagePath: deadPath, writers: 'multi' });
    await deadSeed.insert('docs', { _id: 'd1', owner: 'seed' });
    await deadSeed.insert('docs', { _id: 'd2', owner: 'seed' });
    await deadSeed.close();
    const [dA, dB] = await Promise.all([
      runWorker(['deadlock', deadPath, 'a']),
      runWorker(['deadlock', deadPath, 'b']),
    ]);
    const dead = [parseReport(dA.stdout), parseReport(dB.stdout)];
    const deadWins = dead.filter((row) => row.ok);
    const deadLosses = dead.filter((row) => !row.ok);
    expect(deadWins).toHaveLength(1);
    expect(deadLosses[0]?.code).toBe(ErrorCode.DEADLOCK);
    expect(deadLosses[0]?.retryable).toBe(true);
    const deadDb = await open({ storagePath: deadPath });
    expect((await deadDb.findById('docs', 'd1'))?.owner).toBe(deadWins[0]?.role);
    expect((await deadDb.findById('docs', 'd2'))?.owner).toBe(deadWins[0]?.role);
    await deadDb.close();
  });

  it('FT-V25-REG-02 a kill after commit keeps the commit and drops the open transaction', async () => {
    const storagePath = await tmpDir();
    const crashed = await runWorker(['crash-after', storagePath, 'x', 'x', 'doc1']);
    expect(crashed.code).toBe(9);
    const db = await open({ storagePath });
    expect((await db.findById('docs', 'doc1'))?.name).toBe('kept');
    expect((await db.findById('docs', 'other'))?.name).toBe('kept-too');
    expect((await db.query({ collection: 'docs', filter: { name: 'kept' } })).map((row) => row._id)).toEqual([
      'doc1',
    ]);
    expect(await db.query({ collection: 'docs', filter: { name: 'gone' } })).toEqual([]);
    await db.close();
  });

  it('FT-V25-REG-02 a crash before fsync does not leave a partial document', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, writers: 'multi' });
    await db.insert('docs', { _id: 'doc1', name: 'ok' });
    await db.createIndex('docs', 'name', 'object');
    db._store.crashBeforeWalFsync = true;
    await expect(db.update('docs', 'doc1', { name: 'torn' })).rejects.toThrow(/before WAL fsync/);
    await db.close({ flush: false });
    const again = await open({ storagePath });
    expect((await again.findById('docs', 'doc1'))?.name).toBe('ok');
    expect((await again.query({ collection: 'docs', filter: { name: 'ok' } })).map((row) => row._id)).toEqual([
      'doc1',
    ]);
    expect(await again.query({ collection: 'docs', filter: { name: 'torn' } })).toEqual([]);
    await again.close();
  });

  it('FT-V25-REG-02 savepoint rollback keeps the outer staged change in both modes', async () => {
    for (const writers of ['single', 'multi'] as const) {
      const storagePath = await tmpDir();
      const db = await open({ storagePath, writers });
      await db.insert('docs', { _id: 'a', n: 1 });
      await db.beginTransaction();
      await db.update('docs', 'a', { n: 2 });
      const name = await db.savepoint('inner');
      await db.update('docs', 'a', { n: 3 });
      await db.insert('docs', { _id: 'inner', n: 9 });
      await db.rollbackSavepoint(name);
      expect((await db.findById('docs', 'a'))?.n).toBe(2);
      expect(await db.findById('docs', 'inner')).toBeNull();
      await expect(db.beginTransaction()).rejects.toMatchObject({ code: ErrorCode.TX_NESTED });
      await db.commitTransaction();
      await db.close();
      const again = await open({ storagePath });
      expect((await again.findById('docs', 'a'))?.n).toBe(2);
      expect(await again.findById('docs', 'inner')).toBeNull();
      await again.close();
    }
  });

  it('FT-V25-CLI-01 the frozen CLI still reports writers and ltsLine 2.5', async () => {
    const help = helpRoot();
    const commands = help.slice(help.indexOf('Commands:'), help.indexOf('Exit codes:'));
    const flags = help.slice(0, help.indexOf('Commands:'));
    for (const token of FROZEN_COMMANDS) expect(commands).toContain(token);
    expect(flags).toContain('--writers');
    const banned =
      getVersion().startsWith('3.3.') ||
      getVersion().startsWith('3.4.') ||
      getVersion().startsWith('3.5.') ||
      getVersion().startsWith('3.6.')
        ? ['cluster', 'graphql', 'shard']
        : ['replica', 'cluster', 'graphql', 'savepoint', 'shard'];
    for (const token of banned) {
      expect(commands).not.toContain(token);
    }
    if (getVersion().startsWith('2.5.')) {
      expect(help).toMatch(/2\.5\.0, lts: true, ltsLine 2\.5/);
    } else {
      expect(help).toMatch(/3\.\d+\.\d+, lts: false, ltsLine 2\.5/);
    }
    expect(help).toMatch(/Exit codes: 0 ok · 1 usage\/business · 2 system\/IO · 3 lock failed/);

    const storagePath = await tmpDir();
    const version = await cli(['version', '--json']);
    expect(version.code).toBe(0);
    const versionBody = JSON.parse(version.stdout) as {
      action: string;
      version: string;
      lts: boolean;
      ltsLine: string;
      writers: string;
      formatVersion: number;
    };
    expect(versionBody.action).toBe('version');
    expect(versionBody.writers).toBe('single');
    expect(versionBody.ltsLine).toBe('2.5');
    expect(versionBody.formatVersion).toBe(2);
    if (versionBody.version.startsWith('2.5.')) {
      expect(versionBody).toMatchObject({ version: '2.5.0', lts: true, cliSurface: '2.5.0' });
    }
    const compat = await cli(['compat', '--json']);
    const compatBody = JSON.parse(compat.stdout) as { lts: boolean; ltsLine: string; writers: string };
    expect(compatBody.ltsLine).toBe('2.5');
    expect(compatBody.writers).toBe('single');
    if (getVersion().startsWith('2.5.')) expect(compatBody.lts).toBe(true);

    const doctor = await cli(['doctor', '-p', storagePath, '--json']);
    expect(doctor.code).toBe(0);
    const single = JSON.parse(doctor.stdout) as { writers: string; lockHolder: { pid?: number } };
    expect(single.writers).toBe('single');
    expect(typeof single.lockHolder.pid).toBe('number');

    const multi = await cli(['--writers', 'multi', 'doctor', '-p', storagePath, '--json']);
    expect(multi.code).toBe(0);
    const multiBody = JSON.parse(multi.stdout) as { writers: string; lockHolder: { pids?: number[] } };
    expect(multiBody.writers).toBe('multi');
    expect(multiBody.lockHolder.pids?.length).toBeGreaterThan(0);

    const bad = await cli(['--writers', 'cluster', 'doctor', '-p', storagePath, '--json']);
    expect(bad.code).toBe(1);
  });

  it('FT-V25-CLI-01 release notes name LTS-3 and keep the single-writer pin', async () => {
    const readme = await fs.readFile(path.resolve(__dirname, '../README.md'), 'utf8');
    expect(readme).toMatch(/2\.5\.0/);
    expect(readme).toMatch(/LTS-3/);
    expect(readme).toMatch(/LTS-2/);
    expect(readme).toMatch(/lts: true/);
    expect(readme).toMatch(/ltsLine: '2\.5'/);
    expect(readme).toMatch(/ltsLine: '2\.2'/);
    expect(readme).toMatch(/lts-3/);
    expect(readme).toMatch(/lts-2/);
    expect(readme).toMatch(/需要多写者才升级/);
    expect(readme).toMatch(/不会因为本版发布就改到 2\.5/);
    expect(readme).toMatch(/PATCH 不新增子命令/);
    expect(readme).toMatch(/--writers/);
    expect(readme).toMatch(/复制/);
    expect(readme).toMatch(/GraphQL/);
    expect(readme).toMatch(/选主/);
    expect(readme).not.toMatch(/Vision Complete/);

    const changelog = await fs.readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/## 2\.5\.0/);
    expect(changelog).toMatch(/LTS-3/);
    expect(changelog).toMatch(/需要多写者才升级/);

    const cliApi = await fs.readFile(path.join(repoRoot, 'CLI-API.md'), 'utf8');
    expect(cliApi).toMatch(/## 20\. 2\.5 LTS-3/);
    expect(cliApi).toMatch(/ltsLine: "2\.5"/);
    expect(cliApi).toMatch(/lts-3/);
    expect(cliApi).toMatch(/PATCH 不新增子命令/);

    const api = await fs.readFile(path.join(repoRoot, 'API.md'), 'utf8');
    expect(api).toMatch(/## 2\.5 LTS-3/);
    expect(api).toMatch(/ltsLine: '2\.5'/);
  });
});
