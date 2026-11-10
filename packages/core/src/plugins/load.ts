import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import {
  assertPluginManifest,
  type EnginePlugin,
  type PluginManifest,
} from './registry.js';
import type { JsonQuery } from '../types/index.js';

export function isJsonQueryShape(value: unknown): value is JsonQuery {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.collection !== 'string' || !record.collection) return false;
  const allowed = new Set([
    'collection',
    'filter',
    'projection',
    'orderBy',
    'limit',
    'offset',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return false;
  }
  if (record.filter !== undefined) {
    if (
      record.filter === null ||
      typeof record.filter !== 'object' ||
      Array.isArray(record.filter)
    ) {
      return false;
    }
  }
  if (record.projection !== undefined && !Array.isArray(record.projection)) {
    return false;
  }
  if (
    record.limit !== undefined &&
    (typeof record.limit !== 'number' || !Number.isFinite(record.limit))
  ) {
    return false;
  }
  if (
    record.offset !== undefined &&
    (typeof record.offset !== 'number' || !Number.isFinite(record.offset))
  ) {
    return false;
  }
  return true;
}

/**
 * Load a plugin module from disk. Name/version validation failures
 * throw before registration. Evaluation errors are returned as failed.
 */
export async function loadPluginFromPath(
  filePath: string,
): Promise<EnginePlugin> {
  const resolved = path.resolve(filePath);
  let mod: Record<string, unknown>;
  try {
    const url = pathToFileURL(resolved).href;
    const importer = new Function(
      'specifier',
      'return import(specifier)',
    ) as (specifier: string) => Promise<Record<string, unknown>>;
    try {
      mod = await importer(url);
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING') {
        mod = await import(url);
      } else {
        throw err;
      }
    }
  } catch (err) {
    throw new JSONSQLiteError(
      ErrorCode.PLUGIN_REJECTED,
      `Failed to load plugin from ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const candidate =
    (mod.default as EnginePlugin | undefined) ??
    (mod.plugin as EnginePlugin | undefined) ??
    (mod as unknown as EnginePlugin);

  if (!candidate || typeof candidate !== 'object') {
    throw new JSONSQLiteError(
      ErrorCode.PLUGIN_REJECTED,
      `Plugin at ${resolved} does not export a plugin object`,
    );
  }

  const manifest: PluginManifest = {
    kind: candidate.kind,
    name: candidate.name,
    version: candidate.version,
    ...(candidate.stub !== undefined ? { stub: candidate.stub } : {}),
    ...(candidate.availableIn ? { availableIn: candidate.availableIn } : {}),
  };
  try {
    assertPluginManifest(manifest);
  } catch (err) {
    if (err instanceof JSONSQLiteError) {
      throw new JSONSQLiteError(
        ErrorCode.PLUGIN_REJECTED,
        err.message,
        err.details,
      );
    }
    throw err;
  }

  const withParse = candidate as EnginePlugin & {
    parse?: (input: unknown) => unknown;
  };
  if (typeof withParse.parse === 'function') {
    const original = withParse.parse.bind(candidate);
    withParse.parse = (input: unknown) => {
      const parsed = original(input);
      if (!isJsonQueryShape(parsed)) {
        throw new JSONSQLiteError(
          ErrorCode.PLUGIN_REJECTED,
          'queryLanguage.parse must return a JSON query object with a collection field',
        );
      }
      return parsed;
    };
  }

  return candidate;
}
