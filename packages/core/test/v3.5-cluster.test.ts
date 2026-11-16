import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  getCompatibilityInfo,
  getVersion,
  open,
  type JSONSQLite,
} from '../src/index.js';
import { validateConfig } from '../src/config/validate.js';
import { helpRoot } from '../src/cli/help.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsql-v35-'));
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

async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
  stepMs = 40,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await sleep(stepMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function openNode(
  root: string,
  nodeId: string,
  leaseMs = 1500,
): Promise<JSONSQLite> {
  const storagePath = path.join(root, 'nodes', nodeId);
  const clusterRoot = path.join(root, 'cluster');
  const db = await open({
    storagePath,
    cluster: { clusterRoot, nodeId, leaseMs, shardCount: 8 },
  });
  await db.clusterJoin();
  return db;
}

async function currentLeader(nodes: JSONSQLite[]): Promise<JSONSQLite> {
  const leaderId = await waitForUniqueLeader(nodes);
  const leader = nodes.find((n) => n.clusterStatus().nodeId === leaderId);
  if (!leader) throw new Error(`leader ${leaderId} missing`);
  return leader;
}

async function waitForUniqueLeader(
  nodes: JSONSQLite[],
  timeoutMs = 4000,
): Promise<string> {
  let leaderId = '';
  await waitUntil(async () => {
    const leaders = nodes
      .map((n) => n.clusterStatus())
      .filter((s) => s.role === 'leader' && s.leaderId === s.nodeId);
    if (leaders.length !== 1) return false;
    const id = leaders[0]!.leaderId;
    if (!id) return false;
    // All nodes agree on the same leaderId.
    const agree = nodes.every((n) => {
      const s = n.clusterStatus();
      return s.leaderId === id;
    });
    if (!agree) return false;
    leaderId = id;
    return true;
  }, timeoutMs);
  return leaderId;
}

describe('v3.5.0 gate', () => {
  it('FT-V35-GATE-01 RFC covers election, partition, rebalance, cross-node lock', async () => {
    const rfc = await fs.readFile(
      path.resolve(__dirname, '../../../devDocs/releases/v3.5.0/RFC-集群选主与分片.md'),
      'utf8',
    );
    expect(rfc).toMatch(/选主/);
    expect(rfc).toMatch(/分区/);
    expect(rfc).toMatch(/rebalance/i);
    expect(rfc).toMatch(/跨机锁/);
  });

  it('FT-V35-VER-01 version is 3.5.0 and not LTS', () => {
    const info = getCompatibilityInfo();
    expect(info.version).toBe(getVersion());
    expect(getVersion()).toBe('3.5.0');
    expect(info).toMatchObject({
      version: '3.5.0',
      lts: false,
      ltsLine: '2.5',
      cliSurface: '3.5.0',
      writers: 'single',
    });
    expect(info.features).toEqual(
      expect.arrayContaining([
        'cluster-election',
        'cluster-rebalance',
        'cluster-lock',
        'cli-3.5',
      ]),
    );
  });

  it('FT-V35-REG-01 cluster off — insert/find works like 3.4', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    expect(db.clusterStatus().enabled).toBe(false);
    await db.insert('docs', { _id: 'a', name: 'solo' });
    expect((await db.findById('docs', 'a'))?.name).toBe('solo');
    await db.close();
  });
});

