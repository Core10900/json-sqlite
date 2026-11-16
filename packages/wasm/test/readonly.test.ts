import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { open } from '@webofcat/jsonsqlite';
import {
  ExperimentalReadonlyError,
  meta,
  openReadonly,
} from '../src/index.js';

const dirs: string[] = [];
// vitest cwd is packages/wasm
const corePkgPath = path.resolve(process.cwd(), '../core/package.json');
const coreHelpPath = path.resolve(process.cwd(), '../core/src/cli/help.ts');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-wasm-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('FT-V35-WASM-01 optional read-only package', () => {
  it('meta has experimental + readOnly and version 3.5.0', () => {
    expect(meta.experimental).toBe(true);
    expect(meta.readOnly).toBe(true);
    expect(meta.version).toBe('3.5.0');
  });

  it('can query and findById an existing DB directory', async () => {
    const storagePath = await tmpDir();
    const writer = await open({ storagePath });
    const inserted = await writer.insert('users', {
      name: '寒',
      age: 30,
    });
    const doc = Array.isArray(inserted) ? inserted[0]! : inserted;
    await writer.close();

    const db = await openReadonly({ storagePath });
    const rows = await db.query({
      collection: 'users',
      filter: { name: '寒' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('寒');

    const one = await db.findById('users', doc._id);
    expect(one?.name).toBe('寒');
    await db.close();
  });

  it('insert / update / delete throw experimental read-only errors', async () => {
    const storagePath = await tmpDir();
    const writer = await open({ storagePath });
    const inserted = await writer.insert('users', { name: 'x' });
    const doc = Array.isArray(inserted) ? inserted[0]! : inserted;
    await writer.close();

    const db = await openReadonly({ storagePath });

    await expect(db.insert('users', { name: 'y' })).rejects.toBeInstanceOf(
      ExperimentalReadonlyError,
    );
    await expect(db.insert('users', { name: 'y' })).rejects.toThrow(
      /experimental|read-only|read only/i,
    );

    await expect(
      db.update('users', doc._id, { name: 'z' }),
    ).rejects.toBeInstanceOf(ExperimentalReadonlyError);

    await expect(db.delete('users', doc._id)).rejects.toBeInstanceOf(
      ExperimentalReadonlyError,
    );

    // Data unchanged after refused writes
    const still = await db.findById('users', doc._id);
    expect(still?.name).toBe('x');
    await db.close();
  });

  it('core helpRoot does not mention wasm; core bin has no wasm entry', async () => {
    // Read help source (avoid importing lifecycle's __JSONSQLITE_VERSION__ define).
    const helpSrc = await fs.readFile(coreHelpPath, 'utf8');
    const helpRootBody = helpSrc.slice(
      helpSrc.indexOf('export function helpRoot'),
      helpSrc.indexOf('export function helpTable'),
    );
    expect(helpRootBody.toLowerCase()).not.toMatch(/\bwasm\b/);

    const corePkg = JSON.parse(await fs.readFile(corePkgPath, 'utf8')) as {
      bin?: Record<string, string>;
      name: string;
    };
    expect(corePkg.name).toBe('@webofcat/jsonsqlite');
    const binNames = Object.keys(corePkg.bin ?? {});
    expect(binNames).not.toContain('wasm');
    expect(binNames.join(' ').toLowerCase()).not.toMatch(/wasm/);
    for (const entry of Object.values(corePkg.bin ?? {})) {
      expect(entry.toLowerCase()).not.toMatch(/wasm/);
    }
  });
});
