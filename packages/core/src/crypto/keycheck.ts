import fs from 'node:fs/promises';
import path from 'node:path';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { docsFile, pageFile } from '../utils/path.js';
import { decryptLine, encryptLine, isEncryptedLine } from './aes.js';

const MAGIC = 'jsonsqlite-key-ok';

function keycheckFile(storagePath: string): string {
  return path.join(storagePath, 'meta', '.keycheck');
}

/**
 * Ensure the provided key can decrypt this encrypted database.
 * Uses meta/.keycheck when present; otherwise probes collection JSONL
 * (1.4 upgrade path) or creates a fresh keycheck for empty DBs.
 */
export async function verifyEncryptionKey(
  storagePath: string,
  encKey: Buffer,
  collectionNames: string[],
): Promise<void> {
  const file = keycheckFile(storagePath);
  try {
    const raw = (await fs.readFile(file, 'utf8')).trim();
    const plain = decryptLine(raw, encKey);
    if (plain !== MAGIC) {
      throw new JSONSQLiteError(
        ErrorCode.ENCRYPTION,
        'Encryption key check failed',
      );
    }
    return;
  } catch (err) {
    if (err instanceof JSONSQLiteError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const probes = [
    ...collectionNames.map((name) => docsFile(storagePath, name)),
    ...collectionNames.map((name) => pageFile(storagePath, name, 1)),
  ];
  for (const file of probes) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        if (isEncryptedLine(line)) {
          decryptLine(line, encKey);
          await writeKeycheck(storagePath, encKey);
          return;
        }
        await writeKeycheck(storagePath, encKey);
        return;
      }
    } catch (err) {
      if (err instanceof JSONSQLiteError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  await writeKeycheck(storagePath, encKey);
}

export async function writeKeycheck(
  storagePath: string,
  encKey: Buffer,
): Promise<void> {
  await fs.mkdir(path.join(storagePath, 'meta'), { recursive: true });
  await fs.writeFile(
    keycheckFile(storagePath),
    `${encryptLine(MAGIC, encKey)}\n`,
    'utf8',
  );
}
