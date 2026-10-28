import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Document } from '../types/index.js';
import type { ChangeEntry } from '../storage/ChangeLog.js';
import { encryptBytes, decryptBytes } from '../crypto/aes.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';

export interface BackupInfo {
  type: 'full' | 'incremental';
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
    const compressed = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
    const body = this.encryptionKey
      ? encryptBytes(compressed, this.encryptionKey)
      : compressed;
    const file = path.join(this.backupDir(), `full_${timestamp}.bak`);
    await fs.mkdir(this.backupDir(), { recursive: true });
    await fs.writeFile(file, body);
    const info: BackupInfo = {
      type: 'full',
      file,
      timestamp,
      checksum: sha(body),
      collections: Object.keys(collections),
    };
    const list = await this.list();
    list.push(info);
    await this.saveManifest(list);
    return info;
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
    const compressed = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
    const body = this.encryptionKey
      ? encryptBytes(compressed, this.encryptionKey)
      : compressed;
    const file = path.join(this.backupDir(), `inc_${timestamp}.bak`);
    await fs.mkdir(this.backupDir(), { recursive: true });
    await fs.writeFile(file, body);
    const collections = [...new Set(changes.map((c) => c.collection))];
    const info: BackupInfo = {
      type: 'incremental',
      file,
      timestamp,
      checksum: sha(body),
      collections,
      baseTimestamp,
    };
    const list = await this.list();
    list.push(info);
    await this.saveManifest(list);
    return info;
  }

  async readBackup(file: string): Promise<FullPayload | IncPayload> {
    const raw = await fs.readFile(file);
    return this.decode(Buffer.from(raw));
  }

  /**
   * Hash the file and compare it to the manifest checksum.
   * Throws before the payload is decoded so a mismatch cannot be applied.
   */
  async readVerified(info: BackupInfo): Promise<FullPayload | IncPayload> {
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
   * Full restore is the chosen full backup.
   * Incremental restore is that full backup plus later incrementals, in order.
   * An incremental chain with no full backup fails and must not be applied.
   */
  resolveChain(
    list: BackupInfo[],
    type: 'full' | 'incremental',
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
        'Incremental restore requires a full backup baseline',
      );
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

  private decode(raw: Buffer): FullPayload | IncPayload {
    const body = this.encryptionKey
      ? decryptBytes(Buffer.from(raw), this.encryptionKey)
      : Buffer.from(raw);
    const json = gunzipSync(body).toString('utf8');
    return JSON.parse(json) as FullPayload | IncPayload;
  }
}

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
