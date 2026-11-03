import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptLine, encryptLine } from '../src/crypto/aes.js';
import { helpIndex, helpRoot } from '../src/cli/help.js';
import {
  createS3Stub,
  createVectorStub,
  getCompatibilityInfo,
  getVersion,
  open,
} from '../src/index.js';
import { columnManifestPath } from '../src/storage/columnStore.js';
import {
  compressSmart,
  decompressSmart,
  selectAlgorithm,
} from '../src/storage/smartCompress.js';
import type { Document } from '../src/types/index.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v23-'));
  dirs.push(dir);
  return dir;
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliJs, ...args], {
      timeout: 25_000,
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

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v2.3.0 defaults stay on the 2.2 path', () => {
  it('FT-V23-VER-01 version is 2.3.0 and not LTS', () => {
    expect(getVersion()).toBe('2.3.0');
    const info = getCompatibilityInfo();
    expect(info.version).toBe('2.3.0');
    expect(info.lts).toBe(false);
    expect(info.ltsLine).toBe('2.2');
    expect(info.writers).toBe('single');
    expect(info.cliSurface).toBe('2.3.0');
    expect(info.features).toContain('column-store');
    expect(info.features).toContain('vector-stub');
    expect(info.features).not.toEqual(expect.arrayContaining(['cluster', 'replica']));
  });

  it('FT-V23-REG-01 default open does not enable column store or plugins', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'u1', name: '寒' });
    const rows = await db.query({ collection: 'users' });
    expect(rows.map((row) => row.name)).toEqual(['寒']);
    expect(db.columnStoreStatus('users').enabled).toBe(false);
    expect(db.lastPlan().source).toBe('document');
    expect(db.lastPlan().chunked).toBe(false);
    expect(db.listPlugins()).toEqual([]);
    expect(db.tierSummary().enabled).toBe(false);
    expect(db.tokenizerStatus().available).toBe(false);
    await db.close();
  });
});

describe('v2.3.0 column store', () => {
  it('FT-V23-COL-01 projection matches document mode and reads fewer files', async () => {
    const storagePath = await tmpDir();
    const db = await open({
      storagePath,
      pageSize: 4,
      columnCollections: ['docs'],
    });
    for (let i = 0; i < 16; i++) {
      await db.insert('docs', { _id: `d${i}`, name: `n${i}`, extra: `e${i}` });
    }
    const status = await db.flushColumnStore('docs');
    expect(status.ready).toBe(true);

    db.resetPageReads();
    db.resetColumnFileReads();
    const viaColumn = await db.query({
      collection: 'docs',
      projection: ['name'],
    });
    expect(db.lastPlan().source).toBe('column');
    expect(db.lastPlan().columnFiles).toBe(2);
    expect(db.pagingStats().pageReads).toBe(0);
    expect(viaColumn).toHaveLength(16);
    await db.close();

    const db2 = await open({
      storagePath,
      pageSize: 4,
      columnCollections: ['docs'],
    });
    db2.resetPageReads();
    const viaDocument = await db2.query(
      { collection: 'docs', projection: ['name'] },
      { column: false },
    );
    expect(db2.pagingStats().pageReads).toBe(4);
    expect(db2.lastPlan().columnFiles).toBe(0);
    expect(viaDocument).toEqual(viaColumn);
    await db2.close();
  });

  it('FT-V23-COL-02 a torn column rebuild does not hide a WAL commit', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, columnCollections: ['docs'] });
    await db.insert('docs', { _id: 'a', name: 'A' });
    expect((await db.flushColumnStore('docs')).ready).toBe(true);
    db._store.crashAfterWal = true;
    await expect(db.insert('docs', { _id: 'b', name: 'B' })).rejects.toThrow(/WAL/);
    await db.close({ flush: false });

    await fs.writeFile(
      columnManifestPath(storagePath, 'docs'),
      JSON.stringify({ ready: false, generation: 1, fields: [], docCount: 0, revisionSum: 0, checksum: '' }),
    );

    const db2 = await open({ storagePath, columnCollections: ['docs'] });
    const rows = await db2.query({ collection: 'docs' });
    expect(rows.map((row) => row._id).sort()).toEqual(['a', 'b']);
    expect(rows.find((row) => row._id === 'b')?.name).toBe('B');
    await db2.close();
  });
});

