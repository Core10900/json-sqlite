import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { encryptLine, decryptLine } from '../src/crypto/aes.js';
import { helpRoot } from '../src/cli/help.js';
import { TreeIndex } from '../src/index/TreeIndex.js';
import { GeoIndex } from '../src/index/GeoIndex.js';
import { DEFAULT_STOP_WORDS, tokenize } from '../src/index/InvertedIndex.js';
import {
  ErrorCode,
  compressSmart,
  decompressSmart,
  getCompatibilityInfo,
  getVersion,
  open,
  readSmartHeader,
} from '../src/index.js';
import { pageFile } from '../src/utils/path.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v31-'));
  dirs.push(dir);
  return dir;
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliJs, ...args], {
      timeout: 20_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    if (e.killed) throw new Error(`CLI hung: ${args.join(' ')}`);
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

function ids(rows: { _id: string }[]): string[] {
  return rows.map((row) => row._id).sort();
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v3.1.0 gate', () => {
  it('FT-V31-VER-01 version is 3.1.0 and not LTS', () => {
    expect(getVersion()).toBe('3.1.0');
    const info = getCompatibilityInfo();
    expect(info.version).toBe('3.1.0');
    expect(info.lts).toBe(false);
    expect(info.ltsLine).toBe('2.5');
    expect(info.writers).toBe('single');
    expect(info.cliSurface).toBe('3.1.0');
    expect(info.features).toContain('btree');
    expect(info.features).not.toEqual(
      expect.arrayContaining(['cluster', 'replica', 'redis', 'graphql']),
    );
  });

  it('FT-V31-REG-01 default open writes no column files or cold directory', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'u1', name: '寒', age: 3 });
    const rows = await db.query({ collection: 'users', filter: { age: { $gt: 1 } } });
    expect(rows.map((row) => row._id)).toEqual(['u1']);
    expect(db.storageMode('users')).toBe('document');
    expect(db.columnStoreStatus('users').enabled).toBe(false);
    expect(db.tierSummary().enabled).toBe(false);
    await db.close();
    await expect(fs.access(path.join(storagePath, 'collections', 'users', 'columns'))).rejects.toThrow();
    await expect(fs.access(path.join(storagePath, 'collections', 'users', 'tiers'))).rejects.toThrow();
  });
});

describe('v3.1.0 B+Tree', () => {
  it('FT-V31-BT-01/02 range ids match a sorted scan and visits are not linear', () => {
    const order = 128;
    const count = 2000;
    const docs = Array.from({ length: count }, (_, i) => ({
      _id: `n${String(i).padStart(4, '0')}`,
      _version: 1,
      _createdAt: 0,
      _updatedAt: 0,
      n: i,
    }));
    const tree = new TreeIndex(
      { collection: 'nums', field: 'n', type: 'tree', createdAt: 0 },
      order,
    );
    tree.build(docs);
    const min = 40;
    const max = 55;
    const fromTree = tree.lookupRange(min, max).sort();
    const fromScan = docs
      .filter((doc) => doc.n >= min && doc.n <= max)
      .map((doc) => doc._id)
      .sort();
    expect(fromTree).toEqual(fromScan);
    const rangeVisits = tree.nodeVisits;
    expect(rangeVisits).toBeGreaterThan(0);
    expect(rangeVisits).toBeLessThan(count / 10);

    tree.lookupEq(1000);
    const pointVisits = tree.nodeVisits;
    expect(pointVisits).toBeLessThanOrEqual(Math.ceil(Math.log(count) / Math.log(order)) + 2);
    expect(pointVisits * 8).toBeLessThan(count);

    const small = new TreeIndex(
      { collection: 'nums', field: 'n', type: 'tree', createdAt: 0 },
      order,
    );
    small.build(docs.slice(0, 100));
    small.lookupEq(10);
    expect(tree.nodeVisits).toBeLessThan(small.nodeVisits * 20);
  });

  it('FT-V31-BT-03 compact and reopen keep the range', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, bTreeOrder: 8 });
    for (let i = 0; i < 40; i++) {
      await db.insert('nums', { _id: `n${i}`, n: i });
    }
    await db.createIndex('nums', 'n', 'tree');
    const before = await db.query({
      collection: 'nums',
      filter: { n: { $gte: 5, $lte: 12 } },
    });
    expect(db.explain({ collection: 'nums', filter: { n: { $gte: 5, $lte: 12 } } })).toMatchObject({
      access: 'index',
      structure: 'btree',
      usedIndex: { type: 'tree', field: 'n' },
    });
    db.resetIndexAccess('nums', 'n');
    await db.query({ collection: 'nums', filter: { n: 7 } });
    const access = db.indexAccess('nums', 'n');
    expect(access?.structure).toBe('btree');
    expect(access?.order).toBe(8);
    expect(access?.nodeVisits).toBeGreaterThan(0);
    expect(access!.nodeVisits).toBeLessThan(10);
    await db.compactIndexes('nums');
    await db.close();

    const again = await open({ storagePath, bTreeOrder: 8 });
    const after = await again.query({
      collection: 'nums',
      filter: { n: { $gte: 5, $lte: 12 } },
    });
    expect(ids(after)).toEqual(ids(before));
    await again.close();
  });
});

