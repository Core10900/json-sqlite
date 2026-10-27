import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  autoSelectIndexType,
  create,
  getCompatibilityInfo,
  getVersion,
  open,
  StreamProcessor,
} from '../src/index.js';
import { helpRoot, helpAdmin } from '../src/cli/help.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');
const repoRoot = path.resolve(__dirname, '../../..');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v17-'));
  dirs.push(dir);
  return dir;
}

async function cli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliJs, ...args],
      { timeout: 15_000 },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as {
      code?: number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (e.killed) throw new Error(`CLI hung/timeout: ${args.join(' ')}`);
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

function httpGet(
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(
  port: number,
  pathname: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v1.7 Admin / SSE', () => {
  it('FT-V17-ADM-01/03 dashboard + metrics/health', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { name: 'a', age: 1 });
    const server = await db.startServer({ host: '127.0.0.1', port: 0 });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const html = await httpGet(port, '/admin');
    expect(html.status).toBe(200);
    expect(html.body).toContain('JSONSQLite Admin');

    const metrics = await httpGet(port, '/admin/metrics');
    expect(metrics.status).toBe(200);
    const m = JSON.parse(metrics.body);
    expect(m).toHaveProperty('queriesTotal');
    expect(m).toHaveProperty('writesTotal');

    const health = await httpGet(port, '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).status).toBe('healthy');

    await db.close();
  });

  it('FT-V17-ADM-02 non-loopback without token rejected', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await expect(
      db.startServer({ host: '0.0.0.0', port: 0 }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/adminToken/i) });
    await db.close();
  });

  it('FT-V17-ADM-04/05 advise + backup API', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { name: 'x', age: 20 });
    const server = await db.startServer({ host: '127.0.0.1', port: 0 });
    const port = (server.address() as { port: number }).port;

    const advise = await httpPost(port, '/admin/advise', {
      collection: 'users',
      filter: { age: { $gte: 18 } },
    });
    expect(advise.status).toBe(200);
    expect(JSON.parse(advise.body).advice).toBeTruthy();

    const profile = await httpPost(port, '/admin/profile', {
      planMs: 1,
      executeMs: 2,
    });
    expect(JSON.parse(profile.body).totalMs).toBe(3);

    const backup = await httpPost(port, '/admin/backup', {});
    expect(backup.status).toBe(200);
    expect(JSON.parse(backup.body).backup.file).toBeTruthy();

    await db.close();
  });

  it('FT-V17-WS-01/02 SSE dataChanged + auth reject', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const token = 'secret-token';
    const server = await db.startServer({
      host: '127.0.0.1',
      port: 0,
      adminToken: token,
    });
    const port = (server.address() as { port: number }).port;

    const denied = await httpGet(port, '/admin/events');
    expect(denied.status).toBe(401);

    const got = await new Promise<{ event: string; data: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: `/admin/events?token=${token}`,
            method: 'GET',
            headers: { Accept: 'text/event-stream' },
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            let buf = '';
            res.on('data', (c) => {
              buf += c.toString();
              const m = buf.match(/event: dataChanged\ndata: (.+)\n/);
              if (m) {
                resolve({ event: 'dataChanged', data: m[1]! });
                req.destroy();
              }
            });
          },
        );
        req.on('error', reject);
        req.end();
        setTimeout(async () => {
          await db.insert('t', { v: 1 });
        }, 50);
        setTimeout(() => reject(new Error('SSE timeout')), 5000);
      },
    );
    expect(got.event).toBe('dataChanged');
    expect(JSON.parse(got.data).op).toBe('insert');
    await db.close();
  });
});

