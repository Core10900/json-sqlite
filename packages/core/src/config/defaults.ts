import { z } from 'zod';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { IsolationLevel, JSONSQLiteOptions } from '../types/index.js';

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
  queryTimeout: z.number().int().nonnegative().default(30_000),
  cacheSize: z.number().int().positive().default(1000),
  encryptionKey: z.string().min(1).optional().nullable(),
  syncMode: z.enum(['none', 'normal', 'full']).default('normal'),
  schemaMode: z.enum(['off', 'warn', 'strict']).default('off'),
  lazyCollections: z.boolean().default(true),
  prefetchCollections: z.array(z.string()).default([]),
});

export type ResolvedOptions = z.infer<typeof optionsSchema>;

/** Levels beyond READ_COMMITTED are not implemented; coerce with notice. */
export function coerceIsolation(level: IsolationLevel): IsolationLevel {
  if (level === 'READ_COMMITTED' || level === 'READ_UNCOMMITTED') {
    return level === 'READ_UNCOMMITTED' ? 'READ_COMMITTED' : level;
  }
  return 'READ_COMMITTED';
}

export function resolveOptions(input: JSONSQLiteOptions): ResolvedOptions {
  const parsed = optionsSchema.safeParse(input);
  if (!parsed.success) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      parsed.error.errors.map((e) => e.message).join('; '),
      parsed.error.flatten(),
    );
  }
  const data = parsed.data;
  return {
    ...data,
    defaultIsolation: coerceIsolation(data.defaultIsolation),
  };
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