describe('v3.5.0 cluster chaos', () => {
  it('FT-V35-CLU-01 three nodes elect exactly one leader', async () => {
    const root = await tmpDir();
    const a = await openNode(root, 'n1');
    const b = await openNode(root, 'n2');
    const c = await openNode(root, 'n3');
    const leaderId = await waitForUniqueLeader([a, b, c]);
    const leaders = [a, b, c]
      .map((n) => n.clusterStatus())
      .filter((s) => s.role === 'leader');
    expect(leaders).toHaveLength(1);
    expect(leaders[0]!.leaderId).toBe(leaderId);
    await a.close();
    await b.close();
    await c.close();
  });

  it('FT-V35-CLU-02 kill leader → new unique leader; committed doc still findable', async () => {
    const root = await tmpDir();
    const a = await openNode(root, 'n1', 400);
    const b = await openNode(root, 'n2', 400);
    const c = await openNode(root, 'n3', 400);
    const leaderId = await waitForUniqueLeader([a, b, c]);
    const nodes = { n1: a, n2: b, n3: c } as Record<string, JSONSQLite>;
    const leader = nodes[leaderId]!;
    await leader.insert('docs', { _id: 'keep', name: 'committed' });

    // Kill primary: stop heartbeats / close without keeping a write lease.
    await leader.close();

    const live = [a, b, c].filter((n) => n !== leader);
    const newLeaderId = await waitForUniqueLeader(live, 8000);
    expect(newLeaderId).not.toBe(leaderId);
    const reader = live.find((n) => n.clusterStatus().nodeId === newLeaderId)!;
    await waitUntil(async () => {
      const doc = await reader.findById('docs', 'keep');
      return doc?.name === 'committed';
    }, 3000);
    expect((await reader.findById('docs', 'keep'))?.name).toBe('committed');
    for (const n of live) await n.close();
  });

  it('FT-V35-CLU-03 partition minority cannot write; majority leader writes; no dual success', async () => {
    const root = await tmpDir();
    const a = await openNode(root, 'n1');
    const b = await openNode(root, 'n2');
    const c = await openNode(root, 'n3');
    const leaderId = await waitForUniqueLeader([a, b, c]);
    const nodes = [a, b, c];
    const leader = nodes.find((n) => n.clusterStatus().nodeId === leaderId)!;
    const minority = nodes.find((n) => n !== leader)!;
    const other = nodes.find((n) => n !== leader && n !== minority)!;

    minority.clusterSetPartitioned(true);
    await sleep(400);

    await expect(minority.insert('docs', { _id: 'bad', name: 'x' })).rejects.toMatchObject({
      code: expect.stringMatching(/CLUSTER_PARTITION|NOT_PRIMARY/),
    });

    // Majority still has a writable leader (leader or re-elected other).
    await waitForUniqueLeader([leader, other], 5000);
    const writable = [leader, other].find((n) => {
      try {
        n.clusterStatus();
        const s = n.clusterStatus();
        return s.role === 'leader' && s.leaderId === s.nodeId;
      } catch {
        return false;
      }
    });
    expect(writable).toBeTruthy();
    await writable!.insert('docs', { _id: 'ok', name: 'maj' });

    let successes = 0;
    for (const n of [leader, other, minority]) {
      try {
        await n.insert('docs', { _id: `dual-${n.clusterStatus().nodeId}`, name: 'race' });
        successes += 1;
      } catch {
        // expected on non-leader / partitioned
      }
    }
    expect(successes).toBeLessThanOrEqual(1);

    await a.close();
    await b.close();
    await c.close();
  });

  it('FT-V35-CLU-04 rebalance keeps doc count; query during migrate → SHARD_MOVING or full result', async () => {
    const root = await tmpDir();
    const nodes = [
      await openNode(root, 'n1'),
      await openNode(root, 'n2'),
      await openNode(root, 'n3'),
    ];
    let leader = await currentLeader(nodes);
    for (let i = 0; i < 6; i++) {
      leader = await currentLeader(nodes);
      await leader.insert('docs', { _id: `d${i}`, n: i });
    }
    leader = await currentLeader(nodes);
    const before = (await leader.query({ collection: 'docs' })).length;
    expect(before).toBe(6);

    leader = await currentLeader(nodes);
    await leader.clusterRebalance();
    const after = (await leader.query({ collection: 'docs' })).length;
    expect(after).toBe(before);

    let sawMoving = false;
    let sawFull = false;
    leader = await currentLeader(nodes);
    await leader.clusterRunWithMigrating(async () => {
      try {
        const rows = await leader.query({ collection: 'docs' });
        if (rows.length === before) sawFull = true;
      } catch (err) {
        if ((err as { code?: string }).code === ErrorCode.SHARD_MOVING) {
          sawMoving = true;
        } else {
          throw err;
        }
      }
    });
    expect(sawMoving || sawFull).toBe(true);
    expect((await leader.query({ collection: 'docs' })).length).toBe(before);

    for (const n of nodes) await n.close();
  });

  it('FT-V35-CLU-05 lock conflict CLUSTER_LOCK_CONFLICT; holder write survives', async () => {
    const root = await tmpDir();
    const a = await openNode(root, 'n1');
    const b = await openNode(root, 'n2');
    const c = await openNode(root, 'n3');
    const leaderId = await waitForUniqueLeader([a, b, c]);
    const leader = [a, b, c].find((n) => n.clusterStatus().nodeId === leaderId)!;
    const other = [a, b, c].find((n) => n !== leader)!;

    await leader.clusterAcquireLock('docs/held');
    await expect(other.clusterAcquireLock('docs/held')).rejects.toMatchObject({
      code: ErrorCode.CLUSTER_LOCK_CONFLICT,
    });
    await leader.insert('docs', { _id: 'held', name: 'mine' });
    expect((await leader.findById('docs', 'held'))?.name).toBe('mine');
    await leader.clusterReleaseLock('docs/held');

    await a.close();
    await b.close();
    await c.close();
  });

  it('FT-V35-ADV-01 advise mentions skew/倾斜; rebalance not auto-called', async () => {
    const root = await tmpDir();
    const a = await openNode(root, 'n1');
    const b = await openNode(root, 'n2');
    await waitForUniqueLeader([a, b]);
    const spy = vi.spyOn(a, 'clusterRebalance');
    const advice = await a.advise({ collection: 'docs', filter: { n: 1 } });
    expect(
      advice.some(
        (x) =>
          /倾斜|skew/i.test(x.message) ||
          (typeof x.suggestion === 'object' &&
            x.suggestion !== null &&
            'action' in x.suggestion &&
            (x.suggestion as { action?: string }).action === 'cluster.rebalance'),
      ),
    ).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await a.close();
    await b.close();
  });
});

