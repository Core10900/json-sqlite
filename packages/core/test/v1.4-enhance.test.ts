import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ErrorCode,
  JSONSQLiteError,
  getVersion,
  open,
} from '../src/index.js';
import { docsFile } from '../src/utils/path.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v14-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v1.4.0 security / encryption', () => {
  it('FT-V14-SEC-01 encrypted round-trip', async () => {
    const storagePath = await tmpDir();
    const key = 'test-secret-key-1';
    const db = await open({ storagePath, encryptionKey: key });
    await db.insert('users', { name: '寒', secret: 'top' });
    await db.close();

    const db2 = await open({ storagePath, encryptionKey: key });
    const rows = await db2.query({ collection: 'users' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('寒');
    expect(rows[0]?.secret).toBe('top');
    await db2.close();
  });

  it('FT-V14-SEC-02 open without key fails', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, encryptionKey: 'k1' });
    await db.insert('users', { name: 'x' });
    await db.close();

    await expect(open({ storagePath })).rejects.toMatchObject({
      code: ErrorCode.ENCRYPTION,
    });
  });

  it('FT-V14-SEC-03 wrong key fails', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, encryptionKey: 'correct' });
    await db.insert('users', { name: 'x' });
    await db.close();

    await expect(
      open({ storagePath, encryptionKey: 'wrong-key' }),
    ).rejects.toMatchObject({ code: ErrorCode.ENCRYPTION });
  });

  it('FT-V14-SEC-04 plaintext compatible', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const doc = (await db.insert('users', { name: 'plain' })) as {
      _id: string;
    };
    await db.update('users', doc._id, { name: 'plain2' });
    const rows = await db.query({ collection: 'users' });
    expect(rows[0]?.name).toBe('plain2');
    await db.close();

    const db2 = await open({ storagePath });
    expect((await db2.query({ collection: 'users' }))[0]?.name).toBe('plain2');
    await db2.close();
  });

  it('FT-V14-SEC-05 disk is not plaintext', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, encryptionKey: 'disk-key' });
    await db.insert('users', { name: 'VISIBLE_PLAINTEXT_MARKER', pin: '9999' });
    await db.close();

    const raw = await fs.readFile(docsFile(storagePath, 'users'), 'utf8');
    expect(raw).not.toContain('VISIBLE_PLAINTEXT_MARKER');
    expect(raw).not.toContain('9999');
    expect(raw).toContain('JSQE1:');
  });

  it('FT-V14-SEC-06 encrypted backup round-trip', async () => {
    const storagePath = await tmpDir();
    const key = 'backup-key';
    const db = await open({ storagePath, encryptionKey: key });
    await db.insert('users', { name: 'bak' });
    const info = await db.backupFull();
    const id = (await db.query({ collection: 'users' }))[0]!._id;
    await db.delete('users', id);
    expect(await db.query({ collection: 'users' })).toHaveLength(0);
    await db.restoreBackup(info.file);
    expect((await db.query({ collection: 'users' }))[0]?.name).toBe('bak');
    await db.close();
  });
});

describe('v1.4.0 SQL LIKE', () => {
  it('FT-V14-LIKE-01/02/03/05 wildcard matching', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', [
      { name: '寒猫' },
      { name: '大猫' },
      { name: 'abc' },
      { name: 'zzz' },
    ]);

    const prefix = await db.run(`SELECT * FROM users WHERE name LIKE '寒%'`);
    expect(prefix.type).toBe('rows');
    if (prefix.type === 'rows') {
      expect(prefix.rows.map((r) => r.name)).toEqual(['寒猫']);
    }

    const suffix = await db.run(`SELECT * FROM users WHERE name LIKE '%猫'`);
    if (suffix.type === 'rows') {
      expect(suffix.rows.map((r) => r.name).sort()).toEqual(['大猫', '寒猫']);
    }

    const single = await db.run(`SELECT * FROM users WHERE name LIKE '_b_'`);
    if (single.type === 'rows') {
      expect(single.rows.map((r) => r.name)).toEqual(['abc']);
    }

    const contains = await db.run(`SELECT * FROM users WHERE name LIKE '%猫%'`);
    if (contains.type === 'rows') {
      expect(contains.rows).toHaveLength(2);
    }
    await db.close();
  });

  it('FT-V14-LIKE-04 backslash escape', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { name: '100%' });
    await db.insert('users', { name: '100x' });
    const r = await db.run(`SELECT * FROM users WHERE name LIKE '100\\%'`);
    if (r.type === 'rows') {
      expect(r.rows.map((row) => row.name)).toEqual(['100%']);
    }
    await db.close();
  });
});

