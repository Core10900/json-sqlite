import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Document, WriteOpType } from '../types/index.js';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';

export interface ChangeEntry {
  ts: number;
  op: WriteOpType;
  collection: string;
  id: string;
  /** Full document or field patch for insert/update. */
  before?: Document | Record<string, unknown> | null;
  after?: Document | Record<string, unknown> | null;
  /** True when before/after are field patches, not full documents. */
  patch?: boolean;
}

export interface DeltaSnapshot {
  ts: number;
  collection: string;
  docs: Document[];
  checksum: string;
  count: number;
}

export interface ChangeLogOptions {
  /** Generate a snapshot after this many new delta lines. Default 1000. */
  snapshotThreshold?: number;
  /** Drop deltas older than this many ms after a good snapshot. Default 7 days. */
  retentionMs?: number;
}

/** Append-only change log for backup incremental / time travel / PITR. */
export class ChangeLog {
  private readonly snapshotThreshold: number;
  private readonly retentionMs: number;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly storagePath: string,
    opts: ChangeLogOptions = {},
  ) {
    this.snapshotThreshold = Math.max(1, opts.snapshotThreshold ?? 1000);
    this.retentionMs = Math.max(0, opts.retentionMs ?? 7 * 86_400_000);
  }

  private file(collection: string): string {
    return path.join(this.storagePath, 'deltas', `${collection}.delta`);
  }

  private snapshotFile(collection: string): string {
    return path.join(this.storagePath, 'deltas', `${collection}.snapshot.json`);
  }

  /**
   * Record a change. For updates, only changed fields are stored when
   * both before and after are full documents.
   */
  async append(entry: ChangeEntry): Promise<void> {
    await this.appendMany([entry]);
  }

  /** Append many entries with one filesystem write per collection. */
  async appendMany(entries: ChangeEntry[]): Promise<void> {
    if (!entries.length) return;
    const byCollection = new Map<string, ChangeEntry[]>();
    for (const entry of entries) {
      const minimized = minimizeEntry(entry);
      const list = byCollection.get(minimized.collection) ?? [];
      list.push(minimized);
      byCollection.set(minimized.collection, list);
    }
    for (const [collection, list] of byCollection) {
      const file = this.file(collection);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const body = list.map((e) => `${JSON.stringify(e)}\n`).join('');
      await fs.appendFile(file, body, 'utf8');
      const next = (this.counts.get(collection) ?? 0) + list.length;
      this.counts.set(collection, next);
    }
  }

  needsSnapshot(collection: string): boolean {
    return (this.counts.get(collection) ?? 0) >= this.snapshotThreshold;
  }

  snapshotThresholdValue(): number {
    return this.snapshotThreshold;
  }

  async readSince(collection: string, sinceTs = 0): Promise<ChangeEntry[]> {
    const file = this.file(collection);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: ChangeEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ChangeEntry;
        if (e.ts >= sinceTs) out.push(e);
      } catch {
        // skip
      }
    }
    this.counts.set(collection, out.length);
    return out;
  }

  async readUntil(collection: string, untilTs: number): Promise<ChangeEntry[]> {
    const all = await this.readSince(collection, 0);
    return all.filter((e) => e.ts <= untilTs);
  }

  async count(collection: string): Promise<number> {
    if (this.counts.has(collection)) return this.counts.get(collection)!;
    const all = await this.readSince(collection, 0);
    return all.length;
  }

  async readSnapshot(collection: string): Promise<DeltaSnapshot | null> {
    try {
      const raw = await fs.readFile(this.snapshotFile(collection), 'utf8');
      return JSON.parse(raw) as DeltaSnapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Build a snapshot from `docs`. On checksum success, prune deltas older
   * than the retention window. On checksum failure, leave deltas alone.
   */
  async writeSnapshot(
    collection: string,
    docs: Document[],
  ): Promise<{ ok: boolean; snapshot: DeltaSnapshot | null }> {
    const payloadDocs = docs.map((d) => ({ ...d }));
    const body = JSON.stringify(payloadDocs);
    const checksum = createHash('sha256').update(body).digest('hex');
    const snapshot: DeltaSnapshot = {
      ts: Date.now(),
      collection,
      docs: payloadDocs,
      checksum,
      count: payloadDocs.length,
    };
    const encoded = JSON.stringify(snapshot);
    const verify = createHash('sha256')
      .update(JSON.stringify(snapshot.docs))
      .digest('hex');
    if (verify !== checksum) {
      return { ok: false, snapshot: null };
    }
    await writeFileAtomic(this.snapshotFile(collection), encoded, 'normal');
    const disk = await this.readSnapshot(collection);
    if (!disk || disk.checksum !== checksum) {
      return { ok: false, snapshot: null };
    }
    await this.pruneOlderThan(collection, Date.now() - this.retentionMs);
    this.counts.set(collection, 0);
    return { ok: true, snapshot: disk };
  }

  /**
   * Test helper: write a snapshot file with a bad checksum without pruning.
   */
  async writeCorruptSnapshot(collection: string, docs: Document[]): Promise<void> {
    const snapshot: DeltaSnapshot = {
      ts: Date.now(),
      collection,
      docs: docs.map((d) => ({ ...d })),
      checksum: 'bad',
      count: docs.length,
    };
    await writeFileAtomic(
      this.snapshotFile(collection),
      JSON.stringify(snapshot),
      'normal',
    );
  }

  async verifySnapshot(collection: string): Promise<boolean> {
    const snap = await this.readSnapshot(collection);
    if (!snap) return false;
    const sum = createHash('sha256')
      .update(JSON.stringify(snap.docs))
      .digest('hex');
    return sum === snap.checksum;
  }

  async pruneOlderThan(collection: string, cutoffTs: number): Promise<number> {
    const all = await this.readSince(collection, 0);
    const kept = all.filter((e) => e.ts >= cutoffTs);
    const removed = all.length - kept.length;
    if (removed === 0) return 0;
    const file = this.file(collection);
    const body = kept.map((e) => JSON.stringify(e)).join('\n');
    await writeFileAtomic(file, body ? `${body}\n` : '', 'normal');
    this.counts.set(collection, kept.length);
    return removed;
  }

  async maybeSnapshot(collection: string, docs?: Document[]): Promise<boolean> {
    if (!docs) return false;
    const result = await this.writeSnapshot(collection, docs);
    return result.ok;
  }
}

export function minimizeEntry(entry: ChangeEntry): ChangeEntry {
  if (entry.op !== 'update' || !entry.before || !entry.after || entry.patch) {
    return entry;
  }
  const before = entry.before as Record<string, unknown>;
  const after = entry.after as Record<string, unknown>;
  const beforePatch: Record<string, unknown> = {};
  const afterPatch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === '_id') continue;
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (key in before) beforePatch[key] = before[key];
    if (key in after) afterPatch[key] = after[key];
  }
  return {
    ...entry,
    before: beforePatch,
    after: afterPatch,
    patch: true,
  };
}

export function applyPatchDoc(
  base: Document | null,
  entry: ChangeEntry,
): Document | null {
  if (entry.op === 'delete') return null;
  if (entry.op === 'insert') {
    if (entry.after && !entry.patch) return { ...(entry.after as Document) };
    throw new JSONSQLiteError(
      ErrorCode.DATA_CORRUPT,
      'Insert delta is missing a full after document',
    );
  }
  const current = base ? { ...base } : ({ _id: entry.id } as Document);
  if (entry.patch && entry.after && typeof entry.after === 'object') {
    Object.assign(current, entry.after);
    return current;
  }
  if (entry.after) return { ...(entry.after as Document) };
  return current;
}

export function mapStorageError(err: unknown): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC') {
    throw new JSONSQLiteError(
      ErrorCode.STORAGE_FULL,
      'Disk is full; the write was not committed',
      { code },
    );
  }
  if (code === 'EACCES' || code === 'EPERM') {
    throw new JSONSQLiteError(
      ErrorCode.STORAGE_PERMISSION,
      'Write path is not writable; the write was not committed',
      { code },
    );
  }
  throw err;
}
