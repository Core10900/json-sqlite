import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  getCompatibilityInfo,
  getVersion,
  migrateDatabase,
  open,
} from '../src/index.js';
import { validateConfig } from '../src/config/validate.js';
import { helpRoot } from '../src/cli/help.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsql-v33-'));
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

async function waitForReplica(
  secondary: Awaited<ReturnType<typeof open>>,
  id: string,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await secondary.replicaSync();
    const doc = await secondary.findById('docs', id);
    if (doc) return;
    await sleep(30);
  }
  throw new Error(`replica did not observe ${id} within ${timeoutMs}ms`);
}

describe('v3.3.0 gate', () => {
  it('FT-V33-GATE-01 replication RFC forbids auto failover and documents promote', async () => {
    const rfc = await fs.readFile(
      path.resolve(__dirname, '../../../devDocs/releases/v3.3.0/RFC-异步复制.md'),
      'utf8',
    );
    expect(rfc).toMatch(/不自动选主|没有自动选主|不会.*自动提升/);
    expect(rfc).toMatch(/replica promote/);
    expect(rfc.toLowerCase()).not.toMatch(/\bfailover\b/);
  });

  it('FT-V33-VER-01 version is 3.3.0 and not LTS', () => {
    expect(getVersion()).toBe('3.3.0');
    const info = getCompatibilityInfo();
    expect(info).toMatchObject({
      version: '3.3.0',
      lts: false,
      ltsLine: '2.5',
      writers: 'single',
      cliSurface: '3.3.0',
    });
    expect(info.features).toContain('async-replica');
    expect(helpRoot()).toMatch(/3\.3\.0, lts: false, ltsLine 2\.5/);
    expect(helpRoot()).not.toMatch(/Vision Complete|设计完工/);
  });

  it('FT-V33-REG-01 replication off keeps single-writer 3.2 behavior', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    expect(db.replicaStatus()).toMatchObject({
      enabled: false,
      role: 'none',
      lagEntries: 0,
      lagMs: 0,
    });
    await db.insert('users', { _id: 'a', name: 'ann' });
    expect((await db.findById('users', 'a'))?.name).toBe('ann');
    await db.close();
  });
});

