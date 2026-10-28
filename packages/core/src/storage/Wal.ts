import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { decryptLine, encryptLine, isEncryptedLine } from '../crypto/aes.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document, SyncMode, WriteOpType } from '../types/index.js';
import { walFile } from '../utils/path.js';
import { appendFileDurable, writeFileAtomic } from '../utils/fsDurable.js';

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
  private encrypt = false;

  constructor(
    private readonly storagePath: string,
    private readonly enabled: boolean,
    private readonly syncMode: SyncMode = 'normal',
    private readonly encKey: Buffer | null = null,
  ) {}

  /** Enable/disable line encryption (mirrors catalog.encryption). */
  setEncryption(enabled: boolean): void {
    this.encrypt = enabled && !!this.encKey;
  }

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
    const line = this.encodeLine(JSON.stringify(full));
    await appendFileDurable(file, `${line}\n`, this.syncMode);
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
      const lines =
        entries.map((e) => this.encodeLine(JSON.stringify(e))).join('\n') + '\n';
      await appendFileDurable(file, lines, this.syncMode);
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

    const diag = diagnoseWalText(raw, this.encKey);
    if (diag.issues.length > 0) {
      const first = diag.issues[0]!;
      throw new JSONSQLiteError(
        ErrorCode.WAL_CORRUPT,
        `WAL corrupt at line ${first.line} (${first.kind}) in ${collection}; refusing to skip committed records`,
        { collection, line: first.line, kind: first.kind, issues: diag.issues },
      );
    }
    this.seq = Math.max(this.seq, diag.maxSeq);
    return diag.committed;
  }

  private encodeLine(json: string): string {
    if (this.encrypt && this.encKey) return encryptLine(json, this.encKey);
    return json;
  }

  async truncate(collection: string): Promise<void> {
    if (!this.enabled) return;
    const file = walFile(this.storagePath, collection);
    try {
      await writeFileAtomic(file, '', this.syncMode);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

function checksumOf(entry: WalEntry): string {
  const copy = { ...entry, checksum: '' };
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex').slice(0, 16);
}

export interface WalLineIssue {
  line: number;
  kind: 'parse' | 'checksum';
  message: string;
}

export interface WalDiagnosis {
  /** Incomplete final fragment (file does not end with a newline). Discarded. */
  tornTail: boolean;
  /** Complete lines that failed parse or checksum. Any issue is fail-closed. */
  issues: WalLineIssue[];
  committed: WalEntry[];
  maxSeq: number;
}

class WalIntegrityError extends Error {
  constructor(
    readonly kind: 'parse' | 'checksum',
    message: string,
  ) {
    super(message);
    this.name = 'WalIntegrityError';
  }
}

/**
 * A record is a complete line only when it is terminated by `\n`.
 * A trailing fragment without a newline is a torn tail and is not parsed.
 */
export function splitWalRecords(raw: string): { complete: string[]; tornTail: boolean } {
  if (raw.length === 0) return { complete: [], tornTail: false };
  const tornTail = !raw.endsWith('\n');
  const parts = raw.split('\n');
  parts.pop();
  return {
    complete: parts.filter((line) => line.trim().length > 0),
    tornTail,
  };
}

export function diagnoseWalText(raw: string, encKey: Buffer | null): WalDiagnosis {
  const { complete, tornTail } = splitWalRecords(raw);
  const issues: WalLineIssue[] = [];
  const committed: WalEntry[] = [];
  let maxSeq = 0;
  for (let i = 0; i < complete.length; i++) {
    try {
      const entry = parseWalLine(complete[i]!, encKey);
      maxSeq = Math.max(maxSeq, entry.seq);
      if (entry.committed) committed.push(entry);
    } catch (err) {
      if (err instanceof JSONSQLiteError) throw err;
      const kind = err instanceof WalIntegrityError ? err.kind : 'parse';
      issues.push({
        line: i + 1,
        kind,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { tornTail, issues, committed, maxSeq };
}

export async function diagnoseWalDirectory(
  storagePath: string,
  encKey: Buffer | null,
): Promise<{ collection: string; tornTail: boolean; issues: WalLineIssue[] }[]> {
  const dir = path.join(storagePath, 'wal');
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: { collection: string; tornTail: boolean; issues: WalLineIssue[] }[] = [];
  for (const name of names) {
    if (!name.endsWith('.wal')) continue;
    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    const diag = diagnoseWalText(raw, encKey);
    out.push({
      collection: name.slice(0, -'.wal'.length),
      tornTail: diag.tornTail,
      issues: diag.issues,
    });
  }
  return out;
}

function parseWalLine(line: string, encKey: Buffer | null): WalEntry {
  if (isEncryptedLine(line) && !encKey) {
    throw new JSONSQLiteError(
      ErrorCode.ENCRYPTION,
      'Encrypted WAL requires encryptionKey / JSONSQLITE_KEY',
    );
  }
  let plain: string;
  try {
    plain = decryptLine(line, encKey);
  } catch (err) {
    if (err instanceof JSONSQLiteError) throw err;
    throw new WalIntegrityError('parse', 'unable to decode WAL line');
  }
  let entry: WalEntry;
  try {
    entry = JSON.parse(plain) as WalEntry;
  } catch {
    throw new WalIntegrityError('parse', 'WAL line is not JSON');
  }
  if (!entry || typeof entry !== 'object' || typeof entry.op !== 'string') {
    throw new WalIntegrityError('parse', 'WAL line is missing op');
  }
  const expected = checksumOf({ ...entry, checksum: '' });
  if (entry.checksum !== expected) {
    throw new WalIntegrityError('checksum', 'WAL checksum mismatch');
  }
  return entry;
}
