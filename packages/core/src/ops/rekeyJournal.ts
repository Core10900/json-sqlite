import fs from 'node:fs/promises';
import path from 'node:path';
import type { SyncMode } from '../types/index.js';
import { writeFileAtomic } from '../utils/fsDurable.js';

export type RekeyJournalEntry = {
  op: 'rekey';
  phase: 'staging_ready' | 'swapping' | 'done';
  source: string;
  staging: string;
  backup: string;
  startedAt: number;
};

/** Sibling file outside the DB dir so it survives rename of the DB folder. */
export function rekeyJournalPath(storagePath: string): string {
  return `${storagePath}.rekey-journal.json`;
}

export class RekeyJournal {
  constructor(
    private readonly storagePath: string,
    private readonly syncMode: SyncMode = 'normal',
  ) {}

  private file(): string {
    return rekeyJournalPath(this.storagePath);
  }

  async read(): Promise<RekeyJournalEntry | null> {
    try {
      const raw = await fs.readFile(this.file(), 'utf8');
      return JSON.parse(raw) as RekeyJournalEntry;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(entry: RekeyJournalEntry): Promise<void> {
    await writeFileAtomic(this.file(), JSON.stringify(entry, null, 2), this.syncMode);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file(), { force: true });
  }
}

/** Recover incomplete inplace rekey before opening the DB. */
export async function recoverRekeyIfNeeded(
  storagePath: string,
  syncMode: SyncMode = 'normal',
): Promise<void> {
  const source = path.resolve(storagePath);
  const journal = new RekeyJournal(source, syncMode);
  const entry = await journal.read();
  if (!entry) return;

  const stagingExists = await pathExists(entry.staging);
  const backupExists = await pathExists(entry.backup);
  const sourceExists = await pathExists(entry.source);

  if (entry.phase === 'staging_ready') {
    await fs.rm(entry.staging, { recursive: true, force: true });
    await journal.clear();
    return;
  }

  if (entry.phase === 'swapping') {
    if (!sourceExists && backupExists && stagingExists) {
      await fs.rename(entry.staging, entry.source);
      await fs.rm(entry.backup, { recursive: true, force: true });
      await journal.clear();
      return;
    }
    if (sourceExists && stagingExists) {
      await fs.rm(entry.staging, { recursive: true, force: true });
      await journal.clear();
      return;
    }
    if (sourceExists && backupExists && !stagingExists) {
      await fs.rm(entry.backup, { recursive: true, force: true });
      await journal.clear();
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
