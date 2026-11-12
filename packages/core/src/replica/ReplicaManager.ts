import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { ChangeEntry } from '../storage/ChangeLog.js';
import { applyPatchDoc } from '../storage/ChangeLog.js';
import type { Document } from '../types/index.js';

/** On-disk replication log format version (MAJOR vs 3.2 when enabled). */
export const REPLICA_LOG_FORMAT = 1;

/** How long primary waits for secondary quorum acks after append. */
export const QUORUM_WAIT_MS = 2000;

export type ReplicaRole = 'none' | 'primary' | 'secondary';

export interface ReplicaStateFile {
  enabled: boolean;
  role: 'primary' | 'secondary';
  primaryPath: string | null;
  appliedLsn: number;
  appliedTs: number;
  promotedAt: number | null;
}

export interface ReplicaStatus {
  enabled: boolean;
  role: ReplicaRole;
  primaryPath: string | null;
  appliedLsn: number;
  appliedTs: number;
  lastLsn: number;
  lastTs: number;
  /** Lag in log entry count. Unit: entries. */
  lagEntries: number;
  /** Lag in time between primary tip and applied prefix. Unit: milliseconds. */
  lagMs: number;
  /** Safe applied prefix LSN. */
  replicatedPrefix: number;
  promotedAt: number | null;
  syncIntervalMs: number;
  /**
   * Configured acknowledgements including primary.
   * Default 1 = primary-local only (no secondary wait).
   */
  quorum: number;
  /**
   * Acknowledgements for the tip LSN, including the primary as 1 when tip > 0
   * (or when role is primary and enabled). Secondaries contribute via ack files.
   */
  quorumAcked: number;
  /**
   * True when the tip is considered replicated for the configured quorum.
   * With quorum <= 1 this is true once the primary has the local tip.
   */
  replicated: boolean;
}

export interface ReplicaLogEntry {
  v: number;
  lsn: number;
  ts: number;
  op: 'insert' | 'update' | 'delete';
  collection: string;
  id: string;
  before?: Document | Record<string, unknown> | null;
  after?: Document | Record<string, unknown> | null;
  patch?: boolean;
}

export interface ReplicaApplyHooks {
  ensureCollection: (name: string) => Promise<void>;
  getById: (collection: string, id: string) => Promise<Document | null>;
  insert: (collection: string, data: Record<string, unknown>) => Promise<Document>;
  update: (
    collection: string,
    id: string,
    patch: Record<string, unknown>,
  ) => Promise<Document>;
  delete: (collection: string, id: string) => Promise<boolean>;
  replaceDoc: (collection: string, doc: Document) => Promise<void>;
}

export interface ReplicaAckFile {
  appliedLsn: number;
  appliedTs: number;
}

function stateFile(root: string): string {
  return path.join(root, 'meta', 'replica.json');
}

function logDir(root: string): string {
  return path.join(root, 'replication');
}

function logFile(root: string): string {
  return path.join(logDir(root), 'log.jsonl');
}

function logMetaFile(root: string): string {
  return path.join(logDir(root), 'meta.json');
}

function ackDir(root: string): string {
  return path.join(logDir(root), 'acks');
}