describe('v3.3.0 replication', () => {
  it('FT-V33-REP-01 secondary eventually sees primary writes', async () => {
    const primaryPath = await tmpDir();
    const secondaryPath = await tmpDir();
    const primary = await open({ storagePath: primaryPath, replica: { syncIntervalMs: 50 } });
    const secondary = await open({
      storagePath: secondaryPath,
      replica: { syncIntervalMs: 50 },
    });
    await primary.replicaInit({ role: 'primary' });
    await secondary.replicaInit({ role: 'secondary', primaryPath });
    await primary.insert('docs', { _id: 'a', name: 'A' });
    await waitForReplica(secondary, 'a');
    expect((await secondary.findById('docs', 'a'))?.name).toBe('A');
    await primary.close();
    await secondary.close();
  });

  it('FT-V33-REP-02 unapplied write is not marked replicated in status', async () => {
    const primaryPath = await tmpDir();
    const secondaryPath = await tmpDir();
    const primary = await open({ storagePath: primaryPath });
    const secondary = await open({
      storagePath: secondaryPath,
      replica: { syncIntervalMs: 60_000 },
    });
    await primary.replicaInit({ role: 'primary' });
    await secondary.replicaInit({ role: 'secondary', primaryPath });
    await primary.insert('docs', { _id: 'pending', name: 'P' });
    const before = await secondary.replicaStatusFresh();
    expect(before.appliedLsn).toBeLessThan(before.lastLsn);
    expect(before.replicatedPrefix).toBe(before.appliedLsn);
    expect(before.lagEntries).toBeGreaterThan(0);
    expect(await secondary.findById('docs', 'pending')).toBeNull();
    await primary.close();
    await secondary.close();
  });

  it('FT-V33-REP-03 lag units match across metrics, doctor, and status', async () => {
    const primaryPath = await tmpDir();
    const secondaryPath = await tmpDir();
    const primary = await open({ storagePath: primaryPath });
    const secondary = await open({ storagePath: secondaryPath });
    await primary.replicaInit({ role: 'primary' });
    await secondary.replicaInit({ role: 'secondary', primaryPath });
    await primary.insert('docs', { _id: 'lag', name: 'L' });
    const status = await secondary.replicaStatusFresh();
    const metrics = secondary.getMetrics().replica;
    const doctor = await secondary.doctor();
    const replicaCheck = doctor.checks.find((c) => c.id === 'replica');
    expect(status.lagEntries).toBeGreaterThan(0);
    expect(metrics).toMatchObject({
      lagEntries: status.lagEntries,
      lagMs: status.lagMs,
      appliedLsn: status.appliedLsn,
      lastLsn: status.lastLsn,
      role: 'secondary',
    });
    expect(replicaCheck?.details).toMatchObject({
      lagEntries: status.lagEntries,
      lagMs: status.lagMs,
      units: { lagEntries: 'entries', lagMs: 'milliseconds' },
    });
    await primary.close();
    await secondary.close();
  });

  it('FT-V33-REP-04 killing primary keeps secondary read-only with prefix', async () => {
    const primaryPath = await tmpDir();
    const secondaryPath = await tmpDir();
    const primary = await open({ storagePath: primaryPath, replica: { syncIntervalMs: 50 } });
    const secondary = await open({
      storagePath: secondaryPath,
      replica: { syncIntervalMs: 50 },
    });
    await primary.replicaInit({ role: 'primary' });
    await secondary.replicaInit({ role: 'secondary', primaryPath });
    await primary.insert('docs', { _id: 'kept', name: 'K' });
    await waitForReplica(secondary, 'kept');
    const prefix = secondary.replicaStatus().appliedLsn;
    await primary.close(); // kill primary process analogue
    await expect(secondary.insert('docs', { _id: 'x', name: 'X' })).rejects.toMatchObject({
      code: ErrorCode.REPLICA_READONLY,
    });
    expect(secondary.replicaStatus().appliedLsn).toBe(prefix);
    expect((await secondary.findById('docs', 'kept'))?.name).toBe('K');
    await secondary.close();
  });

  it('FT-V33-REP-05 only promote makes former secondary writable', async () => {
    const primaryPath = await tmpDir();
    const secondaryPath = await tmpDir();
    const primary = await open({ storagePath: primaryPath, replica: { syncIntervalMs: 50 } });
    const secondary = await open({
      storagePath: secondaryPath,
      replica: { syncIntervalMs: 50 },
    });
    await primary.replicaInit({ role: 'primary' });
    await secondary.replicaInit({ role: 'secondary', primaryPath });
    await primary.insert('docs', { _id: 'a', name: 'A' });
    await waitForReplica(secondary, 'a');
    await primary.close();
    await expect(secondary.insert('docs', { _id: 'b', name: 'B' })).rejects.toMatchObject({
      code: ErrorCode.REPLICA_READONLY,
    });
    const promoted = await secondary.replicaPromote();
    expect(promoted.role).toBe('primary');
    await secondary.insert('docs', { _id: 'b', name: 'B' });
    expect((await secondary.findById('docs', 'b'))?.name).toBe('B');
    await secondary.close();
  });

  it('FT-V33-MIG-01 migrate 3.2-shaped DB without enabling replica', async () => {
    const from = await tmpDir();
    const to = await tmpDir();
    const src = await open({ storagePath: from });
    await src.insert('docs', { _id: 'm1', name: 'migrated' });
    await src.close();
    await migrateDatabase({ from, to, yes: true });
    const dst = await open({ storagePath: to });
    expect(dst.replicaStatus().enabled).toBe(false);
    expect((await dst.findById('docs', 'm1'))?.name).toBe('migrated');
    await dst.insert('docs', { _id: 'm2', name: 'still-single' });
    await dst.close();
  });

  it('FT-V33-HLT-01 health succeeds when replication is off', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const health = await db.health();
    expect(health.status).toBe('healthy');
    expect(health.replica).toMatchObject({
      enabled: false,
      role: 'none',
    });
    await db.close();
  });

  it('FT-V33-HLT-02 health role/lag match replica status when on', async () => {
    const primaryPath = await tmpDir();
    const secondaryPath = await tmpDir();
    const primary = await open({ storagePath: primaryPath });
    const secondary = await open({ storagePath: secondaryPath });
    await primary.replicaInit({ role: 'primary' });
    await secondary.replicaInit({ role: 'secondary', primaryPath });
    await primary.insert('docs', { _id: 'h', name: 'H' });
    const status = await secondary.replicaStatusFresh();
    const health = await secondary.health();
    expect(health.replica).toMatchObject({
      enabled: true,
      role: status.role,
      lagEntries: status.lagEntries,
      lagMs: status.lagMs,
      appliedLsn: status.appliedLsn,
      lastLsn: status.lastLsn,
    });
    const server = await secondary.startServer({ host: '127.0.0.1', port: 0 });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const body = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    const json = JSON.parse(body) as { replica: { role: string; lagEntries: number } };
    expect(json.replica.role).toBe(status.role);
    expect(json.replica.lagEntries).toBe(status.lagEntries);
    await primary.close();
    await secondary.close();
  });

  it('FT-V33-CFG-01 config validate accepts replica default off and refuses cluster', () => {
    expect(() =>
      validateConfig({ storagePath: './data', replica: false }),
    ).not.toThrow();
    expect(() =>
      validateConfig({
        storagePath: './data',
        replica: { syncIntervalMs: 200 },
      }),
    ).not.toThrow();
    expect(() => validateConfig({ storagePath: './data', cluster: true })).toThrow(
      /Rejected dangerous config key/,
    );
  });
});