describe('v3.1.0 geo grid', () => {
  it('FT-V31-GEO-01/02 indexed lookup skips outside points and a missing index scans', async () => {
    const index = new GeoIndex({
      collection: 'places',
      field: 'loc',
      type: 'geo',
      createdAt: 0,
    });
    const docs = Array.from({ length: 20 }, (_, i) => ({
      _id: `p${i}`,
      _version: 1,
      _createdAt: 0,
      _updatedAt: 0,
      loc: { lat: i * 10, lon: i * 10 },
    }));
    index.build(docs);
    const box = { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 };
    expect(index.lookupGeo(box)).toEqual(['p0']);
    expect(index.examined).toBeLessThan(docs.length);
    expect(index.cellVisits).toBeLessThan(docs.length);

    const storagePath = await tmpDir();
    const db = await open({
      storagePath,
      pageSize: 1,
      maxResidentDocs: 1,
    });
    for (const doc of docs) await db.insert('places', doc);
    const scanned = db.explain({
      collection: 'places',
      filter: { loc: { $geoWithin: box } },
    });
    expect(scanned.access).toBe('scan');
    expect(scanned.usedIndex).toBeUndefined();
    const scanRows = await db.query({
      collection: 'places',
      filter: { loc: { $geoWithin: box } },
    });
    expect(scanRows.map((row) => row._id)).toEqual(['p0']);

    await db.createIndex('places', 'loc', 'geo');
    db.resetPageReads();
    db.resetIndexAccess('places', 'loc');
    const indexed = await db.query({
      collection: 'places',
      filter: { loc: { $geoWithin: box } },
    });
    expect(indexed.map((row) => row._id)).toEqual(['p0']);
    expect(db.lastPlan().usedIndex).toBe('geo:loc');
    expect(db.explain({ collection: 'places', filter: { loc: { $geoWithin: box } } }).structure).toBe(
      'grid',
    );
    const geo = db.indexAccess('places', 'loc');
    expect(geo?.examined).toBeLessThan(docs.length);
    expect(db.pagingStats().pageReads).toBeLessThan(docs.length);
    await db.close();
  });
});

describe('v3.1.0 tokenizer', () => {
  it('FT-V31-TOK-01 open without a module does not require one', async () => {
    const db = await open({ storagePath: await tmpDir() });
    expect(db.tokenizerStatus()).toMatchObject({
      available: false,
      reason: 'not-configured',
    });
    await db.insert('users', { _id: 'u', name: '寒' });
    expect((await db.findById('users', 'u'))?.name).toBe('寒');
    await db.close();
  });

  it('FT-V31-TOK-02 a throwing module still opens, and tokenized queries fail', async () => {
    const storagePath = await tmpDir();
    const file = path.join(storagePath, 'boom-tokenizer.mjs');
    await fs.writeFile(file, 'export function tokenize() { throw new Error("boom"); }\n');
    const db = await open({
      storagePath,
      tokenizerModule: pathToFileURL(file).href,
    });
    expect(db.tokenizerStatus().reason).not.toBe('module-not-found');
    await db.insert('notes', { _id: 'n1', text: 'hello world' });
    expect((await db.findById('notes', 'n1'))?.text).toBe('hello world');
    await expect(
      db.query({ collection: 'notes', filter: { text: { $contains: 'hello' } } }),
    ).rejects.toMatchObject({ code: ErrorCode.TOKENIZER_FAILED });
    expect((await db.findById('notes', 'n1'))?._id).toBe('n1');
    await db.close();
  });
});

