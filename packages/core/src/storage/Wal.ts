import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Document, WriteOpType } from '../types/index.js';
import { walFile } from '../utils/path.js';

export interface WalEntry {
  seq: number;
  ts: number;
  txId: number | null;
  committed: boolean;
  op: WriteOpType;
  collection: string;
  payload: Document | { _id: string };
  checksum: string;
}

export class Wal {
  private seq = 0;
  private buffer: WalEntry[] = [];

  constructor(
    private readonly storagePath: string,
    private readonly enabled: boolean,
  ) {}

  async initialize(): Promise<void> {
    if (!this.enabled) return;
    await fs.mkdir(path.join(this.storagePath, 'wal'), { recursive: true });
  }

  async append(
    entry: Omit<WalEntry, 'seq' | 'checksum'> & { checksum?: string },
  ): Promise<WalEntry> {
    if (!this.enabled) {
      return {
        ...entry,
        seq: ++this.seq,
        checksum: '',
      } as WalEntry;
    }

    const full: WalEntry = {
      ...entry,
      seq: ++this.seq,
      checksum: '',
    };
    full.checksum = checksumOf(full);

    const file = walFile(this.storagePath, entry.collection);
    await fs.appendFile(file, `${JSON.stringify(full)}\n`, 'utf8');
    return full;
  }

  async appendBuffered(
    entry: Omit<WalEntry, 'seq' | 'checksum'>,
  ): Promise<WalEntry> {
    const full: WalEntry = {
      ...entry,
      seq: ++this.seq,
      checksum: '',
    };
    full.checksum = checksumOf(full);
    this.buffer.push(full);
    return full;
  }

  async flushBuffer(): Promise<void> {
    if (!this.enabled || this.buffer.length === 0) {
      this.buffer = [];
      return;
    }
    const byCollection = new Map<string, WalEntry[]>();
    for (const e of this.buffer) {
      const list = byCollection.get(e.collection) ?? [];
      list.push(e);
      byCollection.set(e.collection, list);
    }
    for (const [collection, entries] of byCollection) {
      const file = walFile(this.storagePath, collection);
      const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.appendFile(file, lines, 'utf8');
    }
    this.buffer = [];
  }

  clearBuffer(): void {
    this.buffer = [];
  }

  async readCommitted(collection: string): Promise<WalEntry[]> {
    if (!this.enabled) return [];
    const file = walFile(this.storagePath, collection);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const entries: WalEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as WalEntry;
        const { checksum, ...rest } = entry;
        const expected = checksumOf({ ...rest, checksum: '' } as WalEntry);
        if (checksum !== expected) continue;
        if (entry.committed) entries.push(entry);
        this.seq = Math.max(this.seq, entry.seq);
      } catch {
        // skip corrupt line
      }
    }
    return entries;
  }

  async truncate(collection: string): Promise<void> {
    if (!this.enabled) return;
    const file = walFile(this.storagePath, collection);
    try {
      await fs.writeFile(file, '', 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

function checksumOf(entry: WalEntry): string {
  const copy = { ...entry, checksum: '' };
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex').slice(0, 16);
}
