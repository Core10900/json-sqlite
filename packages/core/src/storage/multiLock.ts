import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { lockFile } from '../utils/path.js';

/** Document lock key: collection, then id. Sort order is the commit order. */
export function docKey(collection: string, id: string): string {
  return `${collection}\u0000${id}`;
}

export function parseDocKey(key: string): { collection: string; id: string } {
  const at = key.indexOf('\u0000');
  return { collection: key.slice(0, at), id: key.slice(at + 1) };
}

interface HolderRecord {
  pid: number;
  mode: 'multi';
  waiting: string | null;
  holding: string[];
}

interface DocLockRecord {
  pid: number;
  key: string;
  at: number;
}

export interface LockReport {
  writers: 'single' | 'multi';
  lockHolder: { pid: number } | { pids: number[] };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function retryable(code: ErrorCode, message: string): JSONSQLiteError {
  return new JSONSQLiteError(code, message, { retryable: true });
}

/**
 * Same-machine multi-writer locks. See devDocs/releases/v2.4.0/RFC-锁协议.md.
 * A dead pid owns nothing; the next acquirer deletes the stale file.
 */
export class MultiLock {
  private readonly holdersDir: string;
  private readonly docsDir: string;
  private readonly commitPath: string;
  private readonly holderPath: string;
  private held = new Set<string>();
  private joined = false;
  private commitHeld = false;

  constructor(private readonly storagePath: string) {
    this.holdersDir = path.join(storagePath, 'meta', 'holders');
    this.docsDir = path.join(storagePath, 'meta', 'doclocks');
    this.commitPath = path.join(storagePath, 'meta', 'commit.lock');
    this.holderPath = path.join(this.holdersDir, `${process.pid}.json`);
  }

  async join(): Promise<void> {
    await fsPromises.mkdir(this.holdersDir, { recursive: true });
    await fsPromises.mkdir(this.docsDir, { recursive: true });
    await this.reclaimStaleExclusive();
    const exclusive = await readJson<DocLockRecord>(lockFile(this.storagePath));
    if (exclusive?.pid && isPidAlive(exclusive.pid)) {
      throw new JSONSQLiteError(
        ErrorCode.LOCK_FAILED,
        `Storage path is locked by a single-writer process ${exclusive.pid}: ${this.storagePath}`,
        { retryable: false, pid: exclusive.pid },
      );
    }
    if (exclusive) await fsPromises.rm(lockFile(this.storagePath), { force: true });
    await this.reclaimDeadHolders();
    await this.writeHolder({ pid: process.pid, mode: 'multi', waiting: null, holding: [] });
    this.joined = true;
  }

  async leave(): Promise<void> {
    if (!this.joined && !this.held.size && !this.commitHeld) return;
    await this.releaseMine();
    await this.releaseCommit();
    await fsPromises.rm(this.holderPath, { force: true });
    this.joined = false;
  }

  /** Take document locks this process does not already hold, in sorted key order. */
  async acquireMissing(keys: string[]): Promise<void> {
    const pending = [...new Set(keys)].filter((key) => !this.held.has(key)).sort();
    for (const key of pending) {
      await this.acquireOne(key);
    }
  }

  /**
   * Take one document lock now, in caller order.
   * The process that closes a wait-for cycle and has the higher pid is the victim.
   */
  async acquireOne(key: string): Promise<void> {
    if (this.held.has(key)) return;
    const deadline = Date.now() + 10_000;
    const file = this.docPath(key);
    while (Date.now() < deadline) {
      try {
        writeExclusive(file, { pid: process.pid, key, at: Date.now() } satisfies DocLockRecord);
        this.held.add(key);
        await this.writeHolder({
          pid: process.pid,
          mode: 'multi',
          waiting: null,
          holding: [...this.held],
        });
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }

      const owner = await readJson<DocLockRecord>(file);
      if (!owner?.pid || !isPidAlive(owner.pid) || owner.pid === process.pid) {
        await fsPromises.rm(file, { force: true });
        continue;
      }

      await this.writeHolder({
        pid: process.pid,
        mode: 'multi',
        waiting: key,
        holding: [...this.held],
      });
      const cycle = await this.waitCycle();
      if (cycle && cycle.includes(process.pid) && process.pid === Math.max(...cycle)) {
        await this.writeHolder({
          pid: process.pid,
          mode: 'multi',
          waiting: null,
          holding: [...this.held],
        });
        throw retryable(
          ErrorCode.DEADLOCK,
          `Deadlock: pid ${process.pid} is the victim and rolls back`,
        );
      }
      await sleep(20);
    }
    throw retryable(ErrorCode.LOCK_FAILED, `Timed out waiting for document lock ${key}`);
  }

  async releaseMine(): Promise<void> {
    for (const key of this.held) {
      const file = this.docPath(key);
      const owner = await readJson<DocLockRecord>(file);
      if (!owner || owner.pid === process.pid) {
        await fsPromises.rm(file, { force: true });
      }
    }
    this.held.clear();
    if (this.joined) {
      await this.writeHolder({
        pid: process.pid,
        mode: 'multi',
        waiting: null,
        holding: [],
      });
    }
  }

  async withCommitLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireCommit();
    try {
      return await fn();
    } finally {
      await this.releaseCommit();
    }
  }

  async report(): Promise<LockReport> {
    const pids = await liveHolderPids(this.storagePath);
    return { writers: 'multi', lockHolder: { pids } };
  }

