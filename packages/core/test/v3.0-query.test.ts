import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { helpRoot } from '../src/cli/help.js';
import { ErrorCode, JSONSQLiteError, getCompatibilityInfo, getVersion, open, parseSql } from '../src/index.js';
import {
  compileUserSource,
  lastCompiledSource,
  whitelistCompilations,
} from '../src/query/compile.js';
import { jsonPathTree } from '../src/query/JsonPath.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v30-'));
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

describe('v3.0.0 query engine', () => {
  it('FT-V30-VER-01 version is 3.0.0 and not LTS', () => {
    const info = getCompatibilityInfo();
    expect(info.lts).toBe(false);
    expect(info.version).toBe(getVersion());
    if (getVersion().startsWith('3.0.')) {
      expect(getVersion()).toBe('3.0.0');
    }
    expect(info.writers).toBe('single');
    expect(info.features).not.toEqual(expect.arrayContaining(['cluster', 'replica']));
  });

  it('FT-V30-JP-01 filter matches the JSON filter id set', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { _id: 'a', name: 'ann', age: 17 });
    await db.insert('users', { _id: 'b', name: 'bo', age: 21 });
    await db.insert('users', { _id: 'c', name: 'cy', age: 30, nickname: 'c' });
    const byPath = await db.jsonPath('users', '$[?(@.age>18)]._id');
    const byFilter = await db.query({ collection: 'users', filter: { age: { $gt: 18 } } });
    expect(new Set(byPath as string[])).toEqual(new Set(byFilter.map((row) => row._id)));
    const exists = await db.jsonPath('users', '$[?(@.nickname)]._id');
    const existsFilter = await db.query({
      collection: 'users',
      filter: { nickname: { $exists: true } },
    });
    expect(new Set(exists as string[])).toEqual(new Set(existsFilter.map((row) => row._id)));
    const legacy = await db.query({ collection: 'users', filter: { name: 'ann' } });
    expect(legacy.map((row) => row._id)).toEqual(['a']);
    await db.close();
  });

  it('FT-V30-JP-02 script and recursive descent are rejected', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { _id: 'a', name: 'ann', age: 20 });
    await expect(db.jsonPath('users', '$..name')).rejects.toMatchObject({
      code: ErrorCode.JSONPATH_UNSUPPORTED,
    });
    await expect(db.jsonPath('users', '$.name()')).rejects.toMatchObject({
      code: ErrorCode.JSONPATH_UNSUPPORTED,
    });
    await expect(db.jsonPath('users', '$..name')).rejects.toThrow(/recursive descent/);
    await expect(db.jsonPath('users', '$.name()')).rejects.toThrow(/script/);
    expect((await db.query({ collection: 'users' })).map((row) => row._id)).toEqual(['a']);
    await db.close();
  });

  it('FT-V30-JP-03 the same path reuses one tree', () => {
    const first = jsonPathTree('$[?(@.age>18)].name');
    const second = jsonPathTree('$[?(@.age>18)].name');
    expect(second).toBe(first);
  });

  it('FT-V30-CAN-01 timeout during scan is QUERY_TIMEOUT and not a success array', async () => {
    const db = await open({ storagePath: await tmpDir(), queryTimeout: 30_000 });
    for (let i = 0; i < 8; i++) await db.insert('users', { _id: `u${i}`, age: i });
    await expect(
      db.query({ collection: 'users', filter: { age: { $gte: 0 } } }, { timeout: 10 }),
    ).rejects.toMatchObject({ code: ErrorCode.QUERY_TIMEOUT });
    const again = await db.query(
      { collection: 'users', filter: { age: { $gte: 0 } } },
      { timeout: 0 },
    );
    expect(again).toHaveLength(8);
    await db.close();
  });

  it('FT-V30-CAN-02 AbortSignal cancels the scan and the next query works', async () => {
    const db = await open({ storagePath: await tmpDir() });
    for (let i = 0; i < 6; i++) await db.insert('users', { _id: `u${i}`, age: i });
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads > 1;
      },
      reason: 'stop',
    } as AbortSignal;
    await expect(
      db.query({ collection: 'users' }, { signal }),
    ).rejects.toBeInstanceOf(JSONSQLiteError);
    await expect(db.query({ collection: 'users' }, { signal })).rejects.toMatchObject({
      code: ErrorCode.QUERY_CANCELLED,
    });
    const again = await db.query({ collection: 'users' }, { timeout: 0 });
    expect(again).toHaveLength(6);
    await db.close();
  });

  it('FT-V30-OPT-01 explain names the equality index and a selectivity', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { _id: 'a', city: 'hz', age: 1 });
    await db.insert('users', { _id: 'b', city: 'sh', age: 2 });
    await db.createIndex('users', 'city', 'object');
    const plan = db.explain({ collection: 'users', filter: { city: 'hz' }, limit: 1 });
    expect(plan.usedIndex?.type).toBe('object');
    expect(plan.usedIndex?.field).toBe('city');
    expect(plan.selectivity).toBeGreaterThan(0);
    expect(plan.selectivity).toBeLessThanOrEqual(1);
    expect(typeof plan.indexWeight).toBe('number');
    expect(plan.earlyStop).toBe(true);
    expect(plan.stages).toEqual(['parse', 'optimize', 'indexScan', 'dataLoad', 'execute']);
    await db.close();
  });

  it('FT-V30-OPT-02 constant fold keeps the same documents', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { _id: 'a', age: 10 });
    await db.insert('users', { _id: 'b', age: 30 });
    const folded = await db.run('SELECT * FROM users WHERE 1 = 1 AND age > 18');
    const plain = await db.run('SELECT * FROM users WHERE age > 18');
    expect(folded.type).toBe('rows');
    expect(plain.type).toBe('rows');
    if (folded.type !== 'rows' || plain.type !== 'rows') return;
    expect(ids(folded.rows)).toEqual(ids(plain.rows));
    expect(ids(folded.rows)).toEqual(['b']);
    await db.close();
  });

  it('FT-V30-OPT-03 limit without sort stops early and matches a full filter slice', async () => {
    const db = await open({ storagePath: await tmpDir() });
    for (let i = 0; i < 12; i++) await db.insert('users', { _id: `u${i}`, age: i });
    const limited = await db.query({
      collection: 'users',
      filter: { age: { $gte: 0 } },
      limit: 3,
    });
    const plan = db.lastPlan();
    expect(plan.earlyStop).toBe(true);
    expect(plan.scanned).toBeLessThan(12);
    const full = await db.query({ collection: 'users', filter: { age: { $gte: 0 } } });
    expect(limited.map((row) => row._id)).toEqual(full.slice(0, 3).map((row) => row._id));
    await db.close();
  });

  it('FT-V30-BIND-01 placeholders stay out of the statement text', async () => {
    const sql = 'SELECT * FROM users WHERE name = ?';
    expect(JSON.stringify(parseSql(sql))).not.toContain('secret-value');
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { _id: 'a', name: 'secret-value' });
    await db.insert('users', { _id: 'b', name: 'other' });
    const bound = await db.run(sql, ['secret-value']);
    const literal = await db.run("SELECT * FROM users WHERE name = 'secret-value'");
    expect(bound.type).toBe('rows');
    expect(literal.type).toBe('rows');
    if (bound.type !== 'rows' || literal.type !== 'rows') return;
    expect(ids(bound.rows)).toEqual(ids(literal.rows));
    expect(ids(bound.rows)).toEqual(['a']);
    await db.close();
  });

  it('FT-V30-ADV-01 advise returns a JSONPath and a cost without using the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const db = await open({ storagePath: await tmpDir() });
    const advice = await db.advise({ collection: 'users', filter: { age: { $gt: 18 } } });
    const alt = advice.find((item) => item.jsonPath && item.estimatedCost !== undefined);
    expect(alt?.jsonPath).toBe('$[?(@.age>18)]');
    expect(typeof alt?.estimatedCost).toBe('number');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    await db.close();
  });

  it('FT-V30-CHK-01 chunk on and off return the same ordered documents', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { _id: 'c', name: 'cy', age: 3 });
    await db.insert('users', { _id: 'a', name: 'ann', age: 1 });
    await db.insert('users', { _id: 'b', name: 'bo', age: 2 });
    const query = {
      collection: 'users',
      filter: { age: { $gte: 1 } },
      orderBy: { name: 'asc' as const },
      projection: ['name', 'age'],
    };
    const off = await db.query(query, { chunkSize: 0 });
    const on = await db.query(query, { chunkSize: 1 });
    expect(db.lastPlan().chunked).toBe(true);
    expect(on.map((row) => row.name)).toEqual(off.map((row) => row.name));
    expect(on.map((row) => row.age)).toEqual([1, 2, 3]);
    await db.close();
  });

  it('FT-V30-SQL-01 GROUP BY SUM matches the aggregate pipeline', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('orders', { _id: '1', city: 'hz', amount: 10 });
    await db.insert('orders', { _id: '2', city: 'hz', amount: 15 });
    await db.insert('orders', { _id: '3', city: 'sh', amount: 7 });
    const sql = await db.run('SELECT city, SUM(amount) AS total FROM orders GROUP BY city');
    const piped = (await db.aggregate('orders', [
      { type: 'group', by: 'city', fields: { total: { op: 'sum', field: 'amount' } } },
    ])) as { _id: string; total: number }[];
    expect(sql.type).toBe('rows');
    if (sql.type !== 'rows') return;
    const fromSql = Object.fromEntries(sql.rows.map((row) => [row.city, row.total]));
    const fromPipe = Object.fromEntries(piped.map((row) => [row._id, row.total]));
    expect(fromSql).toEqual(fromPipe);
    expect(fromSql.hz).toBe(25);
    await db.close();
  });

  it('FT-V30-SQL-02 unsupported SQL names the construct', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await expect(
      db.run('SELECT city, SUM(amount) FROM orders GROUP BY city HAVING SUM(amount) > 1'),
    ).rejects.toThrow(/HAVING/);
    try {
      await db.run('SELECT city, COUNT(*) FROM orders GROUP BY city, name');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JSONSQLiteError);
      expect((err as JSONSQLiteError).code).toBe(ErrorCode.SQL_UNSUPPORTED);
      expect((err as JSONSQLiteError).message).toContain('GROUP BY');
    }
    await db.close();
  });

  it('FT-V30-PRF-01 profile has five stages and a memory delta', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { _id: 'a', age: 1 });
    await db.query({ collection: 'users', filter: { age: { $gte: 0 } } });
    const profile = db.lastProfile();
    expect(profile).toEqual(
      expect.objectContaining({
        parseMs: expect.any(Number),
        optimizeMs: expect.any(Number),
        indexScanMs: expect.any(Number),
        dataLoadMs: expect.any(Number),
        executeMs: expect.any(Number),
        memoryDelta: expect.any(Number),
      }),
    );
    await db.close();
  });

  it('FT-V30-JIT-01 the default path does not compile', async () => {
    const before = whitelistCompilations;
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { _id: 'a', age: 3 });
    await db.query({ collection: 'users', filter: { age: { $gt: 1 } } });
    expect(whitelistCompilations).toBe(before);
    await db.close();
  });

  it('FT-V30-JIT-02 compiled filters reject raw strings and do not inline values', async () => {
    expect(() => compileUserSource('return process.exit(1)')).toThrow(JSONSQLiteError);
    try {
      compileUserSource('return process.exit(1)');
    } catch (err) {
      expect((err as JSONSQLiteError).code).toBe(ErrorCode.INVALID_CONFIG);
      expect((err as JSONSQLiteError).message).toMatch(/user source/);
    }
    const db = await open({ storagePath: await tmpDir(), compileFilters: true });
    await db.insert('users', { _id: 'a', name: "'; return 1; //" });
    const rows = await db.query({
      collection: 'users',
      filter: { name: { $eq: "'; return 1; //" } },
    });
    expect(rows.map((row) => row._id)).toEqual(['a']);
    expect(lastCompiledSource).toBeTruthy();
    expect(lastCompiledSource).not.toContain('return 1');
    expect(whitelistCompilations).toBeGreaterThan(0);
    await db.close();
  });

  it('FT-V30-CLI-01 explain --json is parseable and FT-V30-CLI-02 help has no replica or cluster', async () => {
    const help = helpRoot();
    if (getVersion().startsWith('3.0.') || getVersion().startsWith('3.1.') || getVersion().startsWith('3.2.')) {
      expect(help).not.toMatch(/\breplica\b/);
    }
    expect(help).not.toMatch(/\bcluster\b/);
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'a', age: 5 });
    await db.createIndex('users', 'age', 'object');
    await db.close();
    const explained = await cli([
      'explain',
      '{"collection":"users","filter":{"age":5},"limit":1}',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(explained.code).toBe(0);
    const body = JSON.parse(explained.stdout) as {
      selectivity: number;
      earlyStop: boolean;
      stages: string[];
      chunked: boolean;
    };
    expect(typeof body.selectivity).toBe('number');
    expect(body.earlyStop).toBe(true);
    expect(body.chunked).toBe(false);
    expect(body.stages).toContain('indexScan');

    const timed = await cli([
      'query',
      '{"collection":"users"}',
      '--timeout',
      '1',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(timed.code).toBe(1);
    expect(JSON.parse(timed.stdout).code).toBe('QUERY_TIMEOUT');
    const ok = await cli(['query', '{"collection":"users"}', '-p', storagePath, '--json']);
    expect(ok.code).toBe(0);
  });
});