describe('v1.7 Stream / AutoTune', () => {
  it('FT-V17-STR-01/02 sliding window', async () => {
    const db = await open({ storagePath: await tmpDir() });
    const sp = new StreamProcessor(db);
    const win = sp.slidingWindow({ collection: 'orders', windowMs: 60_000, op: 'count' });
    expect(win.getSnapshot().count).toBe(0);
    await db.insert('orders', { n: 1 });
    await db.insert('orders', { n: 2 });
    await db.insert('other', { n: 3 });
    expect(win.getSnapshot().count).toBe(2);
    expect(win.getSnapshot().value).toBe(2);
    win.stop();
    await db.close();
  });

  it('FT-V17-TUN-01/02/03 AutoTune default off + dry-run + on', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, autoTune: false });
    await db.insert('users', { age: 1 });
    for (let i = 0; i < 3; i++) {
      await db.query({ collection: 'users', filter: { age: 1 } });
    }
    expect(await db.listIndexes()).toHaveLength(0);
    expect(db.getAutoTuneAudit()).toHaveLength(0);

    db.setAutoTune({ enabled: true, dryRun: true });
    const dry = await db.runAutoTune({
      collection: 'users',
      filter: { age: 1 },
    });
    expect(dry.some((e) => e.action === 'recommend')).toBe(true);
    expect(await db.listIndexes()).toHaveLength(0);

    db.setAutoTune({ enabled: true, dryRun: false });
    const created = await db.runAutoTune({
      collection: 'users',
      filter: { age: 1 },
    });
    expect(created.some((e) => e.action === 'create')).toBe(true);
    expect((await db.listIndexes()).length).toBeGreaterThan(0);
    await db.close();
  });
});

describe('v1.7 Index / Aggregate', () => {
  it('FT-V17-IDX-01/02 composite + write consistency', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('u', { city: 'BJ', role: 'admin', n: 1 });
    await db.insert('u', { city: 'BJ', role: 'user', n: 2 });
    await db.insert('u', { city: 'SH', role: 'admin', n: 3 });
    const meta = await db.createIndex('u', 'city+role', 'composite', {
      fields: ['city', 'role'],
    });
    expect(meta.type).toBe('composite');
    expect(meta.fields).toEqual(['city', 'role']);

    const rows = await db.query({
      collection: 'u',
      filter: { city: 'BJ', role: 'admin' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.n).toBe(1);

    const id = rows[0]!._id;
    await db.update('u', id, { role: 'user' });
    const after = await db.query({
      collection: 'u',
      filter: { city: 'BJ', role: 'admin' },
    });
    expect(after).toHaveLength(0);

    await db.delete('u', (await db.query({ collection: 'u', filter: { n: 2 } }))[0]!._id);
    const left = await db.query({
      collection: 'u',
      filter: { city: 'BJ', role: 'user' },
    });
    expect(left).toHaveLength(1);
    expect(left[0]!.n).toBe(1);
    await db.close();
  });

  it('FT-V17-IDX-03 autoSelect', () => {
    expect(autoSelectIndexType({ fieldCount: 2 })).toBe('composite');
    expect(autoSelectIndexType({ cardinalityRatio: 0.01 })).toBe('object');
    expect(autoSelectIndexType({ numericRatio: 0.95 })).toBe('tree');
    expect(autoSelectIndexType({ avgStringLength: 80 })).toBe('inverted');
  });

  it('FT-V17-AGG-01/02 unwind + lookup', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('orders', { tags: ['a', 'b'], userId: 'u1' });
    await db.insert('orders', { tags: [], userId: 'u2' });
    await db.insert('users', { _id: 'u1', name: 'Ann' });
    await db.insert('users', { _id: 'u2', name: 'Bob' });

    const unwound = await db.aggregate('orders', [
      { type: 'unwind', path: 'tags' },
    ]);
    expect(unwound).toHaveLength(2);

    const empty = await db.aggregate('orders', [
      { type: 'match', filter: { userId: 'u2' } },
      { type: 'unwind', path: 'tags' },
    ]);
    expect(empty).toHaveLength(0);

    const joined = (await db.aggregate('orders', [
      {
        type: 'lookup',
        from: 'users',
        localField: 'userId',
        foreignField: '_id',
        as: 'user',
      },
    ])) as Array<{ user: unknown[] }>;
    expect(joined[0]!.user).toHaveLength(1);
    expect((joined[0]!.user[0] as { name: string }).name).toBe('Ann');
    await db.close();
  });
});

