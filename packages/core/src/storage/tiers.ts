import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync, gzipSync, gunzipSync, inflateSync } from 'node:zlib';
import zlib from 'node:zlib';
import type { Document, SyncMode } from '../types/index.js';
import { writeFileAtomic } from '../utils/fsDurable.js';
import { decryptLine, encryptLine } from '../crypto/aes.js';

const WARM_PREFIX = 'JSQL1|deflate|';
const COLD_GZIP = 'JSQC1|gzip|';
const COLD_ZSTD = 'JSQC1|zstd|';

export interface TierSummary {
  enabled: boolean;
  hot: number;
  warm: number;
  cold: number;
  coldReads: number;
  warmReads: number;
  migrating: boolean;
  /** Cold copies that could not be written to `coldExternalDir`. */
  externalFailures: number;
  coldAlgorithm: 'gzip' | 'zstd';
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
  externalFailures = 0;
  private hookSource: () => TierColdHook[] = () => [];

  constructor(
    private readonly root: string,
    private readonly syncMode: SyncMode,
    private readonly encKey: Buffer | null,
    private readonly coldAfter: number,
    private readonly warmAfter: number,
    private readonly coldExternalDir: string | null = null,
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
      externalFailures: this.externalFailures,
      coldAlgorithm: coldAlgorithmName(),
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

  /**
   * Try storage-plugin getCold when the local warm/cold maps miss.
   * Failures are ignored so hot docs stay readable; unrecalled cold
   * must not appear in hot query results (caller only uses this for point lookup).
   */
  async lookupCold(
    collection: string,
    id: string,
  ): Promise<{ doc: Document; tier: 'cold' } | null> {
    const local = this.lookup(collection, id);
    if (local?.tier === 'cold') return { doc: local.doc, tier: 'cold' };
    for (const hook of this.hookSource()) {
      if (!hook.getCold) continue;
      try {
        const doc = await hook.getCold(collection, id);
        if (doc && typeof doc === 'object' && typeof (doc as Document)._id === 'string') {
          return { doc: { ...(doc as Document) }, tier: 'cold' };
        }
      } catch {
        // Plugin / object-store failure must not break hot path.
      }
    }
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
        if (this.coldExternalDir) {
          try {
            await this.writeExternalCold(name, cold);
          } catch {
            this.externalFailures += 1;
          }
        }
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

  private encode(doc: Document, tier: 'warm' | 'cold'): string {
    const json = JSON.stringify(doc);
    const buf = Buffer.from(json, 'utf8');
    let payload: string;
    if (tier === 'warm') {
      payload = WARM_PREFIX + deflateSync(buf, { level: 1 }).toString('base64');
    } else {
      const cold = compressCold(buf);
      const prefix = cold.algorithm === 'zstd' ? COLD_ZSTD : COLD_GZIP;
      payload = prefix + cold.payload;
    }
    if (!this.encKey) return payload;
    return encryptLine(payload, this.encKey);
  }

  private decode(line: string): Document {
    const text = this.encKey ? decryptLine(line, this.encKey) : line;
    const json = decodeTierPayload(text);
    return JSON.parse(json) as Document;
  }

  private async writeExternalCold(
    name: string,
    docs: Map<string, Document>,
  ): Promise<void> {
    if (!this.coldExternalDir) return;
    const file = path.join(this.coldExternalDir, name, 'cold.jsonl');
    const body = [...docs.values()].map((doc) => this.encode(doc, 'cold')).join('\n');
    await writeFileAtomic(file, body ? `${body}\n` : '', this.syncMode);
  }

  private async writeTierFile(
    name: string,
    tier: 'warm' | 'cold',
    docs: Map<string, Document>,
  ): Promise<void> {
    const file = this.tierFile(name, tier);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const body = [...docs.values()].map((doc) => this.encode(doc, tier)).join('\n');
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

function coldAlgorithmName(): 'gzip' | 'zstd' {
  const zstd = (zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;
  return typeof zstd === 'function' ? 'zstd' : 'gzip';
}

function compressCold(buf: Buffer): { algorithm: 'gzip' | 'zstd'; payload: string } {
  const zstd = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
  if (typeof zstd === 'function') {
    return { algorithm: 'zstd', payload: zstd(buf).toString('base64') };
  }
  return { algorithm: 'gzip', payload: gzipSync(buf).toString('base64') };
}

function decodeTierPayload(text: string): string {
  if (text.startsWith(WARM_PREFIX)) {
    return inflateSync(Buffer.from(text.slice(WARM_PREFIX.length), 'base64')).toString('utf8');
  }
  if (text.startsWith(COLD_GZIP)) {
    return gunzipSync(Buffer.from(text.slice(COLD_GZIP.length), 'base64')).toString('utf8');
  }
  if (text.startsWith(COLD_ZSTD)) {
    const zstd = (zlib as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync;
    if (typeof zstd !== 'function') {
      throw new Error('cold block uses zstd but this runtime cannot decompress it');
    }
    return zstd(Buffer.from(text.slice(COLD_ZSTD.length), 'base64')).toString('utf8');
  }
  return text;
}