describe('v3.1.0 columns and hybrid', () => {
  it('FT-V31-COL-01/02 projection reads the projected columns and a bad checksum falls back', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, columnCollections: ['docs'] });
    await db.insert('docs', { _id: 'a', name: 'ann', age: 3, extra: 'e' });
    await db.insert('docs', { _id: 'b', name: 'bo', age: 9, extra: 'f' });
    expect((await db.flushColumnStore('docs')).ready).toBe(true);
    const ageFile = path.join(
      storagePath,
      'collections',
      'docs',
      'columns',
      `${encodeURIComponent('age')}.json`,
    );
    const nameFile = path.join(
      storagePath,
      'collections',
      'docs',
      'columns',
      `${encodeURIComponent('name')}.json`,
    );
    expect(await fs.readFile(ageFile, 'utf8')).toMatch(/^JSQC2\|num\|/);
    expect(await fs.readFile(nameFile, 'utf8')).toMatch(/^JSQC2\|dict\|/);

    db.resetColumnFileReads();
    const projected = await db.query({ collection: 'docs', projection: ['name'] });
    expect(db.lastPlan().source).toBe('column');
    expect(db.lastPlan().columnFiles).toBe(2);
    expect(projected.map((row) => row.name).sort()).toEqual(['ann', 'bo']);

    await fs.writeFile(nameFile, 'JSQC2|dict|not-a-valid-checksum', 'utf8');
    const fallback = await db.query({
      collection: 'docs',
      projection: ['name'],
      filter: { age: { $gte: 0 } },
    });
    expect(fallback.map((row) => row.name).sort()).toEqual(['ann', 'bo']);
    expect(db.lastPlan().source).toBe('document');
    await db.close();
  });

  it('FT-V31-HYB-01 hybrid projection matches document mode', async () => {
    const rows = [
      { _id: 'a', name: 'ann', meta: { city: 'hz', extra: 1 } },
      { _id: 'b', name: 'bo', meta: { city: 'sh', extra: 2 } },
    ];
    const plainPath = await tmpDir();
    const plain = await open({ storagePath: plainPath });
    for (const row of rows) await plain.insert('docs', row);
    const fromDocs = await plain.query({
      collection: 'docs',
      projection: ['name', 'meta'],
      orderBy: { _id: 'asc' },
    });
    await plain.close();

    const hybridPath = await tmpDir();
    const hybrid = await open({
      storagePath: hybridPath,
      hybridCollections: ['docs'],
      hybridFields: ['docs.name'],
    });
    for (const row of rows) await hybrid.insert('docs', row);
    await hybrid.flushColumnStore('docs');
    expect(hybrid.storageMode('docs')).toBe('hybrid');
    const fromHybrid = await hybrid.query({
      collection: 'docs',
      projection: ['name', 'meta'],
      orderBy: { _id: 'asc' },
    });
    expect(fromHybrid.map((row) => ({ name: row.name, meta: row.meta }))).toEqual(
      fromDocs.map((row) => ({ name: row.name, meta: row.meta })),
    );
    await hybrid.close();
  });
});

