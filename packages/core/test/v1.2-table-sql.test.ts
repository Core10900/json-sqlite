import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  create,
  getVersion,
  open,
  parseSql,
} from '../src/index.js';

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v12-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v1.2.0 tables + SQL', () => {
  it('FT-V12-VER-01 getVersion is 1.2.0', () => {
    expect(getVersion()).toBe('1.2.0');
  });

  it('FT-V12-TBL-01 createTable + listTables with fields', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.createTable('users', {
      fields: [
        { name: 'name', type: 'string' },
        { name: 'age', type: 'number' },
      ],
    });
    const tables = await db.listTables();
    expect(tables.map((t) => t.name)).toContain('users');
    const desc = await db.describeTable('users');
    expect(desc.fields?.map((f) => f.name)).toEqual(['name', 'age']);
    await db.close();
  });

  it('FT-V12-TBL-02 dropTable removes catalog and files', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.createTable('tmp');
    await db.insert('tmp', { x: 1 });
    await db.dropTable('tmp');
    await expect(db.describeTable('tmp')).rejects.toMatchObject({
      code: ErrorCode.COLLECTION_NOT_FOUND,
    });
    await expect(
      fs.access(path.join(storagePath, 'collections', 'tmp')),
    ).rejects.toBeTruthy();
    await db.close();
  });

  it('FT-V12-TBL-03 alterTable rename / add / drop field', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.createTable('users', {
      fields: [{ name: 'name', type: 'string' }],
    });
    await db.insert('users', { name: '寒' });
    await db.alterTable('users', {
      addFields: [{ name: 'age', type: 'number' }],
    });
    expect((await db.describeTable('users')).fields?.map((f) => f.name)).toEqual([
      'name',
      'age',
    ]);
    await db.alterTable('users', { dropFields: ['age'] });
    expect((await db.describeTable('users')).fields?.map((f) => f.name)).toEqual([
      'name',
    ]);
    await db.alterTable('users', { renameTo: 'people' });
    const rows = await db.query({ collection: 'people' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('寒');
    await db.close();
  });

  it('FT-V12-SHOW-01 count + pagination', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.createTable('items');
    for (let i = 0; i < 25; i++) {
      await db.insert('items', { n: i });
    }
    expect(await db.count('items')).toBe(25);
    const page = await db.query({
      collection: 'items',
      orderBy: { n: 'asc' },
      limit: 10,
      offset: 10,
    });
    expect(page).toHaveLength(10);
    expect(page[0]?.n).toBe(10);
    await db.close();
  });

  it('FT-V12-SQL-01 SELECT WHERE ORDER LIMIT', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.createTable('users');
    await db.insert('users', { name: 'a', age: 10 });
    await db.insert('users', { name: 'b', age: 30 });
    await db.insert('users', { name: 'c', age: 20 });
    const r = await db.run(
      'SELECT name, age FROM users WHERE age > 15 ORDER BY age DESC LIMIT 2',
    );
    expect(r.type).toBe('rows');
    if (r.type === 'rows') {
      expect(r.rowCount).toBe(2);
      expect(r.rows[0]?.name).toBe('b');
      expect(r.rows[1]?.name).toBe('c');
    }
    await db.close();
  });

  it('FT-V12-SQL-02 INSERT UPDATE DELETE', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.run('CREATE TABLE users (name string, age number)');
    await db.run("INSERT INTO users (name, age) VALUES ('寒', 30)");
    await db.run("UPDATE users SET age = 31 WHERE name = '寒'");
    const rows = await db.query({ collection: 'users' });
    expect(rows[0]?.age).toBe(31);
    await db.run("DELETE FROM users WHERE name = '寒'");
    expect(await db.count('users')).toBe(0);
    await db.close();
  });

  it('FT-V12-SQL-03 CREATE DROP ALTER SHOW DESCRIBE', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.run('CREATE TABLE t1 (a string)');
    let show = await db.run('SHOW TABLES');
    expect(show.type).toBe('tables');
    if (show.type === 'tables') {
      expect(show.tables.map((t) => t.name)).toContain('t1');
    }
    const desc = await db.run('DESCRIBE t1');
    expect(desc.type).toBe('schema');
    await db.run('ALTER TABLE t1 ADD COLUMN b number');
    await db.run('ALTER TABLE t1 RENAME TO t2');
    await db.run('DROP TABLE t2');
    show = await db.run('SHOW TABLES');
    if (show.type === 'tables') {
      expect(show.tables.map((t) => t.name)).not.toContain('t2');
    }
    await db.close();
  });

  it('FT-V12-SQL-04 illegal SQL', () => {
    expect(() => parseSql('JOIN foo')).toThrow();
    expect(() => parseSql('')).toThrow();
  });

  it('FT-V12-CLI-01/02 run + tables', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.createTable('users');
    await db.insert('users', { name: 'x' });
    await db.close();

    const root = path.join(__dirname, '..');
    const cli = path.join(root, 'dist/cli.js');
    try {
      await fs.access(cli);
    } catch {
      const build = spawnSync('pnpm', ['run', 'build'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(build.status).toBe(0);
    }

    const tables = spawnSync(
      process.execPath,
      [cli, 'tables', '--path', storagePath],
      { encoding: 'utf8' },
    );
    expect(tables.status).toBe(0);
    expect(tables.stdout).toContain('users');

    const run = spawnSync(
      process.execPath,
      [cli, 'run', 'SELECT name FROM users', '--path', storagePath],
      { encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('x');
  });
});