describe('v2.3.0 tiers', () => {
  it('FT-V23-TIER-01 cold read is correct and migration does not block a commit', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, storageTiers: true });
    await db.insert('users', { _id: 'old', name: 'kept' });

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    db.registerPlugin({
      kind: 'storage',
      name: 'slow',
      version: '1.0.0',
      putCold: () => gate,
    });

    const pending = db.migrateTiersOnce();
    await new Promise((resolve) => setImmediate(resolve));
    const started = Date.now();
    await db.insert('users', { _id: 'new', name: 'fresh' });
    expect(Date.now() - started).toBeLessThan(500);
    release();
    await pending;

    const kept = await db.findById('users', 'old');
    const fresh = await db.findById('users', 'new');
    expect(kept?.name).toBe('kept');
    expect(fresh?.name).toBe('fresh');
    expect(db.tierSummary().cold).toBeGreaterThanOrEqual(1);
    expect(db.tierSummary().coldReads).toBeGreaterThanOrEqual(1);
    await db.close();
  });
});

describe('v2.3.0 compression', () => {
  it('FT-V23-CMP-01 algorithms round-trip, with and without encryption', () => {
    const numbers = JSON.stringify([1, 2, 3, 4, 8]);
    expect(selectAlgorithm(JSON.parse(numbers))).toBe('delta');
    const delta = compressSmart(numbers);
    expect(delta.text.startsWith('JSQB1|delta|')).toBe(true);
    expect(decompressSmart(delta.text)).toBe(numbers);

    const dictInput = JSON.stringify(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b']);
    expect(selectAlgorithm(JSON.parse(dictInput))).toBe('dict');
    const dict = compressSmart(dictInput);
    expect(dict.algorithm).toBe('dict');
    expect(decompressSmart(dict.text)).toBe(dictInput);

    const rleInput = JSON.stringify(['aa', 'aa', 'aa', 'bb', 'bb', 'bb', 'cc', 'cc', 'cc']);
    expect(selectAlgorithm(JSON.parse(rleInput))).toBe('rle');
    const rle = compressSmart(rleInput);
    expect(rle.algorithm).toBe('rle');
    expect(decompressSmart(rle.text)).toBe(rleInput);

    const gzipInput = JSON.stringify({ note: 'plain object uses gzip' });
    expect(selectAlgorithm(JSON.parse(gzipInput))).toBe('gzip');
    const gzip = compressSmart(gzipInput);
    expect(gzip.algorithm).toBe('gzip');
    expect(decompressSmart(gzip.text)).toBe(gzipInput);

    const key = Buffer.from('test-key');
    const encrypted = encryptLine(delta.text, key);
    expect(decompressSmart(decryptLine(encrypted, key))).toBe(numbers);

    expect(() => decompressSmart('JSQB1|delta|{')).toThrow(/DATA_CORRUPT|round-trip failed/);
  });

  it('FT-V23-CMP-01 stored documents round-trip with smart compression and encryption', async () => {
    const plainPath = await tmpDir();
    const plain = await open({ storagePath: plainPath, smartCompression: true });
    await plain.insert('docs', { _id: 'p', values: [1, 2, 3, 4, 5], name: '寒' });
    await plain.close();
    const plain2 = await open({ storagePath: plainPath, smartCompression: true });
    expect((await plain2.findById('docs', 'p'))?.name).toBe('寒');
    await plain2.close();

    const encPath = await tmpDir();
    const enc = await open({
      storagePath: encPath,
      smartCompression: true,
      encryptionKey: 'secret',
    });
    await enc.insert('docs', { _id: 'e', name: '密文' });
    await enc.close();
    const enc2 = await open({
      storagePath: encPath,
      smartCompression: true,
      encryptionKey: 'secret',
    });
    expect((await enc2.findById('docs', 'e'))?.name).toBe('密文');
    await enc2.close();

    const torn = path.join(plainPath, 'collections', 'docs', 'docs', 'pages');
    const pageDir = path.join(plainPath, 'collections', 'docs', 'docs', 'pages');
    await fs.mkdir(pageDir, { recursive: true });
    const pages = await fs.readdir(path.join(plainPath, 'collections', 'docs', 'docs', 'pages'));
    expect(pages.length).toBeGreaterThan(0);
    await fs.writeFile(path.join(pageDir, pages[0]!), 'JSQB1|delta|{\n', 'utf8');
    await expect(open({ storagePath: plainPath, smartCompression: true })).rejects.toMatchObject({
      code: 'DATA_CORRUPT',
    });
    expect(torn).toBeTruthy();
  });
});

describe('v2.3.0 index compact, cache, chunk, geo', () => {
  it('FT-V23-IDX-01 compact keeps query results and the merged segment reopens', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, indexDeltaSegments: true });
    await db.insert('users', { _id: 'a', name: 'ann' });
    await db.insert('users', { _id: 'b', name: 'ann' });
    await db.createIndex('users', 'name', 'object');
    await db.insert('users', { _id: 'c', name: 'bob' });
    const before = await db.query({
      collection: 'users',
      filter: { name: 'ann' },
      orderBy: { _id: 'asc' },
    });
    expect(db.indexPersistence().parts['users:name']).toBeGreaterThanOrEqual(2);
    const compacted = await db.compactIndexes('users');
    expect(compacted.partsMerged).toBeGreaterThanOrEqual(2);
    const after = await db.query({
      collection: 'users',
      filter: { name: 'ann' },
      orderBy: { _id: 'asc' },
    });
    expect(after.map((row) => row._id)).toEqual(before.map((row) => row._id));
    await db.close();

    const db2 = await open({ storagePath, indexDeltaSegments: true });
    const reopened = await db2.query({
      collection: 'users',
      filter: { name: 'ann' },
      orderBy: { _id: 'asc' },
    });
    expect(reopened.map((row) => row._id)).toEqual(['a', 'b']);
    expect(db2.indexPersistence().servedFromSegment).toContain('users');
    expect(db2.indexPersistence().merged).toContain('users:name');
    await db2.close();
  });

  it('FT-V23-CACHE-01 a compressed cache hit returns the original document', async () => {
    const storagePath = await tmpDir();
    const db = await open({
      storagePath,
      cacheCompression: true,
      cacheCompressionThreshold: 4096,
    });
    const blob = '寒'.repeat(5000);
    await db.insert('docs', { _id: 'a', blob });
    const first = await db.query({ collection: 'docs' });
    const second = await db.query({ collection: 'docs' });
    expect(second).toEqual(first);
    expect((second[0] as Document).blob).toBe(blob);
    expect(db.getMetrics().cacheCompression.compressedSets).toBeGreaterThanOrEqual(1);
    expect(db.lastPlan().source).toBe('cache');
    await db.close();
  });

  it('FT-V23-CACHE-01 prefetch hit is counted and a miss falls back', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, pageSize: 2, prefetchPages: true });
    for (const id of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) {
      await db.insert('docs', { _id: id, name: id });
    }
    await db.close();

    const db2 = await open({ storagePath, pageSize: 2, prefetchPages: true });
    db2.resetPrefetchStats();
    expect((await db2.findById('docs', 'p0'))?.name).toBe('p0');
    expect((await db2.findById('docs', 'p2'))?.name).toBe('p2');
    expect(db2.prefetchStats().hits).toBeGreaterThanOrEqual(1);
    await db2.close();

    const onePage = await tmpDir();
    const db3 = await open({ storagePath: onePage, pageSize: 2, prefetchPages: true });
    await db3.insert('docs', { _id: 'a', name: 'a' });
    await db3.insert('docs', { _id: 'b', name: 'b' });
    await db3.close();
    const db4 = await open({ storagePath: onePage, pageSize: 2, prefetchPages: true });
    db4.resetPrefetchStats();
    expect((await db4.findById('docs', 'a'))?.name).toBe('a');
    expect(db4.prefetchStats().fallbacks).toBeGreaterThanOrEqual(1);
    await db4.close();
  });

  it('FT-V23-EXE-01 chunked execution matches a single pass', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    for (let n = 1; n <= 5; n++) await db.insert('nums', { _id: `n${n}`, n });
    const query = { collection: 'nums', orderBy: { n: 'asc' as const }, projection: ['n'] };
    const once = await db.query(query);
    const chunked = await db.query(query, { chunkSize: 2 });
    expect(db.lastPlan().chunked).toBe(true);
    expect(db.lastPlan().chunks).toBe(3);
    expect(chunked).toEqual(once);
    await db.close();
  });

  it('FT-V23-GEO-01 box queries match with and without a geo index', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('places', { _id: 'in', loc: { lat: 31.2, lon: 121.5 } });
    await db.insert('places', { _id: 'out', loc: { lat: 39.9, lon: 116.4 } });
    const box = { minLat: 30, minLon: 120, maxLat: 32, maxLon: 122 };
    const scanned = await db.query({
      collection: 'places',
      filter: { loc: { $geoWithin: box } },
    });
    expect(scanned.map((row) => row._id)).toEqual(['in']);
    expect(db.lastPlan().usedIndex).toBeUndefined();

    await db.createIndex('places', 'loc', 'geo');
    const indexed = await db.query({
      collection: 'places',
      filter: { loc: { $geoWithin: box } },
    });
    expect(indexed.map((row) => row._id)).toEqual(['in']);
    expect(db.lastPlan().usedIndex).toBe('geo:loc');
    await db.close();
  });
});

