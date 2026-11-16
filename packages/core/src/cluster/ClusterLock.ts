import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';

export interface ClusterLockFile {
  holderId: string;
  scope: string;
  leaseUntil: number;
}

function encodeScope(scope: string): string {
  return Buffer.from(scope, 'utf8').toString('base64url');
}

function lockPath(clusterRoot: string, scope: string): string {
  return path.join(clusterRoot, 'locks', `${encodeScope(scope)}.json`);
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

export class ClusterLock {
  constructor(
    private readonly clusterRoot: string,
    private readonly leaseMs: number = 5000,
  ) {}

  async acquire(scope: string, nodeId: string): Promise<void> {
    const file = lockPath(this.clusterRoot, scope);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const now = Date.now();
    const existing = await readJsonFile<ClusterLockFile>(file);
    if (
      existing &&
      existing.leaseUntil >= now &&
      existing.holderId !== nodeId
    ) {
      throw new JSONSQLiteError(
        ErrorCode.CLUSTER_LOCK_CONFLICT,
        `Cluster lock conflict for scope ${scope}`,
        { scope, holderId: existing.holderId },
      );
    }
    const body: ClusterLockFile = {
      holderId: nodeId,
      scope,
      leaseUntil: now + this.leaseMs,
    };
    await writeFileAtomic(file, JSON.stringify(body, null, 2), 'normal');
  }

  async release(scope: string, nodeId?: string): Promise<void> {
    const file = lockPath(this.clusterRoot, scope);
    const existing = await readJsonFile<ClusterLockFile>(file);
    if (!existing) return;
    if (nodeId && existing.holderId !== nodeId) {
      throw new JSONSQLiteError(
        ErrorCode.CLUSTER_LOCK_CONFLICT,
        `Cluster lock held by ${existing.holderId}`,
        { scope, holderId: existing.holderId },
      );
    }
    await fs.rm(file, { force: true });
  }
}
