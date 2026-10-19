import fs from 'node:fs/promises';
import path from 'node:path';
import type { SyncMode } from '../types/index.js';
import { writeFileAtomic } from '../utils/fsDurable.js';

export type DdlJournalEntry =
  | { op: 'drop'; name: string; phase: 'started' | 'files_removed' }
  | {
      op: 'rename';
      from: string;
      to: string;
      phase: 'started' | 'files_moved';
    };

function journalPath(storagePath: string): string {
  return path.join(storagePath, 'meta', 'ddl-journal.json');
}

export class DdlJournal {
  constructor(
    private readonly storagePath: string,
    private readonly syncMode: SyncMode = 'normal',
  ) {}

  async read(): Promise<DdlJournalEntry | null> {
    try {
      const raw = await fs.readFile(journalPath(this.storagePath), 'utf8');
      return JSON.parse(raw) as DdlJournalEntry;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(entry: DdlJournalEntry): Promise<void> {
    await writeFileAtomic(
      journalPath(this.storagePath),
      JSON.stringify(entry, null, 2),
      this.syncMode,
    );
  }

  async clear(): Promise<void> {
    await fs.rm(journalPath(this.storagePath), { force: true });
  }
}