describe('v2.3.0 plugins and tokenizer', () => {
  it('FT-V23-PLG-01 a throwing plugin does not stop queries', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'u1', name: '寒' });
    expect(() =>
      db.registerPlugin({
        kind: 'index',
        name: 'Bad',
        version: '1.0.0',
      }),
    ).toThrow(/Plugin name/);
    db.registerPlugin({
      kind: 'queryLanguage',
      name: 'boom',
      version: '1.0.0',
      onQuery() {
        throw new Error('plugin exploded');
      },
    });
    for (const kind of ['index', 'storage', 'compression', 'backup'] as const) {
      db.registerPlugin({ kind, name: `p-${kind}`, version: '1.2.3' });
    }
    const rows = await db.query({ collection: 'users' });
    expect(rows.map((row) => row.name)).toEqual(['寒']);
    expect(db.pluginErrors().some((err) => err.message.includes('plugin exploded'))).toBe(true);
    expect(db.listPlugins().map((plugin) => plugin.kind).sort()).toEqual([
      'backup',
      'compression',
      'index',
      'queryLanguage',
      'storage',
    ]);
    await db.close();
  });

  it('FT-V23-PLG-02 vector and s3 stubs record calls and are not real implementations', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, storageTiers: true });
    await db.insert('docs', { _id: 'a', name: 'row' });
    const vector = createVectorStub();
    const s3 = createS3Stub();
    db.registerPlugin(vector);
    db.registerPlugin(s3);
    const found = await db.vectorSearch('docs', [0.1, 0.2]);
    expect(found).toMatchObject({
      hits: [],
      stub: true,
      availableIn: '3.3',
      called: true,
    });
    expect(vector.calls).toBe(1);
    await db.migrateTiersOnce();
    expect(s3.calls).toBeGreaterThanOrEqual(1);
    expect((await db.findById('docs', 'a'))?.name).toBe('row');
    await db.close();
  });

  it('FT-V23-TOK-01 open succeeds when the tokenizer module is missing', async () => {
    const storagePath = await tmpDir();
    const db = await open({
      storagePath,
      tokenizerModule: 'jsonsqlite-cjk-tokenizer-missing',
    });
    expect(db.tokenizerStatus()).toMatchObject({
      available: false,
      reason: 'module-not-found',
    });
    await db.insert('users', { _id: 'u1', name: '寒' });
    const rows = await db.query({ collection: 'users', filter: { name: '寒' } });
    expect(rows).toHaveLength(1);
    await db.close();
  });

  it('FT-V23-TOK-02 a bigram tokenizer hits the Chinese sample', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, chineseTokenizer: 'bigram' });
    expect(db.tokenizerStatus().available).toBe(true);
    await db.insert('notes', { _id: 'n1', text: '欢迎使用数据库引擎' });
    await db.createIndex('notes', 'text', 'inverted');
    const hit = await db.query({
      collection: 'notes',
      filter: { text: { $contains: '数据库' } },
    });
    expect(hit.map((row) => row._id)).toEqual(['n1']);
    await db.close();

    const plainPath = await tmpDir();
    const plain = await open({ storagePath: plainPath });
    await plain.insert('notes', { _id: 'n1', text: '欢迎使用数据库引擎' });
    await plain.createIndex('notes', 'text', 'inverted');
    const miss = await plain.query({
      collection: 'notes',
      filter: { text: { $contains: '数据库' } },
    });
    expect(miss).toEqual([]);
    await plain.close();
  });
});

