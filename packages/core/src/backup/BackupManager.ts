import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Document } from '../types/index.js';
import type { ChangeEntry } from '../storage/ChangeLog.js';
import { encryptBytes, decryptBytes } from '../crypto/aes.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';

export type BackupType = 'full' | 'incremental' | 'differential';

export interface BackupInfo {
  type: BackupType;
  file: string;
  timestamp: number;
  checksum: string;
  collections: string[];
  baseTimestamp?: number;
}

export interface FullPayload {
  type: 'full';
  timestamp: number;
  collections: Record<string, Document[]>;
}

export interface IncPayload {
  type: 'incremental';
  timestamp: number;
  baseTimestamp: number;
  changes: ChangeEntry[];
}

export interface DiffPayload {
  type: 'differential';
  timestamp: number;
  baseTimestamp: number;
  changes: ChangeEntry[];
}

export type BackupPayload = FullPayload | IncPayload | DiffPayload;

export interface PruneOptions {
  /** Keep backups newer than now - keepDays*86400000. */
  keepDays?: number;
  /** Keep at most this many backups (newest first), after keepDays filter. */
  maxCount?: number;
}

export interface PruneResult {
  removed: BackupInfo[];
  kept: BackupInfo[];
}

export class BackupManager {
  constructor(
    private readonly storagePath: string,
    private readonly encryptionKey?: Buffer | null,
  ) {}

  private backupDir(): string {
    return path.join(this.storagePath, 'backups');
  }

  private manifestFile(): string {
    return path.join(this.backupDir(), 'manifest.json');
  }

  async list(): Promise<BackupInfo[]> {
    try {
      const raw = await fs.readFile(this.manifestFile(), 'utf8');
      return JSON.parse(raw) as BackupInfo[];
    } catch {
      return [];
    }
  }

  private async saveManifest(list: BackupInfo[]): Promise<void> {
    await fs.mkdir(this.backupDir(), { recursive: true });
    await fs.writeFile(this.manifestFile(), JSON.stringify(list, null, 2), 'utf8');
  }

  async fullBackup(
    collections: Record<string, Document[]>,
  ): Promise<BackupInfo> {
    const timestamp = Date.now();
    const payload: FullPayload = { type: 'full', timestamp, collections };
    return this.writeBackup(`full_${timestamp}.bak`, payload, Object.keys(collections));
  }

  async incrementalBackup(
    changes: ChangeEntry[],
    baseTimestamp: number,
  ): Promise<BackupInfo | null> {
    if (changes.length === 0) return null;
    const timestamp = Date.now();
    const payload: IncPayload = {
      type: 'incremental',
      timestamp,
      baseTimestamp,
      changes,
    };
    const collections = [...new Set(changes.map((c) => c.collection))];
    return this.writeBackup(`inc_${timestamp}.bak`, payload, collections);
  }

  /**
   * Differential: all changes since the last full backup.
   * Restore applies the full baseline then this single differential.
   */
  async differentialBackup(
    changes: ChangeEntry[],
    baseTimestamp: number,
  ): Promise<BackupInfo | null> {
    if (changes.length === 0) return null;
    const timestamp = Date.now();
    const payload: DiffPayload = {
      type: 'differential',
      timestamp,
      baseTimestamp,
      changes,
    };
    const collections = [...new Set(changes.map((c) => c.collection))];
    return this.writeBackup(`diff_${timestamp}.bak`, payload, collections);
  }

  private async writeBackup(
    filename: string,
    payload: BackupPayload,
    collections: string[],
  ): Promise<BackupInfo> {
    const compressed = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
    const body = this.encryptionKey
      ? encryptBytes(compressed, this.encryptionKey)
      : compressed;
    const file = path.join(this.backupDir(), filename);
    await fs.mkdir(this.backupDir(), { recursive: true });
    await fs.writeFile(file, body);
    const info: BackupInfo = {
      type: payload.type,
      file,
      timestamp: payload.timestamp,
      checksum: sha(body),
      collections,
      ...('baseTimestamp' in payload
        ? { baseTimestamp: payload.baseTimestamp }
        : {}),
    };
    const list = await this.list();
    list.push(info);
    await this.saveManifest(list);
    return info;
  }

  async readBackup(file: string): Promise<BackupPayload> {
    const raw = await fs.readFile(file);
    return this.decode(Buffer.from(raw));
  }

  /**
   * Hash the file and compare it to the manifest checksum.
   * Throws before the payload is decoded so a mismatch cannot be applied.
   */
  async readVerified(info: BackupInfo): Promise<BackupPayload> {
    const raw = await fs.readFile(info.file);
    const sum = sha(raw);
    if (sum !== info.checksum) {
      throw new JSONSQLiteError(
        ErrorCode.BACKUP_CHECKSUM,
        `Backup checksum mismatch for ${info.file}`,
        { file: info.file, expected: info.checksum, actual: sum },
      );
    }
    return this.decode(raw);
  }

