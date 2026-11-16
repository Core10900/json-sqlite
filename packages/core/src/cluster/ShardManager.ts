import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';

export interface ShardEntry {
  id: number;
  ownerId: string;
  collection?: string;
}

export interface ShardMapFile {
  version: number;
  migrating?: boolean;
  shards: ShardEntry[];
}

export interface ClusterMemberRef {
  nodeId: string;
  storagePath: string;
}

function shardsFile(clusterRoot: string): string {
  return path.join(clusterRoot, 'meta', 'shards.json');
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

/** Stable shard index: hash(collection + '\\0' + _id) % shardCount. */
export function shardIndex(
  collection: string,
  id: string,
  shardCount: number,
): number {
  const n = Math.max(1, shardCount);
  const h = createHash('sha256')
    .update(`${collection}\0${id}`)
    .digest();
  return h.readUInt32BE(0) % n;
}

export class ShardManager {
  private map: ShardMapFile | null = null;
  private forceMigrating = false;

  constructor(
    private readonly clusterRoot: string,
    private readonly shardCount: number = 16,
  ) {}

  async load(): Promise<ShardMapFile> {
    const existing = await readJsonFile<ShardMapFile>(shardsFile(this.clusterRoot));
    if (existing) {
      this.map = existing;
      return existing;
    }
    this.map = {
      version: 0,
      migrating: false,
      shards: [],
    };
    return this.map;
  }

  getMap(): ShardMapFile {
    return (
      this.map ?? {
        version: 0,
        migrating: false,
        shards: [],
      }
    );
  }

  isMigrating(): boolean {
    return this.forceMigrating || this.map?.migrating === true;
  }

  assertNotMigrating(): void {
    if (this.isMigrating()) {
      throw new JSONSQLiteError(
        ErrorCode.SHARD_MOVING,
        'Shard map is migrating; retry the query after rebalance completes',
        { retryable: true },
      );
    }
  }

  /**
   * Snapshot → migrating=true → rewrite owners → migrating=false.
   * Shared data plane means document counts stay unchanged.
   */
  async rebalance(members: ClusterMemberRef[]): Promise<ShardMapFile> {
    if (!members.length) {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        'cluster rebalance requires at least one member',
      );
    }
    await this.load();
    const count = Math.max(1, this.shardCount);
    this.map = {
      version: (this.map?.version ?? 0) + 1,
      migrating: true,
      shards: this.map?.shards?.length
        ? this.map.shards.map((s) => ({ ...s }))
        : Array.from({ length: count }, (_, id) => ({
            id,
            ownerId: members[id % members.length]!.nodeId,
          })),
    };
    await this.persist();

    const shards: ShardEntry[] = Array.from({ length: count }, (_, id) => ({
      id,
      ownerId: members[id % members.length]!.nodeId,
    }));
    this.map = {
      version: this.map.version,
      migrating: false,
      shards,
    };
    await this.persist();
    return this.map;
  }

  /**
   * Test hook: run `fn` while migrating is forced true so queries can observe SHARD_MOVING.
   */
  async runWithMigrating<T>(fn: () => Promise<T> | T): Promise<T> {
    this.forceMigrating = true;
    if (this.map) {
      this.map = { ...this.map, migrating: true };
      await this.persist();
    }
    try {
      return await fn();
    } finally {
      this.forceMigrating = false;
      if (this.map) {
        this.map = { ...this.map, migrating: false };
        await this.persist();
      }
    }
  }

  /** True when shard ownership is skewed across members (or map not yet balanced). */
  isSkewed(members: ClusterMemberRef[]): boolean {
    const map = this.getMap();
    if (members.length < 2) return false;
    // Empty / uninitialized map with multiple members → advise explicit rebalance.
    if (!map.shards.length) return true;
    const counts = new Map<string, number>();
    for (const m of members) counts.set(m.nodeId, 0);
    for (const s of map.shards) {
      counts.set(s.ownerId, (counts.get(s.ownerId) ?? 0) + 1);
    }
    const values = [...counts.values()];
    const max = Math.max(...values);
    const min = Math.min(...values);
    return max - min >= Math.max(1, Math.ceil(map.shards.length / members.length));
  }

  private async persist(): Promise<void> {
    if (!this.map) return;
    await fs.mkdir(path.dirname(shardsFile(this.clusterRoot)), { recursive: true });
    await writeFileAtomic(
      shardsFile(this.clusterRoot),
      JSON.stringify(this.map, null, 2),
      'normal',
    );
  }
}