describe('v2.3.0 CLI', () => {
  it('FT-V23-CLI-01 index compact and geo create run without a TTY', async () => {
    const storagePath = await tmpDir();
    expect((await cli(['init', '-p', storagePath, '--json'])).code).toBe(0);
    expect(
      (
        await cli([
          'insert',
          'places',
          '--data',
          '{"_id":"in","loc":{"lat":1,"lon":2}}',
          '-p',
          storagePath,
          '--json',
        ])
      ).code,
    ).toBe(0);
    const geo = await cli([
      'index',
      'create',
      'places',
      'loc',
      '--type',
      'geo',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(geo.code).toBe(0);
    expect(JSON.parse(geo.stdout).index.type).toBe('geo');
    const compacted = await cli(['index', 'compact', 'places', '-p', storagePath, '--json']);
    expect(compacted.code).toBe(0);
    expect(JSON.parse(compacted.stdout).action).toBe('index.compact');
  });

  it('FT-V23-CLI-02 2.2 commands remain and plugin list/info work', async () => {
    const help = helpRoot();
    for (const token of ['insert', 'backup', 'doctor', 'migrate', 'config', 'index']) {
      expect(help).toContain(token);
    }
    expect(helpIndex()).toContain('index rebuild');
    expect(helpIndex()).toContain('index compact');
    const backup = await cli(['backup', '--help']);
    expect(backup.code).toBe(0);
    expect(backup.stdout).toMatch(/differential/);

    const list = await cli(['plugin', 'list', '--json']);
    expect(list.code).toBe(0);
    const listed = JSON.parse(list.stdout) as {
      plugins: { name: string; stub: boolean; availableIn: string }[];
    };
    const names = listed.plugins.map((plugin) => plugin.name).sort();
    expect(names).toEqual(['s3', 'vector']);
    expect(listed.plugins.find((plugin) => plugin.name === 'vector')?.availableIn).toBe('3.3');
    expect(listed.plugins.find((plugin) => plugin.name === 's3')?.availableIn).toBe('3.1');

    const info = await cli(['plugin', 'info', 'vector', '--json']);
    expect(info.code).toBe(0);
    expect(JSON.parse(info.stdout).plugin.stub).toBe(true);

    const ver = await cli(['version', '--json']);
    const body = JSON.parse(ver.stdout) as { version: string; lts: boolean; ltsLine: string };
    expect(body.version).toBe('2.3.0');
    expect(body.lts).toBe(false);
    expect(body.ltsLine).toBe('2.2');
  });
});
