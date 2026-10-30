import fs from 'node:fs/promises';
import path from 'node:path';
import { appendFileDurable } from '../utils/fsDurable.js';

export type AuditAction =
  | 'rekey'
  | 'rollbackToTime'
  | 'drop'
  | 'migrate'
  | 'repair'
  | 'backup'
  | 'tune';

export interface AuditEntry {
  ts: number;
  action: AuditAction;
  message: string;
  details?: Record<string, unknown>;
}

export class AuditLog {
  constructor(
    private readonly storagePath: string,
    private readonly syncMode: 'none' | 'normal' | 'full' = 'normal',
  ) {}

  private file(): string {
    return path.join(this.storagePath, 'meta', 'audit.jsonl');
  }

  async append(
    action: AuditAction,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<AuditEntry> {
    const entry: AuditEntry = {
      ts: Date.now(),
      action,
      message,
      ...(details ? { details } : {}),
    };
    await fs.mkdir(path.dirname(this.file()), { recursive: true });
    await appendFileDurable(
      this.file(),
      `${JSON.stringify(entry)}\n`,
      this.syncMode,
    );
    return entry;
  }

  async list(opts?: {
    action?: AuditAction;
    limit?: number;
  }): Promise<AuditEntry[]> {
    let raw = '';
    try {
      raw = await fs.readFile(this.file(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AuditEntry;
        if (opts?.action && parsed.action !== opts.action) continue;
        entries.push(parsed);
      } catch {
        /* skip torn / bad lines */
      }
    }
    const limit = opts?.limit;
    if (limit !== undefined && limit >= 0) {
      return entries.slice(Math.max(0, entries.length - limit));
    }
    return entries;
  }
}

/** Write an audit line into a DB directory that may not be open. */
export async function appendAuditFile(
  storagePath: string,
  action: AuditAction,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const log = new AuditLog(storagePath, 'normal');
  await log.append(action, message, details);
}
