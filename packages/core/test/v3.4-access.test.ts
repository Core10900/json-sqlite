import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  createConnectionPool,
  createDatabaseRegistry,
  createVectorPlugin,
  executeGraphQL,
  open,
} from '../src/index.js';
import { validateConfig } from '../src/config/validate.js';
import type { Advice } from '../src/features/QueryAdvisor.js';

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsql-v34-access-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function httpJson(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload
            ? { 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json: unknown = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function serverPort(server: http.Server): number {
  const addr = server.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('server has no port');
}

describe('v3.4.0 access layer', () => {
  it('FT-V34-GQL-01 executeGraphQL query documents matches db API', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, graphql: true });
    await db.insert('users', { _id: 'u1', name: 'Ada' });
    await db.insert('users', { _id: 'u2', name: 'Bob' });
    const viaApi = await db.query({ collection: 'users' });
    const gql = await executeGraphQL(
      db,
      'query { documents(collection: "users") { _id name } }',
    );
    expect(gql.errors).toBeUndefined();
    const docs = gql.data?.documents as Array<{ _id: string; name: string }>;
    expect(docs).toHaveLength(viaApi.length);
    expect(docs.map((d) => d._id).sort()).toEqual(
      viaApi.map((d) => d._id).sort(),
    );
    expect(docs.find((d) => d._id === 'u1')?.name).toBe('Ada');
    await db.close();
  });

  it('FT-V34-GQL-02 executeGraphQL mutation insert matches db API', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, graphql: true });
    const gql = await executeGraphQL(
      db,
      'mutation { insert(collection: "users", data: "{\\"_id\\":\\"g1\\",\\"name\\":\\"Grace\\"}") { _id name } }',
    );
    expect(gql.errors).toBeUndefined();
    expect(gql.data?.insert).toMatchObject({ _id: 'g1', name: 'Grace' });
    expect((await db.findById('users', 'g1'))?.name).toBe('Grace');
    await db.close();
  });

  it('FT-V34-POOL-01 createConnectionPool borrow/release/close; borrow after close → POOL_CLOSED', async () => {
    const storagePath = await tmpDir();
    const pool = createConnectionPool({ storagePath, size: 1 });
    const db = await pool.borrow();
    await db.insert('docs', { _id: 'p1', name: 'pooled' });
    expect((await db.findById('docs', 'p1'))?.name).toBe('pooled');
    pool.release(db);
    await pool.close();
    await expect(pool.borrow()).rejects.toMatchObject({
      code: ErrorCode.POOL_CLOSED,
    });
  });

  it('FT-V34-MDB-01 DatabaseRegistry two paths are isolated', async () => {
    const root = await tmpDir();
    const pathA = path.join(root, 'a');
    const pathB = path.join(root, 'b');
    const registry = await createDatabaseRegistry({
      file: path.join(root, 'registry.json'),
    });
    await registry.register('A', pathA);
    await registry.register('B', pathB);
    const dbA = await registry.use('A');
    const dbB = await registry.use('B');
    await dbA.insert('docs', { _id: 'only-a', name: 'A' });
    expect(await dbB.findById('docs', 'only-a')).toBeNull();
    await dbB.insert('docs', { _id: 'only-b', name: 'B' });
    expect(await dbA.findById('docs', 'only-b')).toBeNull();
    await registry.closeAll();
  });

  it('FT-V34-MDB-02 close A, B still works', async () => {
    const root = await tmpDir();
    const registry = await createDatabaseRegistry({
      file: path.join(root, 'registry.json'),
    });
    await registry.register('A', path.join(root, 'a'));
    await registry.register('B', path.join(root, 'b'));
    const dbA = await registry.use('A');
    const dbB = await registry.use('B');
    await dbB.insert('docs', { _id: 'keep', name: 'alive' });
    await dbA.close({ flush: true });
    expect((await dbB.findById('docs', 'keep'))?.name).toBe('alive');
    await dbB.insert('docs', { _id: 'after', name: 'still' });
    expect((await dbB.findById('docs', 'after'))?.name).toBe('still');
    await registry.closeAll();
  });

  it('FT-V34-FW-01 Express-style CollectionHandle write then read', async () => {
    // apps/examples/express/index.mjs hardcodes ./data — mirror its handle usage.
    const storagePath = await tmpDir();
    const db = await open({ storagePath, graphql: true });
    const users = db.collection('users');
    const doc = await users.insert({ _id: 'e1', name: 'express' });
    expect(doc).toMatchObject({ _id: 'e1', name: 'express' });
    expect((await users.findById('e1'))?.name).toBe('express');
    await db.close();
  });

  it('FT-V34-FW-02 Nest-style module providers write then read', async () => {
    // apps/examples/nest/index.mjs — JsonSqliteModule providers pattern.
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const mod = {
      module: 'JsonSqliteModule',
      providers: {
        JSONSQLITE: db,
        UsersCollection: db.collection('users'),
      },
      async onModuleDestroy() {
        await db.close({ flush: true });
      },
    };
    const users = mod.providers.UsersCollection;
    const doc = await users.insert({ _id: 'n1', name: 'nest' });
    expect(doc).toMatchObject({ _id: 'n1', name: 'nest' });
    expect((await users.findById('n1'))?.name).toBe('nest');
    await mod.onModuleDestroy();
  });

  it('FT-V34-AI-01 advise without provider returns rules', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: '1', age: 30 });
    const advice = await db.advise({
      collection: 'users',
      filter: { age: { $gt: 18 } },
    });
    expect(Array.isArray(advice)).toBe(true);
    expect(advice.length).toBeGreaterThan(0);
    expect(advice.some((a: Advice) => a.type === 'index' || a.type === 'rewrite')).toBe(
      true,
    );
    await db.close();
  });

  it('FT-V34-AI-02 advisorProvider throws — advise still returns rules; query succeeds', async () => {
    const storagePath = await tmpDir();
    const db = await open({
      storagePath,
      advisorProvider: async () => {
        throw new Error('LLM unavailable');
      },
    });
    await db.insert('users', { _id: '1', age: 40 });
    const advice = await db.advise({
      collection: 'users',
      filter: { age: { $gte: 20 } },
    });
    expect(advice.length).toBeGreaterThan(0);
    const rows = await db.query({
      collection: 'users',
      filter: { age: { $gte: 20 } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.age).toBe(40);
    await db.close();
  });

  it('FT-V34-VEC-01 createVectorPlugin upsert + vectorSearch non-empty scored hits', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const vector = createVectorPlugin();
    db.registerPlugin(vector);
    vector.upsertVector('docs', 'v1', [1, 0, 0]);
    vector.upsertVector('docs', 'v2', [0.9, 0.1, 0]);
    const result = (await db.vectorSearch('docs', [1, 0, 0])) as {
      hits: Array<{ id: string; score: number }>;
      stub: boolean;
    };
    expect(result.stub).toBe(false);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]).toMatchObject({
      id: expect.any(String),
      score: expect.any(Number),
    });
    expect(result.hits[0]!.score).toBeGreaterThan(0);
    await db.close();
  });

  it('FT-V34-SRV-01 db.serve and startServer are the same routes', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    // serve is an alias that returns the same http.Server as startServer.
    const viaServe = await db.serve({ host: '127.0.0.1', port: 0 });
    const viaStart = await db.startServer({ host: '127.0.0.1', port: 0 });
    expect(viaStart).toBe(viaServe);
    const port = serverPort(viaServe);
    const health = await httpJson(port, 'GET', '/health');
    expect(health.status).toBe(200);
    expect((health.json as { status: string }).status).toBe('healthy');
    await db.insert('docs', { _id: 's1', name: 'served' });
    const query = await httpJson(port, 'POST', '/query', {
      collection: 'docs',
      filter: { _id: 's1' },
    });
    expect(query.status).toBe(200);
    expect((query.json as { rows: Array<{ name: string }> }).rows[0]?.name).toBe(
      'served',
    );
    await db.close();
  });

  it('FT-V34-API-01 collection insert, table findById reads back', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.collection('items').insert({ _id: 'i1', sku: 'X' });
    expect((await db.table('items').findById('i1'))?.sku).toBe('X');
    await db.close();
  });

  it('FT-V34-REST-01 startServer POST /collections then GET by id', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const server = await db.startServer({ host: '127.0.0.1', port: 0 });
    const port = serverPort(server);
    const created = await httpJson(port, 'POST', '/collections/x', {
      _id: 'r1',
      name: 'rest',
    });
    expect(created.status).toBe(201);
    expect((created.json as { doc: { name: string } }).doc.name).toBe('rest');
    const got = await httpJson(port, 'GET', '/collections/x/r1');
    expect(got.status).toBe(200);
    expect((got.json as { doc: { name: string } }).doc.name).toBe('rest');
    expect((await db.findById('x', 'r1'))?.name).toBe('rest');
    await db.close();
  });

  it('FT-V34-REST-02 DELETE then GET 404; POST /query still works', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const server = await db.startServer({ host: '127.0.0.1', port: 0 });
    const port = serverPort(server);
    await httpJson(port, 'POST', '/collections/x', { _id: 'd1', name: 'gone' });
    const del = await httpJson(port, 'DELETE', '/collections/x/d1');
    expect(del.status).toBe(200);
    const missing = await httpJson(port, 'GET', '/collections/x/d1');
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({
      error: 'DOCUMENT_NOT_FOUND',
      code: ErrorCode.DOCUMENT_NOT_FOUND,
    });
    await db.insert('x', { _id: 'still', name: 'ok' });
    const query = await httpJson(port, 'POST', '/query', {
      collection: 'x',
      filter: { _id: 'still' },
    });
    expect(query.status).toBe(200);
    expect((query.json as { rows: Array<{ name: string }> }).rows[0]?.name).toBe(
      'ok',
    );
    await db.close();
  });

  it('FT-V34-CFG-01 validateConfig accepts graphql:false; rejects cluster:true', () => {
    expect(() =>
      validateConfig({ storagePath: './data', graphql: false }),
    ).not.toThrow();
    expect(() =>
      validateConfig({ storagePath: './data', cluster: true }),
    ).toThrow(/Rejected dangerous config key/);
  });
});