  /**
   * Delete expired backups from disk and the manifest.
   * keepDays removes entries older than the cutoff.
   * maxCount keeps the newest N of what remains.
   */
  async prune(opts: PruneOptions): Promise<PruneResult> {
    const list = await this.list();
    const now = Date.now();
    let kept = [...list];
    const removed: BackupInfo[] = [];

    if (opts.keepDays !== undefined) {
      if (opts.keepDays < 0) {
        throw new JSONSQLiteError(
          ErrorCode.INVALID_CONFIG,
          'keepDays must be >= 0',
        );
      }
      const cutoff = now - opts.keepDays * 86_400_000;
      const next: BackupInfo[] = [];
      for (const b of kept) {
        if (b.timestamp < cutoff) removed.push(b);
        else next.push(b);
      }
      kept = next;
    }

    if (opts.maxCount !== undefined) {
      if (opts.maxCount < 0) {
        throw new JSONSQLiteError(
          ErrorCode.INVALID_CONFIG,
          'maxCount must be >= 0',
        );
      }
      const sorted = [...kept].sort((a, b) => b.timestamp - a.timestamp);
      kept = sorted.slice(0, opts.maxCount);
      const keepFiles = new Set(kept.map((b) => b.file));
      for (const b of sorted) {
        if (!keepFiles.has(b.file)) removed.push(b);
      }
      kept = kept.sort((a, b) => a.timestamp - b.timestamp);
    }

    for (const b of removed) {
      await fs.rm(b.file, { force: true });
    }
    await this.saveManifest(kept);
    return { removed, kept };
  }

  latestFull(list?: BackupInfo[]): BackupInfo | undefined {
    const items = list ?? [];
    const fulls = items.filter((b) => b.type === 'full');
    return fulls[fulls.length - 1];
  }

  /**
   * Full restore is the chosen full backup.
   * Incremental restore is that full backup plus later incrementals, in order.
   * Differential restore is the full baseline plus one differential based on it.
   */
  resolveChain(
    list: BackupInfo[],
    type: BackupType,
    file?: string,
  ): BackupInfo[] {
    const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp);
    if (type === 'full') {
      const fulls = sorted.filter((b) => b.type === 'full');
      const chosen = file
        ? fulls.find((b) => b.file === file) ?? sorted.find((b) => b.file === file)
        : fulls[fulls.length - 1];
      if (!chosen || chosen.type !== 'full') {
        throw new JSONSQLiteError(
          ErrorCode.BACKUP_BASELINE,
          'No full backup to restore',
        );
      }
      return [chosen];
    }

    const fulls = sorted.filter((b) => b.type === 'full');
    if (fulls.length === 0) {
      throw new JSONSQLiteError(
        ErrorCode.BACKUP_BASELINE,
        `${type} restore requires a full backup baseline`,
      );
    }

    if (type === 'differential') {
      const tip = file
        ? sorted.find((b) => b.file === file)
        : [...sorted].reverse().find((b) => b.type === 'differential');
      if (!tip || tip.type !== 'differential') {
        throw new JSONSQLiteError(
          ErrorCode.BACKUP_BASELINE,
          file
            ? `Differential backup not in manifest: ${file}`
            : 'No differential backup to restore',
        );
      }
      const full = [...fulls].reverse().find((b) => b.timestamp <= tip.timestamp);
      if (!full || tip.baseTimestamp !== full.timestamp) {
        throw new JSONSQLiteError(
          ErrorCode.BACKUP_BASELINE,
          'Differential backup is not linked to a full baseline',
        );
      }
      return [full, tip];
    }

    const tip = file ? sorted.find((b) => b.file === file) : sorted[sorted.length - 1];
    if (!tip) {
      throw new JSONSQLiteError(
        ErrorCode.BACKUP_BASELINE,
        `Backup file not in manifest: ${file}`,
      );
    }
    const full = [...fulls].reverse().find((b) => b.timestamp <= tip.timestamp);
    if (!full) {
      throw new JSONSQLiteError(
        ErrorCode.BACKUP_BASELINE,
        'Incremental restore requires a full backup baseline',
      );
    }
    const incs = sorted.filter(
      (b) =>
        b.type === 'incremental' &&
        b.timestamp > full.timestamp &&
        b.timestamp <= tip.timestamp,
    );
    let prev = full.timestamp;
    for (const inc of incs) {
      if (inc.baseTimestamp !== prev) {
        throw new JSONSQLiteError(
          ErrorCode.BACKUP_BASELINE,
          `Incremental backup ${inc.file} is not linked to the previous baseline`,
        );
      }
      prev = inc.timestamp;
    }
    return [full, ...incs];
  }

  private decode(raw: Buffer): BackupPayload {
    const body = this.encryptionKey
      ? decryptBytes(Buffer.from(raw), this.encryptionKey)
      : Buffer.from(raw);
    const json = gunzipSync(body).toString('utf8');
    return JSON.parse(json) as BackupPayload;
  }
}

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
