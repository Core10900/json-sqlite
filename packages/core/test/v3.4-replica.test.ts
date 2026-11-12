import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  ReadRouter,
  createS3Plugin,
  getCompatibilityInfo,
  getVersion,
  isRetryableError,
  open,
} from '../src/index.js';
import { helpReplica, helpRoot } from '../src/cli/help.js';
import type { Document } from '../src/types/index.js';
import type { ReplicaStatus } from '../src/replica/ReplicaManager.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsql-v34-'));
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

describe('v3.4.0 gate', () => {
  it('FT-V34-REG-01 replica off, no adapter — insert/find works', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    expect(db.replicaStatus()).toMatchObject({
      enabled: false,
      role: 'none',
      lagEntries: 0,
    });
    await db.insert('users', { _id: 'a', name: 'ann' });
    expect((await db.findById('users', 'a'))?.name).toBe('ann');
    await db.close();
  });

  it('FT-V34-VER-01 getVersion 3.4.0, lts false, cliSurface 3.4.0', () => {
    expect(getVersion()).toBe('3.4.0');
    const info = getCompatibilityInfo();
    expect(info).toMatchObject({
      version: '3.4.0',
      lts: false,
      ltsLine: '2.5',
      writers: 'single',
      cliSurface: '3.4.0',
    });
    expect(info.features).toContain('replica-quorum');
    expect(info.features).toContain('read-router');
  });

  it('FT-V34-CLI-01 helpRoot has no cluster, no failover', () => {
    const text = helpRoot();
    expect(text).toMatch(/replica init\|status\|promote/);
    expect(text.toLowerCase()).not.toMatch(/\bcluster\b/);
    expect(text.toLowerCase()).not.toMatch(/\bfailover\b/);
    expect(text.toLowerCase()).toMatch(/no auto promote/);
  });
});

