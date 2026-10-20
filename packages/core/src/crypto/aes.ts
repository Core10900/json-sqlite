import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { ErrorCode, JSONSQLiteError } from '../errors.js';

const PREFIX = Buffer.from('JSQ1');
/** Text-line envelope for JSONL / WAL rows. */
const LINE_PREFIX = 'JSQE1:';

export function encryptBytes(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', normalizeKey(key), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([PREFIX, iv, tag, enc]);
}

export function decryptBytes(blob: Buffer, key: Buffer): Buffer {
  if (blob.subarray(0, 4).compare(PREFIX) !== 0) {
    return blob;
  }
  try {
    const iv = blob.subarray(4, 16);
    const tag = blob.subarray(16, 32);
    const data = blob.subarray(32);
    const decipher = createDecipheriv('aes-256-gcm', normalizeKey(key), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new JSONSQLiteError(
      ErrorCode.ENCRYPTION,
      'Failed to decrypt data (wrong key or corrupt ciphertext)',
    );
  }
}

/** Encrypt a UTF-8 text line for JSONL/WAL storage. */
export function encryptLine(plain: string, key: Buffer): string {
  return LINE_PREFIX + encryptBytes(Buffer.from(plain, 'utf8'), key).toString('base64');
}

/** Decrypt a JSONL/WAL line; plain lines pass through unchanged. */
export function decryptLine(line: string, key: Buffer | null): string {
  if (!line.startsWith(LINE_PREFIX)) {
    return line;
  }
  if (!key) {
    throw new JSONSQLiteError(
      ErrorCode.ENCRYPTION,
      'Encrypted storage detected but no encryptionKey / JSONSQLITE_KEY provided',
    );
  }
  const blob = Buffer.from(line.slice(LINE_PREFIX.length), 'base64');
  return decryptBytes(blob, key).toString('utf8');
}

export function isEncryptedLine(line: string): boolean {
  return line.startsWith(LINE_PREFIX);
}

function normalizeKey(key: Buffer): Buffer {
  if (key.length === 32) return key;
  return createHash('sha256').update(key).digest();
}
