import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode, getCompatibilityInfo, getVersion, isRetryableError, open } from '../src/index.js';
import { validateConfig } from '../src/config/validate.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');
const workerJs = path.resolve(__dirname, 'v24-worker.mjs');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v24-'));
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

function parseReport(stdout: string): { ok: boolean; code?: string; retryable?: boolean; name?: string; role?: string } {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  if (!line) throw new Error(`worker produced no JSON: ${stdout}`);
  return JSON.parse(line) as { ok: boolean; code?: string; retryable?: boolean; name?: string; role?: string };
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v2.4.0 multi-writer', () => {
  it('FT-V24-VER-01 / FT-V24-GATE-01 version is 2.4.0 and the RFC names the crash rule', async () => {
    expect(getVersion()).toBe('2.4.0');
    const info = getCompatibilityInfo();
    expect(info.lts).toBe(false);
    expect(info.ltsLine).toBe('2.2');
    expect(info.writers).toBe('single');
    expect(info.cliSurface).toBe('2.4.0');
    expect(info.features).toContain('multi-writer');
    expect(info.features).toContain('savepoint');

    const rfc = await fs.readFile(
      path.resolve(__dirname, '../../../devDocs/releases/v2.4.0/RFC-锁协议.md'),
      'utf8',
    );
    expect(rfc).toMatch(/无人持有/);
    expect(rfc).toMatch(/WRITE_CONFLICT/);
    expect(rfc).toMatch(/DEADLOCK/);
    expect(rfc).toMatch(/fsync/);
    expect(rfc).toMatch(/pid 较大/);
  });

  it('FT-V24-REG-01 / FT-V24-ISO-02 default single still rejects a second process and SERIALIZABLE', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await expect(open({ storagePath })).rejects.toMatchObject({ code: ErrorCode.LOCK_FAILED });
    await expect(db.beginTransaction('SERIALIZABLE')).rejects.toMatchObject({
      code: ErrorCode.ISOLATION_UNSUPPORTED,
    });
    await db.close();
    await expect(
      open({ storagePath: await tmpDir(), defaultIsolation: 'SERIALIZABLE' }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_CONFIG });
    expect(validateConfig({ storagePath: './data', writers: 'single' }).writers).toBe('single');
    expect(validateConfig({ storagePath: './data', writers: 'multi' }).writers).toBe('multi');
  });

  it('FT-V24-CON-01 two processes updating one id: one wins, the other is retryable', async () => {
    const storagePath = await tmpDir();
    const seed = await open({ storagePath, writers: 'multi' });
    await seed.insert('docs', { _id: 'doc1', name: 'seed' });
    await seed.close();

    const [left, right] = await Promise.all([
      runWorker(['conflict', storagePath, 'left', 'left', 'doc1']),
      runWorker(['conflict', storagePath, 'right', 'right', 'doc1']),
    ]);
    const reports = [parseReport(left.stdout), parseReport(right.stdout)];
    const wins = reports.filter((row) => row.ok);
    const losses = reports.filter((row) => !row.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]?.code).toBe(ErrorCode.WRITE_CONFLICT);
    expect(losses[0]?.retryable).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { code: losses[0]?.code }))).toBe(false);

    const db = await open({ storagePath });
    expect((await db.findById('docs', 'doc1'))?.name).toBe(wins[0]?.name);
    await db.close();
  });

  it('FT-V24-CON-02 two processes writing different documents both keep their rows', async () => {
    const storagePath = await tmpDir();
    const seed = await open({ storagePath, writers: 'multi' });
    await seed.insert('docs', { _id: 'a', name: 'a0' });
    await seed.insert('docs', { _id: 'b', name: 'b0' });
    await seed.close();

    const [left, right] = await Promise.all([
      runWorker(['distinct', storagePath, 'a', 'a1', 'a']),
      runWorker(['distinct', storagePath, 'b', 'b1', 'b']),
    ]);
    expect(parseReport(left.stdout).ok).toBe(true);
    expect(parseReport(right.stdout).ok).toBe(true);
    const db = await open({ storagePath });
    expect((await db.findById('docs', 'a'))?.name).toBe('a1');
    expect((await db.findById('docs', 'b'))?.name).toBe('b1');
    await db.close();
  });

  it('FT-V24-CON-03 a kill after commit keeps the commit and drops the open transaction', async () => {
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

  it('FT-V24-CON-04 a crash before fsync does not leave a partial document', async () => {
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

  it('FT-V24-ISO-01 SERIALIZABLE conflict rolls one side back', async () => {
    const storagePath = await tmpDir();
    const seed = await open({ storagePath, writers: 'multi' });
    await seed.insert('docs', { _id: 'doc1', name: 'seed' });
    await seed.close();
    const [left, right] = await Promise.all([
      runWorker(['serializable', storagePath, 'left', 'left', 'doc1']),
      runWorker(['serializable', storagePath, 'right', 'right', 'doc1']),
    ]);
    const reports = [parseReport(left.stdout), parseReport(right.stdout)];
    expect(reports.filter((row) => row.ok)).toHaveLength(1);
    const loss = reports.find((row) => !row.ok);
    expect(loss?.code).toBe(ErrorCode.SERIALIZABLE_CONFLICT);
    expect(loss?.retryable).toBe(true);
    const db = await open({ storagePath });
    const name = (await db.findById('docs', 'doc1'))?.name;
    expect(name === 'left' || name === 'right').toBe(true);
    expect(await db.query({ collection: 'docs', filter: { name: name === 'left' ? 'right' : 'left' } })).toEqual(
      [],
    );
    await db.close();
  });

  it('FT-V24-DLK-01 a wait cycle rolls the higher pid back', async () => {
    const storagePath = await tmpDir();
    const seed = await open({ storagePath, writers: 'multi' });
    await seed.insert('docs', { _id: 'd1', owner: 'seed' });
    await seed.insert('docs', { _id: 'd2', owner: 'seed' });
    await seed.close();
    const [a, b] = await Promise.all([
      runWorker(['deadlock', storagePath, 'a']),
      runWorker(['deadlock', storagePath, 'b']),
    ]);
    const reports = [parseReport(a.stdout), parseReport(b.stdout)];
    const wins = reports.filter((row) => row.ok);
    const losses = reports.filter((row) => !row.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]?.code).toBe(ErrorCode.DEADLOCK);
    expect(losses[0]?.retryable).toBe(true);
    const db = await open({ storagePath });
    expect((await db.findById('docs', 'd1'))?.owner).toBe(wins[0]?.role);
    expect((await db.findById('docs', 'd2'))?.owner).toBe(wins[0]?.role);
    await db.close();
  });

  it('FT-V24-TX-01 rolling back a savepoint keeps the outer staged change', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('docs', { _id: 'a', n: 1 });
    await db.beginTransaction();
    await db.update('docs', 'a', { n: 2 });
    const name = await db.savepoint('inner');
    await db.update('docs', 'a', { n: 3 });
    await db.insert('docs', { _id: 'inner', n: 9 });
    expect((await db.findById('docs', 'a'))?.n).toBe(3);
    await db.rollbackSavepoint(name);
    expect((await db.findById('docs', 'a'))?.n).toBe(2);
    expect(await db.findById('docs', 'inner')).toBeNull();
    await db.releaseSavepoint('missing').catch(() => undefined);
    await expect(db.beginTransaction()).rejects.toMatchObject({ code: ErrorCode.TX_NESTED });
    await db.commitTransaction();
    expect((await db.findById('docs', 'a'))?.n).toBe(2);
    expect(await db.findById('docs', 'inner')).toBeNull();
    await db.close();

    const again = await open({ storagePath });
    expect((await again.findById('docs', 'a'))?.n).toBe(2);
    await again.close();
  });

  it('FT-V24-CLI-01 --writers multi is visible to doctor without a TTY', async () => {
    const storagePath = await tmpDir();
    const init = await cli(['init', '-p', storagePath, '--json']);
    expect(init.code).toBe(0);
    const doctor = await cli(['--writers', 'multi', 'doctor', '-p', storagePath, '--json']);
    expect(doctor.code).toBe(0);
    const body = JSON.parse(doctor.stdout) as {
      writers: string;
      lockHolder: { pids?: number[] };
    };
    expect(body.writers).toBe('multi');
    expect(body.lockHolder.pids?.length).toBeGreaterThan(0);

    const bad = await cli(['--writers', 'cluster', 'doctor', '-p', storagePath, '--json']);
    expect(bad.code).toBe(1);
  });
});