describe('v3.3.0 CLI and docs', () => {
  it('FT-V33-CLI-01 replica status --json includes role and lag', async () => {
    const storagePath = await tmpDir();
    await cli(['init', '-p', storagePath]);
    await cli(['replica', 'init', '--role', 'primary', '-p', storagePath]);
    const status = await cli(['replica', 'status', '-p', storagePath, '--json']);
    expect(status.code).toBe(0);
    const body = JSON.parse(status.stdout) as {
      role: string;
      lagEntries: number;
      lagMs: number;
    };
    expect(body.role).toBe('primary');
    expect(typeof body.lagEntries).toBe('number');
    expect(typeof body.lagMs).toBe('number');
  });

  it('FT-V33-CLI-02 stable help has no cluster and no failover', () => {
    const text = helpRoot();
    expect(text).toMatch(/replica init\|status\|promote/);
    expect(text.toLowerCase()).not.toMatch(/\bcluster\b/);
    expect(text.toLowerCase()).not.toMatch(/\bfailover\b/);
    expect(text.toLowerCase()).toMatch(/no auto promote/);
  });

  it('FT-V33-SHD-01 default path does not go through a shard router', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('docs', { _id: 's', name: 'direct' });
    // No shard router exists; a successful point write/read is the contract.
    expect((await db.findById('docs', 's'))?.name).toBe('direct');
    expect(helpRoot().toLowerCase()).not.toMatch(/\bshard/);
    await db.close();
  });

  it('FT-V33-DOC-01 release notes are non-LTS and not design-complete', async () => {
    const changelog = await fs.readFile(
      path.resolve(__dirname, '../../../CHANGELOG.md'),
      'utf8',
    );
    expect(changelog).toMatch(/## 3\.3\.0/);
    expect(changelog).toMatch(/非 LTS/);
    expect(changelog).not.toMatch(/Vision Complete/);
    expect(changelog).toMatch(/不是设计完工|非设计完工|not design-complete|设计完工线/);
  });
});