export function secondaryAckId(storagePath: string): string {
  return createHash('sha256').update(path.resolve(storagePath)).digest('hex').slice(0, 16);
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

export class ReplicaManager {
  private state: ReplicaStateFile | null = null;
  private lastLsn = 0;
  private lastTs = 0;
  private tipLsn = 0;
  private tipTs = 0;
  private applying = false;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private readonly syncIntervalMs: number;
  private readonly quorum: number;

  constructor(
    private readonly storagePath: string,
    opts?: { syncIntervalMs?: number; quorum?: number },
  ) {
    this.syncIntervalMs = Math.max(10, opts?.syncIntervalMs ?? 100);
    this.quorum = Math.max(0, opts?.quorum ?? 1);
  }

  get isApplying(): boolean {
    return this.applying;
  }

  async load(): Promise<void> {
    this.state = await readJsonFile<ReplicaStateFile>(stateFile(this.storagePath));
    if (this.state?.role === 'primary') {
      const meta = await readJsonFile<{ formatVersion: number; lastLsn: number; lastTs?: number }>(
        logMetaFile(this.storagePath),
      );
      this.lastLsn = meta?.lastLsn ?? 0;
      this.lastTs = meta?.lastTs ?? 0;
      this.tipLsn = this.lastLsn;
      this.tipTs = this.lastTs;
      this.state.appliedLsn = this.lastLsn;
      this.state.appliedTs = this.lastTs;
    } else if (this.state?.role === 'secondary') {
      this.lastLsn = this.state.appliedLsn;
      this.lastTs = this.state.appliedTs;
      await this.refreshTipFromPrimary();
    }
  }

  async init(opts: {
    role: 'primary' | 'secondary';
    primaryPath?: string;
  }): Promise<ReplicaStatus> {
    if (opts.role === 'secondary') {
      if (!opts.primaryPath) {
        throw new JSONSQLiteError(
          ErrorCode.INVALID_CONFIG,
          'replica init --role secondary requires --primary-path',
        );
      }
      const primary = path.resolve(opts.primaryPath);
      if (primary === path.resolve(this.storagePath)) {
        throw new JSONSQLiteError(
          ErrorCode.INVALID_CONFIG,
          'secondary primaryPath must differ from this storagePath',
        );
      }
      this.state = {
        enabled: true,
        role: 'secondary',
        primaryPath: primary,
        appliedLsn: 0,
        appliedTs: 0,
        promotedAt: null,
      };
    } else {
      await fs.mkdir(logDir(this.storagePath), { recursive: true });
      const existing = await readJsonFile<{ lastLsn: number; lastTs?: number }>(
        logMetaFile(this.storagePath),
      );
      this.lastLsn = existing?.lastLsn ?? 0;
      this.lastTs = existing?.lastTs ?? 0;
      await this.writeLogMeta();
      this.state = {
        enabled: true,
        role: 'primary',
        primaryPath: null,
        appliedLsn: this.lastLsn,
        appliedTs: this.lastTs,
        promotedAt: null,
      };
      this.tipLsn = this.lastLsn;
      this.tipTs = this.lastTs;
    }
    await this.persistState();
    return this.status();
  }

  async promote(): Promise<ReplicaStatus> {
    if (!this.state?.enabled || this.state.role !== 'secondary') {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        'replica promote requires an initialized secondary',
      );
    }
    this.stopSync();
    await fs.mkdir(logDir(this.storagePath), { recursive: true });
    this.lastLsn = this.state.appliedLsn;
    this.lastTs = this.state.appliedTs;
    this.tipLsn = this.lastLsn;
    this.tipTs = this.lastTs;
    await this.writeLogMeta();
    this.state = {
      enabled: true,
      role: 'primary',
      primaryPath: null,
      appliedLsn: this.lastLsn,
      appliedTs: this.lastTs,
      promotedAt: Date.now(),
    };
    await this.persistState();
    return this.status();
  }

  assertWritable(): void {
    if (this.applying) return;
    if (this.state?.enabled && this.state.role === 'secondary') {
      throw new JSONSQLiteError(
        ErrorCode.REPLICA_READONLY,
        'Secondary replica is read-only until replica promote; writes are refused',
        { role: 'secondary', appliedLsn: this.state.appliedLsn },
      );
    }
  }

  role(): ReplicaRole {
    if (!this.state?.enabled) return 'none';
    return this.state.role;
  }

  enabled(): boolean {
    return this.state?.enabled === true;
  }

  status(): ReplicaStatus {
    const enabled = this.state?.enabled === true;
    const role: ReplicaRole = enabled ? this.state!.role : 'none';
    const appliedLsn = enabled
      ? role === 'primary'
        ? this.lastLsn
        : this.state!.appliedLsn
      : 0;
    const appliedTs = enabled
      ? role === 'primary'
        ? this.lastTs
        : this.state!.appliedTs
      : 0;
    const lastLsn = enabled ? (role === 'primary' ? this.lastLsn : this.tipLsn) : 0;
    const lastTs = enabled ? (role === 'primary' ? this.lastTs : this.tipTs) : 0;
    const base: ReplicaStatus = {
      enabled,
      role,
      primaryPath: this.state?.primaryPath ?? null,
      appliedLsn,
      appliedTs,
      lastLsn,
      lastTs,
      lagEntries: Math.max(0, lastLsn - appliedLsn),
      lagMs: Math.max(0, lastTs - appliedTs),
      replicatedPrefix: appliedLsn,
      promotedAt: this.state?.promotedAt ?? null,
      syncIntervalMs: this.syncIntervalMs,
      quorum: this.quorum,
      quorumAcked: 0,
      replicated: true,
    };
    if (!enabled) return base;
    if (role === 'secondary') {
      // Secondary: local catch-up view (not cluster quorum).
      base.quorumAcked = appliedLsn > 0 ? 1 : 0;
      base.replicated = lastLsn === 0 || appliedLsn >= lastLsn;
      return base;
    }
    // Primary: cached count from last wait/refresh (includes primary as 1).
    base.quorumAcked = this.cachedQuorumAcked;
    base.replicated = this.isReplicated(this.cachedQuorumAcked, lastLsn);
    return base;
  }

  private cachedQuorumAcked = 1;

  private isReplicated(quorumAcked: number, tipLsn: number): boolean {
    if (this.quorum <= 1) {
      // Primary-local only: local tip counts as replicated.
      return true;
    }
    if (tipLsn <= 0) return true;
    return quorumAcked >= this.quorum;
  }

  /** Refresh primary tip into status fields without applying entries. */
  async refreshStatus(): Promise<ReplicaStatus> {
    if (this.state?.enabled && this.state.role === 'secondary') {
      await this.refreshTipFromPrimary();
    } else if (this.state?.enabled && this.state.role === 'primary') {
      this.cachedQuorumAcked = await this.countQuorumAcks(this.lastLsn);
    }
    return this.status();
  }

  /** Append committed local changes on the primary. No-op when not primary. */
  async appendCommitted(entries: ChangeEntry[]): Promise<void> {
    if (this.applying) return;
    if (!this.state?.enabled || this.state.role !== 'primary') return;
    if (!entries.length) return;
    await fs.mkdir(logDir(this.storagePath), { recursive: true });
    const lines: string[] = [];
    for (const entry of entries) {
      if (entry.op !== 'insert' && entry.op !== 'update' && entry.op !== 'delete') {
        continue;
      }
      this.lastLsn += 1;
      this.lastTs = entry.ts;
      const row: ReplicaLogEntry = {
        v: REPLICA_LOG_FORMAT,
        lsn: this.lastLsn,
        ts: entry.ts,
        op: entry.op,
        collection: entry.collection,
        id: entry.id,
        before: entry.before ?? null,
        after: entry.after ?? null,
        patch: entry.patch === true,
      };
      lines.push(`${JSON.stringify(row)}\n`);
    }
    if (!lines.length) return;
    await fs.appendFile(logFile(this.storagePath), lines.join(''), 'utf8');
    this.tipLsn = this.lastLsn;
    this.tipTs = this.lastTs;
    this.state.appliedLsn = this.lastLsn;
    this.state.appliedTs = this.lastTs;
    await this.writeLogMeta();
    await this.persistState();
    await this.waitForQuorum(this.lastLsn);
  }

  startSync(hooks: ReplicaApplyHooks): void {
    this.stopSync();
    if (!this.state?.enabled || this.state.role !== 'secondary') return;
    // Do not sync on the first event-loop turn — callers/tests can observe lag
    // before the first pull. Background interval still catches up.
    this.syncTimer = setInterval(() => {
      void this.syncOnce(hooks).catch(() => undefined);
    }, this.syncIntervalMs);
    this.syncTimer.unref?.();
  }

  stopSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async syncOnce(hooks: ReplicaApplyHooks): Promise<number> {
    if (!this.state?.enabled || this.state.role !== 'secondary') return 0;
    const primary = this.state.primaryPath;
    if (!primary) return 0;
    await this.refreshTipFromPrimary();
    const entries = await readLogSince(primary, this.state.appliedLsn);
    if (!entries.length) {
      await this.writeAckToPrimary();
      return 0;
    }
    this.applying = true;
    try {
      for (const entry of entries) {
        await applyLogEntry(entry, hooks);
        this.state.appliedLsn = entry.lsn;
        this.state.appliedTs = entry.ts;
      }
      await this.persistState();
      await this.writeAckToPrimary();
      return entries.length;
    } finally {
      this.applying = false;
    }
  }

  private async waitForQuorum(targetLsn: number): Promise<void> {
    const secondaryNeeded = Math.max(0, this.quorum - 1);
    if (secondaryNeeded === 0) {
      this.cachedQuorumAcked = 1;
      return;
    }
    const deadline = Date.now() + QUORUM_WAIT_MS;
    let acked = await this.countQuorumAcks(targetLsn);
    while (acked < this.quorum && Date.now() < deadline) {
      await sleep(25);
      acked = await this.countQuorumAcks(targetLsn);
    }
    this.cachedQuorumAcked = acked;
    if (acked < this.quorum) {
      throw new JSONSQLiteError(
        ErrorCode.QUORUM_FAILED,
        `Quorum not met for LSN ${targetLsn}: need ${this.quorum}, have ${acked}`,
        {
          retryable: true,
          quorum: this.quorum,
          quorumAcked: acked,
          targetLsn,
        },
      );
    }
  }

  /** Primary local ack (1) + secondaries whose ack covers targetLsn. */
  private async countQuorumAcks(targetLsn: number): Promise<number> {
    if (targetLsn <= 0) return 1;
    const secondary = await this.countSecondaryAcks(targetLsn);
    return 1 + secondary;
  }

  private async countSecondaryAcks(targetLsn: number): Promise<number> {
    const dir = ackDir(this.storagePath);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    let count = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const ack = await readJsonFile<ReplicaAckFile>(path.join(dir, name));
      if (ack && typeof ack.appliedLsn === 'number' && ack.appliedLsn >= targetLsn) {
        count += 1;
      }
    }
    return count;
  }

  private async writeAckToPrimary(): Promise<void> {
    const primary = this.state?.primaryPath;
    if (!primary || !this.state) return;
    const id = secondaryAckId(this.storagePath);
    const dir = ackDir(primary);
    await fs.mkdir(dir, { recursive: true });
    const body: ReplicaAckFile = {
      appliedLsn: this.state.appliedLsn,
      appliedTs: this.state.appliedTs,
    };
    await writeFileAtomic(
      path.join(dir, `${id}.json`),
      JSON.stringify(body, null, 2),
      'normal',
    );
  }

  private async refreshTipFromPrimary(): Promise<void> {
    const primary = this.state?.primaryPath;
    if (!primary) return;
    const meta = await readJsonFile<{ lastLsn: number; lastTs?: number }>(
      logMetaFile(primary),
    );
    if (meta) {
      this.tipLsn = meta.lastLsn ?? 0;
      this.tipTs = meta.lastTs ?? 0;
      return;
    }
    const entries = await readLogSince(primary, 0);
    if (entries.length) {
      const last = entries[entries.length - 1]!;
      this.tipLsn = last.lsn;
      this.tipTs = last.ts;
    }
  }

  private async writeLogMeta(): Promise<void> {
    await writeFileAtomic(
      logMetaFile(this.storagePath),
      JSON.stringify(
        {
          formatVersion: REPLICA_LOG_FORMAT,
          lastLsn: this.lastLsn,
          lastTs: this.lastTs,
        },
        null,
        2,
      ),
      'normal',
    );
  }

  private async persistState(): Promise<void> {
    if (!this.state) return;
    await fs.mkdir(path.dirname(stateFile(this.storagePath)), { recursive: true });
    await writeFileAtomic(
      stateFile(this.storagePath),
      JSON.stringify(this.state, null, 2),
      'normal',
    );
  }
}

