import { z } from 'zod';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { JSONSQLiteOptions } from '../types/index.js';

const optionsSchema = z.object({
  storagePath: z.string().min(1, 'storagePath is required'),
  walMode: z.boolean().default(true),
  defaultIsolation: z
    .enum([
      'READ_UNCOMMITTED',
      'READ_COMMITTED',
      'REPEATABLE_READ',
      'SERIALIZABLE',
    ])
    .default('READ_COMMITTED'),
  queryTimeout: z.number().int().positive().default(30_000),
  cacheSize: z.number().int().positive().default(1000),
  encryptionKey: z.string().min(1).optional().nullable(),
});

export type ResolvedOptions = z.infer<typeof optionsSchema>;

export function resolveOptions(input: JSONSQLiteOptions): ResolvedOptions {
  const parsed = optionsSchema.safeParse(input);
  if (!parsed.success) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      parsed.error.errors.map((e) => e.message).join('; '),
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}

export function resolveEncryptionKey(
  key?: string | null,
): Buffer | null {
  if (!key) {
    const env = process.env.JSONSQLITE_KEY;
    if (!env) return null;
    return Buffer.from(env, 'utf8');
  }
  return Buffer.from(key, 'utf8');
}