describe('v3.4.0 replication hardening', () => {
  it(
    'FT-V34-QUO-01 insert without secondary → QUORUM_FAILED, retryable, not replicated',
    async () => {
      const storagePath = await tmpDir();
      const db = await open({ storagePath, replica: { quorum: 2 } });
      await db.replicaInit({ role: 'primary' });
      let err: unknown;
      try {
        await db.insert('docs', { _id: 'q1', name: 'solo' });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ code: ErrorCode.QUORUM_FAILED });
      expect(isRetryableError(err)).toBe(true);
      const status = db.replicaStatus();
      expect(status.replicated).toBe(false);
      expect(status.quorumAcked).toBeLessThan(status.quorum);
      await db.close();
    },
    15_000,
  );

  it('FT-V34-ROUTE-01 ReadRouter — write primary only; read secondary when lag ok', async () => {
    const primaryPath = await tmpDir();
    const secondaryPath = await tmpDir();
    const primary = await open({
      storagePath: primaryPath,
      replica: { syncIntervalMs: 50 },
    });
    const secondary = await open({
      storagePath: secondaryPath,
      replica: { syncIntervalMs: 50 },
    });
    await primary.replicaInit({ role: 'primary' });
    await secondary.replicaInit({ role: 'secondary', primaryPath });

    let primaryWrites = 0;
    let secondaryWrites = 0;
    let primaryReads = 0;
    let secondaryReads = 0;

    const primaryEp = {
      insert: async (collection: string, data: Record<string, unknown>) => {
        primaryWrites += 1;
        return primary.insert(collection, data);
      },
      findById: async (collection: string, id: string) => {
        primaryReads += 1;
        return primary.findById(collection, id);
      },
      replicaStatus: () => primary.replicaStatus(),
    };
    const secondaryEp = {
      insert: async (collection: string, data: Record<string, unknown>) => {
        secondaryWrites += 1;
        return secondary.insert(collection, data);
      },
      findById: async (collection: string, id: string) => {
        secondaryReads += 1;
        return secondary.findById(collection, id);
      },
      replicaStatus: () => secondary.replicaStatus(),
    };

    const router = new ReadRouter(primaryEp, secondaryEp, {
      lagThresholdEntries: 10,
      onLag: 'fail',
    });

    const written = (await router.write('docs', {
      _id: 'r1',
      name: 'routed',
    })) as Document;
    expect(written._id).toBe('r1');
    expect(primaryWrites).toBe(1);
    expect(secondaryWrites).toBe(0);

    await waitForReplica(secondary, 'r1');
    const read = await router.read('docs', 'r1');
    expect(read?.name).toBe('routed');
    expect(secondaryReads).toBe(1);
    expect(primaryReads).toBe(0);

    await primary.close();
    await secondary.close();
  });

  it('FT-V34-ROUTE-02 lag over threshold — onLag fail throws; onLag primary falls back', async () => {
    const primaryPath = await tmpDir();
    const secondaryPath = await tmpDir();
    const primary = await open({ storagePath: primaryPath });
    const secondary = await open({
      storagePath: secondaryPath,
      replica: { syncIntervalMs: 60_000 },
    });
    await primary.replicaInit({ role: 'primary' });
    await secondary.replicaInit({ role: 'secondary', primaryPath });
    await primary.insert('docs', { _id: 'laggy', name: 'L' });

    const lagStatus = await secondary.replicaStatusFresh();
    expect(lagStatus.lagEntries).toBeGreaterThan(0);

    const failRouter = new ReadRouter(primary, secondary, {
      lagThresholdEntries: 0,
      onLag: 'fail',
    });
    await expect(failRouter.read('docs', 'laggy')).rejects.toMatchObject({
      code: ErrorCode.INVALID_CONFIG,
    });

    const primaryRouter = new ReadRouter(primary, secondary, {
      lagThresholdEntries: 0,
      onLag: 'primary',
    });
    expect((await primaryRouter.read('docs', 'laggy'))?.name).toBe('L');

    await primary.close();
    await secondary.close();
  });

  it('FT-V34-S3-01 createS3Plugin putCold/getCold round-trip same doc', async () => {
    const storagePath = await tmpDir();
    const coldRoot = await tmpDir();
    const db = await open({ storagePath, storageTiers: true });
    const plugin = createS3Plugin({ rootDir: coldRoot });
    db.registerPlugin(plugin);

    const doc = { _id: 'cold-1', name: 'frozen', _version: 1 } as Document;
    await plugin.putCold!('docs', doc);
    const back = await plugin.getCold!('docs', 'cold-1');
    expect(back).toMatchObject({ _id: 'cold-1', name: 'frozen' });

    // Point lookup recalls via registered storage plugin when hot misses.
    const recalled = await db.findById('docs', 'cold-1');
    expect(recalled).toMatchObject({ _id: 'cold-1', name: 'frozen' });
    await db.close();
  });

  it('FT-V34-S3-02 hot findable when getCold throws; unrecalled cold absent from hot query', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, storageTiers: true });
    db.registerPlugin({
      kind: 'storage',
      name: 's3',
      version: '0.1.0',
      stub: false,
      availableIn: '3.4',
      async putCold() {
        /* no-op */
      },
      async getCold() {
        throw new Error('object store unavailable');
      },
    });

    await db.insert('docs', { _id: 'hot', name: 'alive' });
    expect((await db.findById('docs', 'hot'))?.name).toBe('alive');

    // Unrecalled cold id is not in the hot store / query scan.
    expect(await db.findById('docs', 'only-in-cold')).toBeNull();
    const rows = await db.query({ collection: 'docs' });
    expect(rows.map((r) => r._id)).toEqual(['hot']);
    expect(rows.some((r) => r._id === 'only-in-cold')).toBe(false);
    await db.close();
  });

  it('FT-V34-AUD-01 secondary promote with operator → listAudit promote details', async () => {
    const primaryPath = await tmpDir();
    const secondaryPath = await tmpDir();
    const primary = await open({
      storagePath: primaryPath,
      replica: { syncIntervalMs: 50 },
    });
    const secondary = await open({
      storagePath: secondaryPath,
      replica: { syncIntervalMs: 50 },
    });
    await primary.replicaInit({ role: 'primary' });
    await secondary.replicaInit({ role: 'secondary', primaryPath });
    await primary.insert('docs', { _id: 'a', name: 'A' });
    await waitForReplica(secondary, 'a');
    await primary.close();

    await secondary.replicaPromote({ operator: 'ops-寒' });
    const audit = await secondary.listAudit({ action: 'promote' });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const entry = audit[audit.length - 1]!;
    expect(entry.action).toBe('promote');
    expect(typeof entry.ts).toBe('number');
    expect(entry.details).toMatchObject({
      operator: 'ops-寒',
      fromRole: 'secondary',
      toRole: 'primary',
    });
    await secondary.close();
  });

  it('FT-V34-DOC-01 three-node handbook steps match help/replica status fields', async () => {
    // Docs agent may expand README 三节点; assert against stable CLI handbook text.
    const replicaHelp = helpReplica();
    expect(replicaHelp).toMatch(/replica init --role primary\|secondary/);
    expect(replicaHelp).toMatch(/replica status/);
    expect(replicaHelp).toMatch(/lagEntries/);
    expect(replicaHelp).toMatch(/replica promote --yes/);
    expect(replicaHelp).toMatch(/quorum/);
    expect(replicaHelp.toLowerCase()).not.toMatch(/\bfailover\b/);

    const storagePath = await tmpDir();
    await cli(['init', '-p', storagePath]);
    await cli(['replica', 'init', '--role', 'primary', '-p', storagePath]);
    const status = await cli(['replica', 'status', '-p', storagePath, '--json']);
    expect(status.code).toBe(0);
    const body = JSON.parse(status.stdout) as ReplicaStatus;
    expect(body).toMatchObject({
      role: 'primary',
      quorum: expect.any(Number),
      quorumAcked: expect.any(Number),
      replicated: expect.any(Boolean),
      lagEntries: expect.any(Number),
    });
  });
});