describe('v1.7 CLI / docs / version', () => {
  it('FT-V17-CLI-01 admin serve --help', async () => {
    const r = await cli(['admin', 'serve', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/host/i);
    expect(r.stdout).toMatch(/port/i);
    expect(helpAdmin()).toMatch(/host/i);
  });

  it('FT-V17-CLI-02 advise / compat / version --json', async () => {
    const storagePath = await tmpDir();
    await cli(['init', '-p', storagePath]);
    await cli([
      'table',
      'create',
      '--name',
      'u',
      '--field',
      'age:number',
      '-p',
      storagePath,
    ]);
    const advise = await cli([
      'advise',
      '{"collection":"u","filter":{"age":1}}',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(advise.code).toBe(0);
    expect(JSON.parse(advise.stdout).action).toBe('advise');

    const compat = await cli(['compat', '--json']);
    expect(compat.code).toBe(0);
    const compatBody = JSON.parse(compat.stdout) as {
      version: string;
      cliSurface: string;
      lts: boolean;
    };
    expect(compatBody.lts).toBe(false);
    if (compatBody.version.startsWith('1.7.')) {
      expect(compatBody.cliSurface).toBe('1.7.0');
    }

    const ver = await cli(['version', '--json']);
    expect(ver.code).toBe(0);
    expect(JSON.parse(ver.stdout).version).toBe(getVersion());
  });

  it('FT-V17-CLI-03 composite index create', async () => {
    const storagePath = await tmpDir();
    await cli(['init', '-p', storagePath]);
    await cli([
      'table',
      'create',
      '--name',
      'u',
      '--field',
      'a:string',
      '--field',
      'b:string',
      '-p',
      storagePath,
    ]);
    await cli([
      'insert',
      'u',
      '--data',
      '{"a":"1","b":"2"}',
      '-p',
      storagePath,
    ]);
    const r = await cli([
      'index',
      'create',
      'u',
      '--type',
      'composite',
      '--fields',
      'a,b',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).index.type).toBe('composite');
  });

  it('FT-V17-CLI-04 aggregate pipeline', async () => {
    const storagePath = await tmpDir();
    await cli(['init', '-p', storagePath]);
    await cli(['table', 'create', '--name', 'o', '-p', storagePath]);
    await cli([
      'insert',
      'o',
      '--data',
      '{"tags":["x","y"]}',
      '-p',
      storagePath,
    ]);
    const r = await cli([
      'aggregate',
      'o',
      '[{"type":"unwind","path":"tags"}]',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).rows).toHaveLength(2);
  });

  it('FT-V17-DOC-01/02 API + CLI-API 1.7 supplements', async () => {
    const api = await fs.readFile(path.join(repoRoot, 'API.md'), 'utf8');
    const cliApi = await fs.readFile(path.join(repoRoot, 'CLI-API.md'), 'utf8');
    expect(api).toContain('1.7');
    expect(api).toContain('StreamProcessor');
    expect(api).toContain('autoSelectIndexType');
    expect(api).toContain('unwind');
    expect(cliApi).toContain('1.7');
    expect(cliApi).toContain('admin serve');
    expect(cliApi).toContain('aggregate');
    expect(cliApi).toContain('composite');
    const help = helpRoot().toLowerCase();
    for (const token of ['admin', 'advise', 'aggregate', 'watch', 'compat']) {
      expect(help).toContain(token);
      expect(cliApi.toLowerCase()).toContain(token);
    }
  });

  it('FT-V17-VER-01 version + non-LTS compat', () => {
    const info = getCompatibilityInfo();
    expect(info.lts).toBe(false);
    expect(info.version).toBe(getVersion());
    if (info.version.startsWith('1.7.')) {
      expect(info.cliSurface).toBe('1.7.0');
    }
    expect(info.features).toContain('composite-index');
    expect(info.features).toContain('admin-sse');
  });
});
