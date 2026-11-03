import fs from 'node:fs/promises';
import path from 'node:path';
import type { Document, SyncMode } from '../types/index.js';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { decryptLine, encryptLine } from '../crypto/aes.js';

export interface TierSummary {
  enabled: boolean;
  hot: number;
  warm: number;
  cold: number;
  coldReads: number;
  warmReads: number;
  migrating: boolean;
}

export interface TierColdHook {
  putCold?(collection: string, doc: Document): Promise<void> | void;
  getCold?(
    collection: string,
    id: string,
  ): Promise<Document | null | undefined> | Document | null | undefined;
}

/**
 * Hot documents stay in the page store. Warm and cold are copies moved
 * by a background pass. The pass never runs inside the write call.
 */
export class TierService {
  private readonly access = new Map<string, Map<string, number>>();
  private readonly warm = new Map<string, Map<string, Document>>();
  private readonly cold = new Map<string, Map<string, Document>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private migrating = false;
  private chain: Promise<void> = Promise.resolve();
  private totalDocs = 0;
  coldReads = 0;
  warmReads = 0;
  private hookSource: () => TierColdHook[] = () => [];

  constructor(
    private readonly root: string,
    private readonly syncMode: SyncMode,
    private readonly encKey: Buffer | null,
    private readonly coldAfter: number,
    private readonly warmAfter: number,
  ) {}

  setHookSource(source: () => TierColdHook[]): void {
    this.hookSource = source;
  }

  summary(): TierSummary {
    let warm = 0;
    let cold = 0;
    for (const map of this.warm.values()) warm += map.size;
    for (const map of this.cold.values()) cold += map.size;
    return {
      enabled: true,
      hot: Math.max(0, this.totalDocs - warm - cold),
      warm,
      cold,
      coldReads: this.coldReads,
      warmReads: this.warmReads,
      migrating: this.migrating,
    };
  }

  noteAccess(collection: string, id: string): void {
    let counts = this.access.get(collection);
    if (!counts) {
      counts = new Map();
      this.access.set(collection, counts);
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  /** A newer write wins over a previous cold/warm copy. */
  forget(collection: string, id: string): void {
    this.warm.get(collection)?.delete(id);
    this.cold.get(collection)?.delete(id);
    this.access.get(collection)?.delete(id);
  }

  forgetCollection(collection: string): void {
    this.warm.delete(collection);
    this.cold.delete(collection);
    this.access.delete(collection);
  }

  lookup(collection: string, id: string): { doc: Document; tier: 'warm' | 'cold' } | null {
    const cold = this.cold.get(collection)?.get(id);
    if (cold) return { doc: cold, tier: 'cold' };
    const warm = this.warm.get(collection)?.get(id);
    if (warm) return { doc: warm, tier: 'warm' };
    return null;
  }

  noteColdRead(): void {
    this.coldReads += 1;
  }

  noteWarmRead(): void {
    this.warmReads += 1;
  }

  startBackground(
    names: () => string[],
    readAll: (name: string) => Promise<Document[]>,
  ): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.migrate(readAll, names());
    }, 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One migration pass. Callers that must not block a commit should
   * not await this from the write path. Awaiting it is for tests and
   * an explicit flush.
   */
  migrate(
    readAll: (name: string) => Promise<Document[]>,
    names: string[],
  ): Promise<void> {
    this.chain = this.chain.then(() => this.migrateNow(readAll, names));
    return this.chain;
  }

  async load(names: string[]): Promise<void> {
    for (const name of names) {
      this.warm.set(name, await this.readTierFile(name, 'warm'));
      this.cold.set(name, await this.readTierFile(name, 'cold'));
    }
  }

  private async migrateNow(
    readAll: (name: string) => Promise<Document[]>,
    names: string[],
  ): Promise<void> {
    this.migrating = true;
    try {
      let total = 0;
      for (const name of names) {
        const docs = await readAll(name);
        total += docs.length;
        const warm = new Map<string, Document>();
        const cold = new Map<string, Document>();
        for (const doc of docs) {
          const n = this.access.get(name)?.get(doc._id) ?? 0;
          if (n <= this.coldAfter) cold.set(doc._id, { ...doc });
          else if (n <= this.warmAfter) warm.set(doc._id, { ...doc });
        }
        for (const doc of cold.values()) {
          for (const hook of this.hookSource()) {
            if (!hook.putCold) continue;
            try {
              await hook.putCold(name, doc);
            } catch {
              // Isolation is recorded by the plugin registry. The local
              // cold file below still receives the document.
            }
          }
        }
        await this.writeTierFile(name, 'warm', warm);
        await this.writeTierFile(name, 'cold', cold);
        this.warm.set(name, warm);
        this.cold.set(name, cold);
      }
      this.totalDocs = total;
    } finally {
      this.migrating = false;
    }
  }

  private tierFile(name: string, tier: 'warm' | 'cold'): string {
    return path.join(this.root, 'collections', name, 'tiers', `${tier}.jsonl`);
  }

  private encode(doc: Document): string {
    const json = JSON.stringify(doc);
    if (!this.encKey) return json;
    return encryptLine(json, this.encKey);
  }

  private decode(line: string): Document {
    const json = this.encKey ? decryptLine(line, this.encKey) : line;
    return JSON.parse(json) as Document;
  }

  private async writeTierFile(
    name: string,
    tier: 'warm' | 'cold',
    docs: Map<string, Document>,
  ): Promise<void> {
    const file = this.tierFile(name, tier);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const body = [...docs.values()].map((doc) => this.encode(doc)).join('\n');
    await writeFileAtomic(file, body ? `${body}\n` : '', this.syncMode);
  }

  private async readTierFile(
    name: string,
    tier: 'warm' | 'cold',
  ): Promise<Map<string, Document>> {
    const map = new Map<string, Document>();
    try {
      const raw = await fs.readFile(this.tierFile(name, tier), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const doc = this.decode(line);
        map.set(doc._id, doc);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return map;
  }
}