describe('v1.4.0 SQL JOIN', () => {
  async function seedJoin(storagePath: string) {
    const db = await open({ storagePath });
    const u1 = (await db.insert('users', { name: '寒' })) as { _id: string };
    const u2 = (await db.insert('users', { name: '猫' })) as { _id: string };
    await db.insert('orders', { userId: u1._id, total: 150 });
    await db.insert('orders', { userId: u1._id, total: 50 });
    await db.insert('orders', { userId: u2._id, total: 200 });
    return { db, u1, u2 };
  }

  it('FT-V14-JOIN-01 INNER JOIN', async () => {
    const { db, u1 } = await seedJoin(await tmpDir());
    const r = await db.run(
      `SELECT u.name, o.total FROM users u INNER JOIN orders o ON u._id = o.userId WHERE o.total > 100`,
    );
    expect(r.type).toBe('rows');
    if (r.type === 'rows') {
      expect(r.rows.length).toBeGreaterThanOrEqual(2);
      expect(r.columns).toEqual(['u.name', 'o.total']);
      for (const row of r.rows) {
        expect(row['o.total']).toBeGreaterThan(100);
      }
    }
    void u1;
    await db.close();
  });

  it('FT-V14-JOIN-02 LEFT JOIN keeps left rows', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { name: 'lonely' });
    await db.insert('users', { name: 'with-order' });
    const withOrder = (
      await db.query({ collection: 'users', filter: { name: 'with-order' } })
    )[0]!;
    await db.insert('orders', { userId: withOrder._id, total: 10 });

    const r = await db.run(
      `SELECT u.name, o.total FROM users u LEFT JOIN orders o ON u._id = o.userId`,
    );
    if (r.type === 'rows') {
      expect(r.rows.length).toBe(2);
      const lonely = r.rows.find((row) => row['u.name'] === 'lonely');
      expect(lonely?.['o.total'] ?? null).toBeNull();
    }
    await db.close();
  });

  it('FT-V14-JOIN-03 JOIN + ORDER + LIMIT', async () => {
    const { db } = await seedJoin(await tmpDir());
    const r = await db.run(
      `SELECT u.name, o.total FROM users u INNER JOIN orders o ON u._id = o.userId ORDER BY o.total DESC LIMIT 2`,
    );
    if (r.type === 'rows') {
      expect(r.rowCount).toBe(2);
      expect(r.rows[0]?.['o.total']).toBe(200);
      expect(r.total).toBe(3);
    }
    await db.close();
  });

  it('FT-V14-JOIN-04 unsupported multi-join / no ON', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await expect(
      db.run(`SELECT * FROM users JOIN orders`),
    ).rejects.toBeInstanceOf(JSONSQLiteError);

    await expect(
      db.run(
        `SELECT * FROM a JOIN b ON a.id = b.id JOIN c ON a.id = c.id`,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.SQL_UNSUPPORTED });
    await db.close();
  });

  it('FT-V14-JOIN-05 column prefix strategy', async () => {
    const { db } = await seedJoin(await tmpDir());
    const r = await db.run(
      `SELECT * FROM users u INNER JOIN orders o ON u._id = o.userId LIMIT 1`,
    );
    if (r.type === 'rows') {
      const row = r.rows[0]!;
      expect(row).toHaveProperty('u.name');
      expect(row).toHaveProperty('o.total');
      expect(row).toHaveProperty('u._id');
    }
    await db.close();
  });
});

