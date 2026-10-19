import fs from 'node:fs/promises';
import path from 'node:path';
import type { Document, WriteOpType } from '../types/index.js';

export interface ChangeEntry {
  ts: number;
  op: WriteOpType;
  collection: string;
  id: string;
  before?: Document | null;
  after?: Document | null;
}

/** Append-only change log for backup incremental / time travel / PITR. */
export class ChangeLog {
  constructor(private readonly storagePath: string) {}

  private file(collection: string): string {
    return path.join(this.storagePath, 'deltas', `${collection}.delta`);
  }

  async append(entry: ChangeEntry): Promise<void> {
    const file = this.file(entry.collection);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
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
    return out;
  }

  async readUntil(collection: string, untilTs: number): Promise<ChangeEntry[]> {
    const all = await this.readSince(collection, 0);
    return all.filter((e) => e.ts <= untilTs);
  }
}