describe('v3.1.0 storage advice', () => {
  it('FT-V31-ADP-01/02 advise reports cardinality and filter counts without changing the mode', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, storageAdvise: true });
    await db.insert('docs', { _id: 'a', name: 'ann', meta: { city: { code: 'hz' } } });
    await db.insert('docs', { _id: 'b', name: 'ann', meta: { city: { code: 'sh' } } });
    expect(db.storageMode('docs')).toBe('document');
    await db.query({ collection: 'docs', filter: { name: 'ann' } });
    await db.query({ collection: 'docs', filter: { name: 'ann' } });
    const advice = await db.storageAdvise('docs');
    expect(advice.applied).toBe(false);
    expect(advice.currentMode).toBe('document');
    expect(db.storageMode('docs')).toBe('document');
    expect(advice.cardinality.name).toBe(1);
    expect(advice.nestingDepth).toBeGreaterThanOrEqual(3);
    expect(advice.filterHistogram.name).toBe(2);
    expect(JSON.stringify(advice.filterHistogram)).not.toContain('ann');
    await db.close();
  });

  it('FT-V31-ADP-03 a large document can be suggested as compressed and the mode stays', async () => {
    const db = await open({
      storagePath: await tmpDir(),
      storageAdvise: true,
      compressionThreshold: 32,
    });
    await db.insert('docs', { _id: 'big', blob: 'x'.repeat(80) });
    const before = db.storageMode('docs');
    const advice = await db.storageAdvise('docs');
    expect(advice.suggestion).toBe('compressed');
    expect(advice.applied).toBe(false);
    expect(db.storageMode('docs')).toBe(before);
    await db.close();

    const off = await open({ storagePath: await tmpDir() });
    await expect(off.storageAdvise('docs')).rejects.toMatchObject({
      code: ErrorCode.INVALID_CONFIG,
    });
    await off.close();
  });
});

describe('v3.1.0 compression and tiers', () => {
  it('FT-V31-CMP-01/02 front-coding round-trips, including compress-then-encrypt', () => {
    const values = Array.from({ length: 8 }, (_, i) => `shared-prefix-value-${i}`);
    const json = JSON.stringify(values);
    const block = compressSmart(json, 4);
    expect(block.algorithm).toBe('front');
    expect(readSmartHeader(block.text)).toMatchObject({
      magic: 'JSQB1',
      algorithm: 'front',
    });
    expect(decompressSmart(block.text)).toBe(json);

    const key = Buffer.from('test-key');
    const encrypted = encryptLine(block.text, key);
    expect(decompressSmart(decryptLine(encrypted, key))).toBe(json);
    expect(() => decompressSmart('JSQB1|front|nope')).toThrow(/DATA_CORRUPT|round-trip failed/);
  });

  it('FT-V31-TIER-01 an unreadable cold directory still serves the hot document', async () => {
    const storagePath = await tmpDir();
    const external = path.join(storagePath, 'not-a-directory');
    await fs.writeFile(external, 'blocked');
    const db = await open({
      storagePath,
      storageTiers: true,
      coldExternalDir: external,
      coldAfter: 0,
      warmAfter: 0,
    });
    await db.insert('docs', { _id: 'hot', name: 'H' });
    await db.insert('docs', { _id: 'cold', name: 'C' });
    expect((await db.findById('docs', 'hot'))?.name).toBe('H');
    const summary = await db.migrateTiersOnce();
    expect(summary.externalFailures).toBeGreaterThan(0);
    expect((await db.findById('docs', 'hot'))?.name).toBe('H');
    const warmFile = path.join(storagePath, 'collections', 'docs', 'tiers', 'warm.jsonl');
    const coldFile = path.join(storagePath, 'collections', 'docs', 'tiers', 'cold.jsonl');
    const warm = await fs.readFile(warmFile, 'utf8').catch(() => '');
    const cold = await fs.readFile(coldFile, 'utf8');
    if (warm.trim()) expect(warm).toContain('JSQL1|deflate|');
    expect(cold).toMatch(/JSQC1\|(gzip|zstd)\|/);
    await db.close();

    const again = await open({
      storagePath,
      storageTiers: true,
      coldExternalDir: external,
      coldAfter: 0,
      warmAfter: 0,
    });
    expect((await again.findById('docs', 'hot'))?.name).toBe('H');
    await again.close();
  });
});