describe('v3.5.0 CLI and config', () => {
  it('FT-V35-CLI-01 helpRoot does not list cluster as default available', () => {
    const text = helpRoot();
    expect(text).not.toMatch(/cluster status/);
    expect(text).not.toMatch(/cluster join/);
    // Root Commands block must not advertise cluster as always-on.
    const commands = text.slice(text.indexOf('Commands:'), text.indexOf('Exit codes:'));
    expect(commands).not.toMatch(/^\s*cluster\b/m);
  });

  it('FT-V35-CLI-02 with cluster on, cluster status --json works', async () => {
    const root = await tmpDir();
    const storagePath = path.join(root, 'node');
    const clusterRoot = path.join(root, 'cluster');
    await cli(['init', '-p', storagePath]);
    const join = await cli([
      'cluster',
      'join',
      '--cluster-root',
      clusterRoot,
      '-p',
      storagePath,
      '--json',
    ]);
    expect(join.code).toBe(0);
    const status = await cli([
      'cluster',
      'status',
      '--cluster-root',
      clusterRoot,
      '-p',
      storagePath,
      '--json',
    ]);
    expect(status.code).toBe(0);
    const body = JSON.parse(status.stdout) as {
      enabled: boolean;
      role: string;
      nodeId: string;
    };
    expect(body.enabled).toBe(true);
    expect(body.nodeId).toBeTruthy();
    expect(['leader', 'follower', 'none']).toContain(body.role);
  });

  it('FT-V35-CFG-01 validateConfig accepts cluster/wasm false; rejects raft', () => {
    expect(() =>
      validateConfig({ storagePath: './data', cluster: false, wasm: false }),
    ).not.toThrow();
    expect(() => validateConfig({ storagePath: './data', raft: true })).toThrow(
      /Rejected dangerous config key/,
    );
  });
});