  private async acquireCommit(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        writeExclusive(this.commitPath, { pid: process.pid, key: 'commit', at: Date.now() });
        this.commitHeld = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const owner = await readJson<DocLockRecord>(this.commitPath);
      if (!owner?.pid || !isPidAlive(owner.pid)) {
        await fsPromises.rm(this.commitPath, { force: true });
        continue;
      }
      await sleep(15);
    }
    throw retryable(ErrorCode.LOCK_FAILED, 'Timed out waiting for the commit lock');
  }

  private async releaseCommit(): Promise<void> {
    if (!this.commitHeld) return;
    const owner = await readJson<DocLockRecord>(this.commitPath);
    if (!owner || owner.pid === process.pid) {
      await fsPromises.rm(this.commitPath, { force: true });
    }
    this.commitHeld = false;
  }

  private async waitCycle(): Promise<number[] | null> {
    const holders = await readHolders(this.holdersDir);
    const locks = new Map<string, number>();
    const names = await fsPromises.readdir(this.docsDir).catch(() => [] as string[]);
    for (const name of names) {
      const rec = await readJson<DocLockRecord>(path.join(this.docsDir, name));
      if (rec?.pid && rec.key && isPidAlive(rec.pid)) locks.set(rec.key, rec.pid);
    }
    const edge = new Map<number, number>();
    for (const holder of holders) {
      if (!holder.waiting) continue;
      const owner = locks.get(holder.waiting);
      if (owner && owner !== holder.pid) edge.set(holder.pid, owner);
    }
    for (const start of edge.keys()) {
      const seen = new Set<number>();
      const pathPids: number[] = [];
      let cur: number | undefined = start;
      while (cur !== undefined && !seen.has(cur)) {
        seen.add(cur);
        pathPids.push(cur);
        cur = edge.get(cur);
      }
      if (cur !== undefined && seen.has(cur)) {
        return pathPids.slice(pathPids.indexOf(cur));
      }
    }
    return null;
  }

  private docPath(key: string): string {
    return path.join(this.docsDir, encodeURIComponent(key));
  }

  private async writeHolder(rec: HolderRecord): Promise<void> {
    await fsPromises.mkdir(this.holdersDir, { recursive: true });
    await fsPromises.writeFile(this.holderPath, JSON.stringify(rec), 'utf8');
  }

  private async reclaimStaleExclusive(): Promise<void> {
    const info = await readJson<{ pid?: number }>(lockFile(this.storagePath));
    if (info?.pid && !isPidAlive(info.pid)) {
      await fsPromises.rm(lockFile(this.storagePath), { force: true });
    }
  }

  private async reclaimDeadHolders(): Promise<void> {
    const names = await fsPromises.readdir(this.holdersDir).catch(() => [] as string[]);
    for (const name of names) {
      const file = path.join(this.holdersDir, name);
      const rec = await readJson<HolderRecord>(file);
      if (!rec?.pid || !isPidAlive(rec.pid)) await fsPromises.rm(file, { force: true });
    }
    const docs = await fsPromises.readdir(this.docsDir).catch(() => [] as string[]);
    for (const name of docs) {
      const file = path.join(this.docsDir, name);
      const rec = await readJson<DocLockRecord>(file);
      if (!rec?.pid || !isPidAlive(rec.pid)) await fsPromises.rm(file, { force: true });
    }
  }
}

/** single open refuses while a live multi holder exists. Dead holders are removed. */
export async function assertSingleOpenAllowed(storagePath: string): Promise<void> {
  const dir = path.join(storagePath, 'meta', 'holders');
  let names: string[] = [];
  try {
    names = await fsPromises.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    const rec = await readJson<HolderRecord>(file);
    if (rec?.pid && isPidAlive(rec.pid)) {
      throw new JSONSQLiteError(
        ErrorCode.LOCK_FAILED,
        `Storage path is locked by multi-writer process ${rec.pid}: ${storagePath}`,
        { retryable: false, pid: rec.pid },
      );
    }
    await fsPromises.rm(file, { force: true });
  }
}

export async function describeLocks(
  storagePath: string,
  writers: 'single' | 'multi',
): Promise<LockReport> {
  if (writers === 'multi') {
    const pids = await liveHolderPids(storagePath);
    return { writers: 'multi', lockHolder: { pids } };
  }
  const info = await readJson<{ pid?: number }>(lockFile(storagePath));
  const pid = info?.pid && isPidAlive(info.pid) ? info.pid : process.pid;
  return { writers: 'single', lockHolder: { pid } };
}

async function liveHolderPids(storagePath: string): Promise<number[]> {
  const dir = path.join(storagePath, 'meta', 'holders');
  const holders = await readHolders(dir);
  return holders.map((h) => h.pid).filter((pid) => isPidAlive(pid));
}

async function readHolders(dir: string): Promise<HolderRecord[]> {
  let names: string[] = [];
  try {
    names = await fsPromises.readdir(dir);
  } catch {
    return [];
  }
  const out: HolderRecord[] = [];
  for (const name of names) {
    const rec = await readJson<HolderRecord>(path.join(dir, name));
    if (rec?.pid) out.push(rec);
  }
  return out;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fsPromises.readFile(file, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function writeExclusive(file: string, body: DocLockRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(body));
  } finally {
    fs.closeSync(fd);
  }
}