describe('v3.1.0 cache and stop words', () => {
  it('FT-V31-CACHE-01 a failed prefetch still reads the requested page', async () => {
    const storagePath = await tmpDir();
    const db = await open({
      storagePath,
      pageSize: 2,
      prefetchPages: true,
      lazyCollections: true,
    });
    await db.insert('docs', { _id: 'a', name: 'A' });
    await db.insert('docs', { _id: 'b', name: 'B' });
    await db.insert('docs', { _id: 'c', name: 'C' });
    await db.insert('docs', { _id: 'd', name: 'D' });
    await db.close();

    const again = await open({
      storagePath,
      pageSize: 2,
      prefetchPages: true,
      lazyCollections: true,
    });
    await fs.writeFile(pageFile(storagePath, 'docs', 2), 'this is not a document\n');
    again.resetPrefetchStats();
    expect((await again.findById('docs', 'a'))?.name).toBe('A');
    expect(again.prefetchStats().fallbacks).toBeGreaterThan(0);
    await again.close();

    const hot = await open({ storagePath: await tmpDir() });
    await hot.insert('docs', { _id: 'a', name: 'A' });
    await hot.query({ collection: 'docs', filter: { name: 'A' } });
    await hot.query({ collection: 'docs', filter: { name: 'A' } });
    expect(hot.getMetrics().l1.promotions).toBeGreaterThan(0);
    await hot.close();
  });

  it('FT-V31-STOP-01/02 default stops match 2.5, custom and empty lists rebuild', async () => {
    expect(tokenize('the cat and the dog')).toEqual(['cat', 'dog']);
    expect(DEFAULT_STOP_WORDS).toEqual(
      expect.arrayContaining(['的', 'the', 'and']),
    );

    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('notes', { _id: 'n', text: 'the cat and the dog' });
    await db.createIndex('notes', 'text', 'inverted');
    expect(
      await db.query({ collection: 'notes', filter: { text: { $contains: 'the' } } }),
    ).toEqual([]);
    expect(
      ids(await db.query({ collection: 'notes', filter: { text: { $contains: 'cat' } } })),
    ).toEqual(['n']);

    await db.setStopWords(['cat']);
    expect(
      await db.query({ collection: 'notes', filter: { text: { $contains: 'cat' } } }),
    ).toEqual([]);
    expect(
      ids(await db.query({ collection: 'notes', filter: { text: { $contains: 'dog' } } })),
    ).toEqual(['n']);

    await db.setStopWords([]);
    expect(
      ids(await db.query({ collection: 'notes', filter: { text: { $contains: 'the' } } })),
    ).toEqual(['n']);
    await db.close();
  });
});

describe('v3.1.0 CLI', () => {
  it('explains a tree index and storage advise does not create column files', async () => {
    const storagePath = await tmpDir();
    expect((await cli(['init', '-p', storagePath, '--json'])).code).toBe(0);
    expect(
      (
        await cli([
          'insert',
          'nums',
          '--data',
          '{"_id":"a","n":1}',
          '-p',
          storagePath,
          '--json',
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await cli([
          'insert',
          'nums',
          '--data',
          '{"_id":"b","n":2}',
          '-p',
          storagePath,
          '--json',
        ])
      ).code,
    ).toBe(0);
    const created = await cli([
      'index',
      'create',
      'nums',
      'n',
      '--type',
      'tree',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout).index.type).toBe('tree');
    const explained = await cli([
      'explain',
      '{"collection":"nums","filter":{"n":{"$gte":1,"$lte":2}}}',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(explained.code).toBe(0);
    const plan = JSON.parse(explained.stdout) as { access: string; structure: string };
    expect(plan.access).toBe('index');
    expect(plan.structure).toBe('btree');

    const advice = await cli(['storage', 'advise', 'nums', '-p', storagePath, '--json']);
    expect(advice.code).toBe(0);
    const body = JSON.parse(advice.stdout) as {
      advice: { applied: boolean; currentMode: string; nestingDepth: number };
    };
    expect(body.advice.applied).toBe(false);
    expect(body.advice.currentMode).toBe('document');
    expect(body.advice.nestingDepth).toBeGreaterThan(0);
    await expect(
      fs.access(path.join(storagePath, 'collections', 'nums', 'columns')),
    ).rejects.toThrow();
    expect(helpRoot()).toContain('storage advise');
  });
});