async function readLogSince(
  primaryRoot: string,
  afterLsn: number,
): Promise<ReplicaLogEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(logFile(primaryRoot), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: ReplicaLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ReplicaLogEntry;
      if (entry.lsn > afterLsn) out.push(entry);
    } catch {
      // skip torn / bad line
    }
  }
  return out;
}

async function applyLogEntry(
  entry: ReplicaLogEntry,
  hooks: ReplicaApplyHooks,
): Promise<void> {
  await hooks.ensureCollection(entry.collection);
  if (entry.op === 'insert') {
    const after = entry.after as Document | null | undefined;
    if (!after || typeof after !== 'object') {
      throw new JSONSQLiteError(
        ErrorCode.DATA_CORRUPT,
        `Replica insert LSN ${entry.lsn} missing after document`,
      );
    }
    const existing = await hooks.getById(entry.collection, entry.id);
    if (existing) {
      await hooks.replaceDoc(entry.collection, { ...after, _id: entry.id });
    } else {
      await hooks.insert(entry.collection, { ...after, _id: entry.id });
    }
    return;
  }
  if (entry.op === 'delete') {
    await hooks.delete(entry.collection, entry.id);
    return;
  }
  // update
  const current = await hooks.getById(entry.collection, entry.id);
  if (entry.patch) {
    const next = applyPatchDoc(current, {
      ts: entry.ts,
      op: 'update',
      collection: entry.collection,
      id: entry.id,
      before: entry.before,
      after: entry.after,
      patch: true,
    });
    if (next) {
      if (current) await hooks.replaceDoc(entry.collection, next);
      else await hooks.insert(entry.collection, next);
    }
    return;
  }
  const after = entry.after as Document | null | undefined;
  if (after && typeof after === 'object') {
    if (current) await hooks.replaceDoc(entry.collection, { ...after, _id: entry.id });
    else await hooks.insert(entry.collection, { ...after, _id: entry.id });
  }
}
