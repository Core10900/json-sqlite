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
  autoTune: z.boolean().default(false),
  autoTuneDryRun: z.boolean().default(true),
  /** Minimum slow-query hits before AutoTune acts. Default 2. */
  autoTuneMinHits: z.number().int().positive().default(2),
  /** Persist index postings so reopen can skip a full rebuild (default on). */
  persistIndexes: z.boolean().default(true),
  /** Process-local L2 query cache. Default off — same behavior as 1.7. */
  l2Cache: z.boolean().default(false),
  l2CacheSize: z.number().int().positive().default(5000),
  /** Gzip JSONL lines at or above `compressionThreshold` bytes. Default off. */
  compression: z.boolean().default(false),
  compressionThreshold: z.number().int().nonnegative().default(1024),
  /**
   * Experimental hot/cold split. Default off. Cold docs stay out of the
   * hot JSONL until read. Not a stable on-disk promise for 2.0.
   */
  tiering: z.boolean().default(false),
  /** Docs with access count <= this value are swept to cold on close. */
  tierColdAfter: z.number().int().nonnegative().default(0),
  /** Documents stored in one page file (format 2). Default 32. */
  pageSize: z.number().int().positive().default(32),
  /**
   * Max document bodies kept in the page cache for a collection.
   * Must be >= pageSize. Default 256.
   */
  maxResidentDocs: z.number().int().positive().default(256),
  /** Scheduled backup interval ms; 0 = off (default). */
  backupIntervalMs: z.number().int().nonnegative().default(0),
  backupKeepDays: z.number().int().nonnegative().optional(),
  backupMaxCount: z.number().int().nonnegative().optional(),
  alerts: z
    .object({
      rules: z
        .array(
          z.object({
            kind: z.enum([
              'cache_hit',
              'error_rate',
              'corrupt',
              'backup_failed',
              'response_time',
            ]),
            cacheHitBelow: z.number().min(0).max(1).optional(),
            errorRateAbove: z.number().min(0).max(1).optional(),
          }),
        )
        .optional(),
      webhookUrl: z.string().min(1).nullable().optional(),
      /** Compare against recent p99 (ms). Omit or 0 = off. */
      responseTimeMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /** 2.3 column store master switch. Default off. */
  columnStore: z.boolean().default(false),
  columnCollections: z.array(z.string()).default([]),
  /** 2.3 hot/warm/cold layout. Default off. Distinct from 1.8 `tiering`. */
  storageTiers: z.boolean().default(false),
  coldAfter: z.number().int().nonnegative().default(0),
  warmAfter: z.number().int().nonnegative().default(1),
  /** Delta / dict / RLE / gzip block compression. Default off. */
  smartCompression: z.boolean().default(false),
  /** Extra index segment parts. Default off (2.2 single segment file). */
  indexDeltaSegments: z.boolean().default(false),
  cacheCompression: z.boolean().default(false),
  cacheCompressionThreshold: z.number().int().nonnegative().default(4096),
  prefetchPages: z.boolean().default(false),
  /** 0 = one-shot scan, same as 2.2. */
  queryChunkSize: z.number().int().nonnegative().default(0),
  chineseTokenizer: z.enum(['none', 'bigram']).default('none'),
  tokenizerModule: z.string().min(1).optional(),
  /**
   * single (default) matches LTS-2: a second process gets LOCK_FAILED.
   * multi is opt-in same-machine writers. Not an LTS contract until 2.5.
   */
  writers: z.enum(['single', 'multi']).default('single'),
  /**
   * Compile whitelist filter operators with `new Function`. Default off.
   * User strings are never interpolated into the function body.
   */
  compileFilters: z.boolean().default(false),
  /**
   * Maximum keys in one B+Tree node. Default 128. Tree indexes stay off
   * until `index create --type tree`. This only sets the node width.
   */
  bTreeOrder: z.number().int().min(3).max(4096).default(128),
  /**
   * When true, `storageAdvise` may print a suggestion. It never changes
   * a table's storage mode. Default false.
   */
  storageAdvise: z.boolean().default(false),
  /** Tables whose hot fields are columnar and whose other fields stay on document pages. */
  hybridCollections: z.array(z.string()).default([]),
  /** Hot fields as `table.field`. Ignored until the table is in `hybridCollections`. */
  hybridFields: z.array(z.string()).default([]),
  /**
   * Directory for cold-tier copies when `storageTiers` is on.
   * Omitted means cold copies stay inside the database directory.
   * An unreadable directory does not hide hot documents.
   */
  coldExternalDir: z.string().min(1).optional(),
  /** Bytes or elements sampled before picking a smart-compression algorithm. Default 64. */
  compressionSampleWindow: z.number().int().positive().default(64),
  /**
   * Inverted-index stop words. Omit to keep the built-in Chinese and English list.
   * An empty array keeps every token. Changing this rebuilds inverted indexes.
   */
  stopWords: z.array(z.string()).optional(),
  /**
   * Changelog / time-travel retention in ms. Default 7 days.
   * Separate from backup keepDays.
   */
  timeTravelRetentionMs: z
    .number()
    .int()
    .nonnegative()
    .default(7 * 86_400_000),
  /**
   * Transaction wall-clock timeout. Default 0 (off).
   * When > 0, timed-out transactions roll back with TX_TIMEOUT.
   */
  transactionTimeoutMs: z.number().int().nonnegative().default(0),
  /** Emit `metrics` events on this interval (ms). Default 5000. */
  metricsIntervalMs: z.number().int().positive().default(5000),
  /**
   * Heap watermark for /health. Default 0: report only, never degrade.
   * When > 0 and heapUsed exceeds it, health is degraded.
   */
  memoryWatermarkBytes: z.number().int().nonnegative().default(0),
  /** Delta lines before a checksummed snapshot. Default 1000. */
  deltaSnapshotThreshold: z.number().int().positive().default(1000),
  /**
   * Optional Redis L3. Default false. Missing client → open succeeds, L3 off.
   */
  l3: z.boolean().default(false),
  /**
   * Alias / marker for Redis. Default false. Missing client does not fail open.
   */
  redis: z.boolean().default(false),
  /**
   * Async replication opt-in (3.3). Default false.
   * Role still requires `replica init`. Object may set syncIntervalMs (ms).
   */
  replica: z
    .union([
      z.boolean(),
      z.object({
        enabled: z.boolean().optional(),
        syncIntervalMs: z.number().int().positive().optional(),
      }),
    ])
    .default(false),
});