describe('v1.4.0 export / import / cursor', () => {
  it('FT-V14-IO-01/02/03 export import modes', async () => {
    const db = await open({ storagePath: await tmpDir() });
    const a = (await db.insert('users', { name: 'a' })) as { _id: string };
    await db.insert('users', { name: 'b' });

    const exported = await db.exportCollection('users');
    expect(exported).toHaveLength(2);

    await db.importCollection(
      'users',
      [{ _id: a._id, name: 'a2' }, { name: 'c' }],
      { mode: 'append' },
    );
    expect(await db.count('users')).toBe(3);
    expect(
      (await db.findById('users', a._id))?.name,
    ).toBe('a2');

    await db.importCollection(
      'users',
      [{ name: 'only' }],
      { mode: 'replace' },
    );
    expect(await db.count('users')).toBe(1);
    expect((await db.query({ collection: 'users' }))[0]?.name).toBe('only');
    await db.close();
  });

  it('FT-V14-CUR-01/02 queryCursor paging', async () => {
    const db = await open({ storagePath: await tmpDir() });
    for (let i = 0; i < 5; i++) {
      await db.insert('users', { name: `u${i}`, age: i });
    }

    const page1 = await db.queryCursor({
      collection: 'users',
      orderBy: { age: 'asc', _id: 'asc' },
      limit: 2,
    });
    expect(page1.docs).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await db.queryCursor({
      collection: 'users',
      orderBy: { age: 'asc', _id: 'asc' },
      cursor: page1.nextCursor,
      limit: 2,
    });
    expect(page2.docs).toHaveLength(2);
    const ids = [...page1.docs, ...page2.docs].map((d) => d._id);
    expect(new Set(ids).size).toBe(4);

    const page3 = await db.queryCursor({
      collection: 'users',
      orderBy: { age: 'asc', _id: 'asc' },
      cursor: page2.nextCursor,
      limit: 2,
    });
    expect(page3.docs).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const byId = await db.queryCursor({
      collection: 'users',
      limit: 2,
    });
    expect(byId.docs).toHaveLength(2);
    expect(byId.nextCursor).toBeTruthy();
    await db.close();
  });
});

describe('v1.4.0 admin / CLI / version', () => {
  it('FT-V14-ADM-01 non-loopback without token rejected', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await expect(
      db.startServer({ host: '0.0.0.0', port: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_CONFIG });
    await db.close();
  });

  it('FT-V14-ADM-02 loopback without token warns', async () => {
    const db = await open({ storagePath: await tmpDir() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = await db.startServer({ host: '127.0.0.1', port: 0 });
    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0]?.[0] ?? '');
    expect(msg).toMatch(/adminToken|loopback/i);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    warn.mockRestore();
    await db.close();
  });

  it('FT-V14-CLI-01 table export/import', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { name: 'cli' });
    await db.close();

    const file = path.join(storagePath, 'out.jsonl');
    await execFileAsync(process.execPath, [
      cliJs,
      'table',
      'export',
      'users',
      '--file',
      file,
      '--path',
      storagePath,
    ]);

    const storagePath2 = await tmpDir();
    await execFileAsync(process.execPath, [
      cliJs,
      'table',
      'import',
      'users',
      '--file',
      file,
      '--mode',
      'replace',
      '--path',
      storagePath2,
    ]);

    const db2 = await open({ storagePath: storagePath2 });
    expect(await db2.count('users')).toBe(1);
    expect((await db2.query({ collection: 'users' }))[0]?.name).toBe('cli');
    await db2.close();
  });

  it('FT-V14-VER-01 getVersion matches package', async () => {
    const pkg = JSON.parse(
      await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(getVersion()).toBe(pkg.version);
  });
});

describe('v1.4.0 regression smoke', () => {
  it('FT-V14-REG-01 basic SQL + tables still work', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.run(`CREATE TABLE items (name string, qty number)`);
    await db.run(`INSERT INTO items (name, qty) VALUES ('a', 1)`);
    const r = await db.run(`SELECT * FROM items WHERE qty >= 1`);
    expect(r.type).toBe('rows');
    if (r.type === 'rows') expect(r.rowCount).toBe(1);
    await db.close();
  });
});
