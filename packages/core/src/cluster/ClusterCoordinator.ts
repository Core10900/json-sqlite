import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document } from '../types/index.js';
import { ClusterLock } from './ClusterLock.js';
import { ShardManager, type ClusterMemberRef, type ShardMapFile } from './ShardManager.js';

export type ClusterRole = 'none' | 'leader' | 'follower';

export interface ClusterMember {
  nodeId: string;
  storagePath: string;
}

export interface ClusterMetaFile {
  clusterId: string;
  members: ClusterMember[];
  shardVersion: number;
}

export interface ElectionFile {
  term: number;
  leaderId: string | null;
  leaseUntil: number;
  voters: string[];
}

export interface ClusterMemberLocal {
  enabled: boolean;
  nodeId: string;
  clusterRoot: string;
  role: ClusterRole;
}

export interface ClusterStatus {
  enabled: boolean;
  nodeId: string;
  role: ClusterRole;
  leaderId: string | null;
  term: number;
  leaseUntil: number;
  members: ClusterMember[];
  shardVersion: number;
  migrating: boolean;
}

export interface ClusterCoordinatorOpts {
  storagePath: string;
  clusterRoot: string;
  nodeId?: string;
  leaseMs?: number;
  shardCount?: number;
  /** Election / heartbeat tick interval. Default max(50, leaseMs/4). */
  tickMs?: number;
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ClusterCoordinator {
  readonly clusterRoot: string;
  readonly storagePath: string;
  private _nodeId: string;
  readonly leaseMs: number;
  private readonly tickMs: number;
  private joined = false;
  private role: ClusterRole = 'none';
  private partitioned = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private term = 0;
  private leaderId: string | null = null;
  private leaseUntil = 0;
  private members: ClusterMember[] = [];
  private shardVersion = 0;
  readonly shards: ShardManager;
  readonly locks: ClusterLock;

  constructor(opts: ClusterCoordinatorOpts) {
    this.storagePath = path.resolve(opts.storagePath);
    this.clusterRoot = path.resolve(opts.clusterRoot);
    this._nodeId = opts.nodeId ?? randomUUID().slice(0, 8);
    this.leaseMs = Math.max(50, opts.leaseMs ?? 2000);
    this.tickMs = Math.max(20, opts.tickMs ?? Math.max(50, Math.floor(this.leaseMs / 4)));
    this.shards = new ShardManager(this.clusterRoot, opts.shardCount ?? 16);
    this.locks = new ClusterLock(this.clusterRoot, this.leaseMs * 2);
  }

  get nodeId(): string {
    return this._nodeId;
  }

  /** Shared data plane root (Option B). */
  dataRoot(): string {
    return path.join(this.clusterRoot, 'data');
  }

  sharedDocPath(collection: string, id: string): string {
    return path.join(this.dataRoot(), collection, `${id}.json`);
  }

  async replicateDoc(
    collection: string,
    id: string,
    doc: Document | null,
  ): Promise<void> {
    if (!this.joined || this.partitioned) return;
    const file = this.sharedDocPath(collection, id);
    if (doc === null) {
      await fs.rm(file, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(doc, null, 2), 'normal');
  }

  async readSharedDoc(collection: string, id: string): Promise<Document | null> {
    const doc = await readJsonFile<Document>(this.sharedDocPath(collection, id));
    return doc;
  }

  setPartitioned(value: boolean): void {
    this.partitioned = value;
  }

  isPartitioned(): boolean {
    return this.partitioned;
  }

  assertWritable(): void {
    if (!this.joined) return;
    if (this.partitioned) {
      throw new JSONSQLiteError(
        ErrorCode.CLUSTER_PARTITION,
        'Cluster node is partitioned; writes are refused',
        { nodeId: this.nodeId, role: this.role },
      );
    }
    // Sync-refresh from election file so short leases stay accurate between ticks.
    this.refreshLeadershipFromDisk();
    const now = Date.now();
    if (this.role !== 'leader' || this.leaderId !== this.nodeId || this.leaseUntil < now) {
      throw new JSONSQLiteError(
        ErrorCode.NOT_PRIMARY,
        'Not cluster primary; writes are refused',
        {
          nodeId: this.nodeId,
          role: this.role,
          leaderId: this.leaderId,
          leaseUntil: this.leaseUntil,
        },
      );
    }
  }

  /** Best-effort sync read of election.json into in-memory leadership fields. */
  private refreshLeadershipFromDisk(): void {
    try {
      const raw = fsSync.readFileSync(this.electionPath(), 'utf8');
      const election = JSON.parse(raw) as ElectionFile;
      const now = Date.now();
      if (election.leaderId && election.leaseUntil >= now) {
        this.term = election.term;
        this.leaderId = election.leaderId;
        this.leaseUntil = election.leaseUntil;
        this.role = election.leaderId === this.nodeId ? 'leader' : 'follower';
        return;
      }
      if (this.leaseUntil < now) {
        this.leaderId = election.leaderId ?? this.leaderId;
        this.role = 'none';
      }
    } catch {
      // missing / torn — keep cached fields
    }
  }

  status(): ClusterStatus {
    const shardMap = this.shards.getMap();
    return {
      enabled: this.joined,
      nodeId: this.nodeId,
      role: this.joined ? this.role : 'none',
      leaderId: this.joined ? this.leaderId : null,
      term: this.term,
      leaseUntil: this.leaseUntil,
      members: [...this.members],
      shardVersion: this.shardVersion || shardMap.version,
      migrating: this.shards.isMigrating(),
    };
  }

  /** Resume membership if a prior join left meta/cluster-member.json enabled. */
  async maybeResume(): Promise<boolean> {
    const local = await readJsonFile<ClusterMemberLocal>(this.memberLocalPath());
    if (!local?.enabled) return false;
    if (path.resolve(local.clusterRoot) !== this.clusterRoot) return false;
    if (local.nodeId) this._nodeId = local.nodeId;
    await this.join();
    return true;
  }

  async join(): Promise<ClusterStatus> {
    if (this.joined) {
      await this.tick();
      return this.status();
    }
    await fs.mkdir(path.join(this.clusterRoot, 'meta'), { recursive: true });
    await fs.mkdir(path.join(this.clusterRoot, 'votes'), { recursive: true });
    await fs.mkdir(path.join(this.clusterRoot, 'locks'), { recursive: true });
    await fs.mkdir(path.join(this.clusterRoot, 'heartbeats'), { recursive: true });
    await fs.mkdir(this.dataRoot(), { recursive: true });

    const meta = await this.readOrInitMeta();
    const existing = meta.members.find((m) => m.nodeId === this.nodeId);
    if (!existing) {
      meta.members.push({ nodeId: this.nodeId, storagePath: this.storagePath });
    } else {
      existing.storagePath = this.storagePath;
    }
    await this.writeMeta(meta);
    this.members = meta.members;
    this.shardVersion = meta.shardVersion;
    await this.shards.load();

    this.joined = true;
    await this.persistMemberLocal();
    this.start();
    // Kick an immediate election/heartbeat so status settles quickly in tests.
    await this.tick();
    return this.status();
  }

  async leave(): Promise<ClusterStatus> {
    this.stop();
    if (!this.partitioned) {
      try {
        const meta = await this.readOrInitMeta();
        meta.members = meta.members.filter((m) => m.nodeId !== this.nodeId);
        await this.writeMeta(meta);
        this.members = meta.members;
        await fs.rm(this.heartbeatPath(), { force: true });
        if (this.leaderId === this.nodeId) {
          await this.writeElection({
            term: this.term,
            leaderId: null,
            leaseUntil: 0,
            voters: [],
          });
        }
      } catch {
        // best-effort leave
      }
    }
    this.joined = false;
    this.role = 'none';
    this.leaderId = null;
    this.leaseUntil = 0;
    await this.persistMemberLocal();
    return this.status();
  }

  start(): void {
    this.stop();
    if (!this.joined) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resignLeadershipSync();
  }

  /** Awaitable stop used by db.close() so lease clear finishes before handle is dropped. */
  async stopAndResign(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resignLeadershipSync();
    try {
      await fs.rm(this.heartbeatPath(), { force: true });
    } catch {
      // ignore
    }
  }

  private resignLeadershipSync(): void {
    if (this.joined && this.role === 'leader' && !this.partitioned) {
      try {
        fsSync.mkdirSync(path.dirname(this.electionPath()), { recursive: true });
        fsSync.writeFileSync(
          this.electionPath(),
          JSON.stringify(
            { term: this.term, leaderId: null, leaseUntil: 0, voters: [] },
            null,
            2,
          ),
          'utf8',
        );
      } catch {
        // best-effort
      }
    }
    try {
      fsSync.rmSync(this.heartbeatPath(), { force: true });
    } catch {
      // ignore
    }
    if (this.role === 'leader') {
      this.role = 'none';
      this.leaderId = null;
      this.leaseUntil = 0;
    }
  }

  async rebalance(): Promise<ShardMapFile> {
    if (!this.joined) {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        'cluster rebalance requires join',
      );
    }
    this.assertWritable();
    const map = await this.shards.rebalance(this.members as ClusterMemberRef[]);
    this.shardVersion = map.version;
    const meta = await this.readOrInitMeta();
    meta.shardVersion = map.version;
    await this.writeMeta(meta);
    return map;
  }

  async acquireLock(scope: string): Promise<void> {
    if (!this.joined) {
      throw new JSONSQLiteError(ErrorCode.INVALID_CONFIG, 'cluster lock requires join');
    }
    await this.locks.acquire(scope, this.nodeId);
  }

  async releaseLock(scope: string): Promise<void> {
    if (!this.joined) {
      throw new JSONSQLiteError(ErrorCode.INVALID_CONFIG, 'cluster lock requires join');
    }
    await this.locks.release(scope, this.nodeId);
  }

  /** Detect shard ownership skew for Advisor (does not rebalance). */
  async detectSkew(): Promise<boolean> {
    if (!this.joined) return false;
    try {
      const meta = await this.readOrInitMeta();
      this.members = meta.members;
    } catch {
      // keep cached members
    }
    return this.shards.isSkewed(this.members as ClusterMemberRef[]);
  }

  async tick(): Promise<void> {
    if (!this.joined || this.ticking) return;
    this.ticking = true;
    try {
      if (this.partitioned) {
        // Cannot refresh lease or vote while partitioned.
        const now = Date.now();
        if (this.role === 'leader' && this.leaseUntil < now) {
          this.role = 'none';
          this.leaderId = null;
        } else if (this.role === 'leader') {
          // Drop leadership locally when partitioned so we stop accepting writes.
          this.role = 'none';
        }
        return;
      }

      await this.writeHeartbeat();
      const meta = await this.readOrInitMeta();
      this.members = meta.members;
      this.shardVersion = meta.shardVersion;

      const election = (await readJsonFile<ElectionFile>(this.electionPath())) ?? {
        term: 0,
        leaderId: null,
        leaseUntil: 0,
        voters: [],
      };
      const now = Date.now();

      if (
        election.leaderId &&
        election.leaseUntil >= now &&
        meta.members.some((m) => m.nodeId === election.leaderId)
      ) {
        this.term = election.term;
        this.leaderId = election.leaderId;
        this.leaseUntil = election.leaseUntil;
        if (election.leaderId === this.nodeId) {
          this.role = 'leader';
          await this.writeElection({
            term: election.term,
            leaderId: this.nodeId,
            leaseUntil: now + this.leaseMs,
            voters: election.voters,
          });
          this.leaseUntil = now + this.leaseMs;
        } else {
          this.role = 'follower';
        }
        return;
      }

      // Lease expired or missing — elect.
      await this.elect(meta, election, now);
    } finally {
      this.ticking = false;
    }
  }

  private async elect(
    meta: ClusterMetaFile,
    prev: ElectionFile,
    now: number,
  ): Promise<void> {
    const n = meta.members.length;
    if (n === 0) {
      this.role = 'none';
      this.leaderId = null;
      return;
    }
    const majority = Math.floor(n / 2) + 1;
    const live = await this.liveMemberIds(meta.members, now);
    if (live.length < majority) {
      this.role = 'none';
      this.leaderId = null;
      this.leaseUntil = 0;
      return;
    }

    // Deterministic candidate among live members — only that node claims the lease.
    // Avoid multi-round vote files (they raced under load and left the cluster leaderless).
    const candidate = [...live].sort()[0]!;
    if (candidate !== this.nodeId) {
      await sleep(Math.min(60, this.tickMs));
      const election = await readJsonFile<ElectionFile>(this.electionPath());
      if (
        election &&
        election.leaderId === candidate &&
        election.leaseUntil >= Date.now()
      ) {
        this.term = election.term;
        this.leaderId = election.leaderId;
        this.leaseUntil = election.leaseUntil;
        this.role = 'follower';
        return;
      }
      // Candidate has not claimed yet; stay neutral until next tick.
      this.role = 'none';
      this.leaderId = null;
      this.leaseUntil = 0;
      return;
    }

    const term = Math.max(prev.term, this.term) + 1;
    const leaseUntil = now + this.leaseMs;
    await this.writeElection({
      term,
      leaderId: this.nodeId,
      leaseUntil,
      voters: live,
    });
    // Confirm we still own the file (another claim should not happen for same candidate).
    const confirm = await readJsonFile<ElectionFile>(this.electionPath());
    if (
      confirm &&
      confirm.leaderId === this.nodeId &&
      confirm.leaseUntil >= Date.now()
    ) {
      this.term = confirm.term;
      this.leaderId = this.nodeId;
      this.leaseUntil = confirm.leaseUntil;
      this.role = 'leader';
      return;
    }
    this.role = 'none';
    this.leaderId = null;
    this.leaseUntil = 0;
  }

  private async liveMemberIds(members: ClusterMember[], now: number): Promise<string[]> {
    const freshMs = this.leaseMs * 2;
    const live: string[] = [];
    for (const m of members) {
      if (m.nodeId === this.nodeId) {
        live.push(m.nodeId);
        continue;
      }
      const hb = await readJsonFile<{ nodeId: string; term: number; at: number }>(
        path.join(this.clusterRoot, 'heartbeats', `${m.nodeId}.json`),
      );
      if (hb && now - hb.at <= freshMs) live.push(m.nodeId);
    }
    return live;
  }

  private heartbeatPath(): string {
    return path.join(this.clusterRoot, 'heartbeats', `${this.nodeId}.json`);
  }

  private electionPath(): string {
    return path.join(this.clusterRoot, 'meta', 'election.json');
  }

  private metaPath(): string {
    return path.join(this.clusterRoot, 'meta', 'cluster.json');
  }

  private memberLocalPath(): string {
    return path.join(this.storagePath, 'meta', 'cluster-member.json');
  }

  private async writeHeartbeat(): Promise<void> {
    await writeFileAtomic(
      this.heartbeatPath(),
      JSON.stringify(
        { nodeId: this.nodeId, term: this.term, at: Date.now() },
        null,
        2,
      ),
      'normal',
    );
  }

  private async writeElection(body: ElectionFile): Promise<void> {
    await writeFileAtomic(
      this.electionPath(),
      JSON.stringify(body, null, 2),
      'normal',
    );
  }

  private async readOrInitMeta(): Promise<ClusterMetaFile> {
    const existing = await readJsonFile<ClusterMetaFile>(this.metaPath());
    if (existing) return existing;
    const fresh: ClusterMetaFile = {
      clusterId: randomUUID(),
      members: [],
      shardVersion: 0,
    };
    await this.writeMeta(fresh);
    return fresh;
  }

  private async writeMeta(meta: ClusterMetaFile): Promise<void> {
    await writeFileAtomic(this.metaPath(), JSON.stringify(meta, null, 2), 'normal');
  }

  private async persistMemberLocal(): Promise<void> {
    await fs.mkdir(path.dirname(this.memberLocalPath()), { recursive: true });
    const body: ClusterMemberLocal = {
      enabled: this.joined,
      nodeId: this.nodeId,
      clusterRoot: this.clusterRoot,
      role: this.role,
    };
    await writeFileAtomic(
      this.memberLocalPath(),
      JSON.stringify(body, null, 2),
      'normal',
    );
  }
}
