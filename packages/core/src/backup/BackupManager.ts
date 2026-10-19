import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Document } from '../types/index.js';
import type { ChangeEntry } from '../storage/ChangeLog.js';
import { encryptBytes, decryptBytes } from '../crypto/aes.js';

export interface BackupInfo {
  type: 'full' | 'incremental';
  file: string;
  timestamp: number;
  checksum: string;
  collections: string[];
  baseTimestamp?: number;
}

interface FullPayload {
  type: 'full';
  timestamp: number;
  collections: Record<string, Document[]>;
}

interface IncPayload {
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
    const body = this.encryptionKey
      ? decryptBytes(Buffer.from(raw), this.encryptionKey)
      : Buffer.from(raw);
    const json = gunzipSync(body).toString('utf8');
    return JSON.parse(json) as FullPayload | IncPayload;
  }

  async restoreFull(
    file: string,
  ): Promise<Record<string, Document[]>> {
    const payload = await this.readBackup(file);
    if (payload.type !== 'full') {
      throw new Error('Not a full backup');
    }
    return payload.collections;
  }
}

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
