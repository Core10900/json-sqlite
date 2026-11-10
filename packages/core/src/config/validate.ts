import fs from 'node:fs/promises';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { resolveOptions, type ResolvedOptions } from './defaults.js';
import type { JSONSQLiteOptions } from '../types/index.js';

/** Keys accepted by `open` / `create` on the 2.2 LTS line. */
export const FROZEN_CONFIG_KEYS = [
  'storagePath',
  'walMode',
  'defaultIsolation',
  'queryTimeout',
  'cacheSize',
  'encryptionKey',
  'syncMode',
  'schemaMode',
  'lazyCollections',
  'prefetchCollections',
  'autoTune',
  'autoTuneDryRun',
  'persistIndexes',
  'l2Cache',
  'l2CacheSize',
  'compression',
  'compressionThreshold',
  'tiering',
  'tierColdAfter',
  'pageSize',
  'maxResidentDocs',
  'backupIntervalMs',
  'backupKeepDays',
  'backupMaxCount',
  'alerts',
] as const;

/**
 * Opt-in keys added in 2.3. They are accepted and default off.
 * A 2.2 config file that omits them still validates.
 */
export const V23_CONFIG_KEYS = [
  'columnStore',
  'columnCollections',
  'storageTiers',
  'coldAfter',
  'warmAfter',
  'smartCompression',
  'indexDeltaSegments',
  'cacheCompression',
  'cacheCompressionThreshold',
  'prefetchPages',
  'queryChunkSize',
  'chineseTokenizer',
  'tokenizerModule',
] as const;

/** Opt-in in 2.4. Default remains single. Omitted keys do not enable multi-writer. */
export const V24_CONFIG_KEYS = ['writers'] as const;

/** Opt-in in 3.0. Default off. Omitting it keeps interpreted filters. */
export const V30_CONFIG_KEYS = ['compileFilters'] as const;

/**
 * Opt-in in 3.1. Default off or equal to the 3.0 path.
 * Omitting them does not switch storage format.
 */
export const V31_CONFIG_KEYS = [
  'bTreeOrder',
  'storageAdvise',
  'hybridCollections',
  'hybridFields',
  'coldExternalDir',
  'compressionSampleWindow',
  'stopWords',
] as const;

/**
 * Opt-in in 3.2. Default off or equal to the 3.1 path.
 * `l3` / `redis` are accepted; missing client keeps L3 closed.
 */
export const V32_CONFIG_KEYS = [
  'autoTuneMinHits',
  'timeTravelRetentionMs',
  'transactionTimeoutMs',
  'metricsIntervalMs',
  'memoryWatermarkBytes',
  'deltaSnapshotThreshold',
  'l3',
  'redis',
] as const;

/**
 * Design §9 / later-plan keys that must not appear in a supported config.
 * They are refused by name. They are not stripped and not applied.
 * `cache` is here because §9 nests Redis L3 under `cache.l3`; the frozen
 * field is `cacheSize`. `l3` / `redis` moved to V32_CONFIG_KEYS in 3.2.
 */
export const DANGEROUS_CONFIG_KEYS = [
  'cache',
  'cluster',
  'replica',
  'replication',
  'raft',
  'quorum',
  'shard',
  'sharding',
  'savepoint',
  'graphql',
  'wasm',
] as const;

const frozen = new Set<string>([
  ...FROZEN_CONFIG_KEYS,
  ...V23_CONFIG_KEYS,
  ...V24_CONFIG_KEYS,
  ...V30_CONFIG_KEYS,
  ...V31_CONFIG_KEYS,
  ...V32_CONFIG_KEYS,
]);
const dangerous = new Set<string>(DANGEROUS_CONFIG_KEYS);

/**
 * Validate a config object against the 2.2 frozen key set, then the
 * same schema `open` uses. Unknown keys and dangerous keys both throw
 * `INVALID_CONFIG` before any default is applied.
 */
export function validateConfig(input: unknown): ResolvedOptions {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new JSONSQLiteError(ErrorCode.INVALID_CONFIG, 'Config must be a JSON object');
  }
  const record = input as Record<string, unknown>;
  const rejectedDangerous: string[] = [];
  const unknown: string[] = [];
  for (const key of Object.keys(record)) {
    if (frozen.has(key)) continue;
    if (dangerous.has(key)) rejectedDangerous.push(key);
    else unknown.push(key);
  }
  if (rejectedDangerous.length > 0 || unknown.length > 0) {
    const parts: string[] = [];
    if (rejectedDangerous.length > 0) {
      const names = rejectedDangerous.map((k) => `"${k}"`).join(', ');
      parts.push(
        `Rejected dangerous config key(s) ${names}: not part of the supported contract (no cluster, replica, GraphQL, or WASM). The key is not applied`,
      );
    }
    if (unknown.length > 0) {
      const names = unknown.map((k) => `"${k}"`).join(', ');
      parts.push(
        `Unknown config key(s) ${names}: not in the 2.2 frozen set or the 2.3/2.4/3.0/3.1/3.2 opt-in set. Refused and not applied`,
      );
    }
    throw new JSONSQLiteError(ErrorCode.INVALID_CONFIG, parts.join('; '), {
      dangerous: rejectedDangerous,
      unknown,
    });
  }
  return resolveOptions(record as unknown as JSONSQLiteOptions);
}

/** Read and validate a JSON config file. Does not open a database. */
export async function validateConfigFile(file: string): Promise<ResolvedOptions> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        `Config file not found: ${file}`,
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `Config file is not valid JSON: ${file}`,
    );
  }
  return validateConfig(parsed);
}