export type ResolvedOptions = z.infer<typeof optionsSchema>;

const IMPLEMENTED_ISOLATION = new Set<IsolationLevel>([
  'READ_COMMITTED',
  'REPEATABLE_READ',
]);

/**
 * READ_COMMITTED and REPEATABLE_READ are implemented.
 * SERIALIZABLE is implemented only when writers is multi.
 * READ_UNCOMMITTED is rejected — never coerced.
 */
export function assertIsolationSupported(
  level: IsolationLevel,
  writers: 'single' | 'multi' = 'single',
): void {
  if (level === 'SERIALIZABLE' && writers === 'multi') return;
  if (!IMPLEMENTED_ISOLATION.has(level)) {
    throw new JSONSQLiteError(
      ErrorCode.ISOLATION_UNSUPPORTED,
      level === 'SERIALIZABLE'
        ? 'SERIALIZABLE requires writers: "multi" (single mode rejects it; changing isolation does not enable multi-writer)'
        : `Isolation level ${level} is not implemented (supported: READ_COMMITTED, REPEATABLE_READ)`,
    );
  }
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
  try {
    assertIsolationSupported(data.defaultIsolation, data.writers);
  } catch (err) {
    if (err instanceof JSONSQLiteError && err.code === ErrorCode.ISOLATION_UNSUPPORTED) {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        err.message,
        { isolation: data.defaultIsolation },
      );
    }
    throw err;
  }
  if (data.maxResidentDocs < data.pageSize) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `maxResidentDocs (${data.maxResidentDocs}) must be >= pageSize (${data.pageSize})`,
    );
  }
  if (data.warmAfter < data.coldAfter) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `warmAfter (${data.warmAfter}) must be >= coldAfter (${data.coldAfter})`,
    );
  }
  return data;
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
