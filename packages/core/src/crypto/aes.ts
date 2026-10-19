import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const PREFIX = Buffer.from('JSQ1');

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
  const iv = blob.subarray(4, 16);
  const tag = blob.subarray(16, 32);
  const data = blob.subarray(32);
  const decipher = createDecipheriv('aes-256-gcm', normalizeKey(key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function normalizeKey(key: Buffer): Buffer {
  if (key.length === 32) return key;
  return createHash('sha256').update(key).digest();
}
