import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  FORMAT_VERSION,
  create,
  getVersion,
  open,
  parseSql,
} from '../src/index.js';
import { DdlJournal } from '../src/storage/DdlJournal.js';
import { catalogFile } from '../src/utils/path.js';

const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v13-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v1.3.0 harden', () => {
  it('FT-V13-VER version is 1.3.0', () => {
    expect(getVersion()).toBe('1.3.0');
    expect(FORMAT_VERSION).toBe(1);
  });

  it('FT-V13-CAT atomic catalog write', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath, syncMode: 'normal' });
    await db.createTable('a');
    await db.close();
    const raw = await fs.readFile(catalogFile(storagePath), 'utf8');
    expect(JSON.parse(raw).formatVersion).toBe(1);
    expect(JSON.parse(raw).collections.a).toBeTruthy();
  });

  it('FT-V13-DDL drop journal recovery', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.createTable('gone');
    await db.insert('gone', { x: 1 });
    await db.close();

    // Simulate crash after files removed but before catalog drop
    const journal = new DdlJournal(storagePath, 'none');
    await journal.write({ op: 'drop', name: 'gone', phase: 'files_removed' });
    await fs.rm(path.join(storagePath, 'collections', 'gone'), {
      recursive: true,
      force: true,
    });

    const db2 = await open({ storagePath });
    const tables = await db2.listTables();
    expect(tables.map((t) => t.name)).not.toContain('gone');
    await db2.close();
  });

  it('FT-V13-DDL rename journal recovery', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.createTable('old');
    await db.insert('old', { v: 1 });
    await db.close();

    // Manually move files and leave journal as files_moved
    await fs.rename(
      path.join(storagePath, 'collections', 'old'),
      path.join(storagePath, 'collections', 'neu'),
    );
    const journal = new DdlJournal(storagePath, 'none');
    await journal.write({
      op: 'rename',
      from: 'old',
      to: 'neu',
      phase: 'files_moved',
    });

    const db2 = await open({ storagePath });
    const names = (await db2.listTables()).map((t) => t.name);
    expect(names).toContain('neu');
    expect(names).not.toContain('old');
    const rows = await db2.query({ collection: 'neu' });
    expect(rows[0]?.v).toBe(1);
    await db2.close();
  });

  it('FT-V13-SCHEMA strict mode', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({
      storagePath,
      schemaMode: 'strict',
    });
    await db.createTable('users', {
      fields: [
        { name: 'name', type: 'string', required: true },
        { name: 'age', type: 'number' },
      ],
    });
    await expect(db.insert('users', { age: 1 })).rejects.toMatchObject({
      code: ErrorCode.SCHEMA_VIOLATION,
    });
    await db.insert('users', { name: '寒', age: 30 });
    await expect(
      db.insert('users', { name: 'x', age: 'bad' as unknown as number }),
    ).rejects.toMatchObject({ code: ErrorCode.SCHEMA_VIOLATION });
    await db.close();
  });

  it('FT-V13-SQL IN / BETWEEN / IS NULL', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.createTable('t');
    await db.insert('t', { name: 'a', age: 10, city: null });
    await db.insert('t', { name: 'b', age: 20 });
    await db.insert('t', { name: 'c', age: 30 });

    const inn = await db.run("SELECT name FROM t WHERE name IN ('a','c')");
    expect(inn.type).toBe('rows');
    if (inn.type === 'rows') expect(inn.rowCount).toBe(2);

    const bet = await db.run('SELECT name FROM t WHERE age BETWEEN 15 AND 25');
    if (bet.type === 'rows') {
      expect(bet.rowCount).toBe(1);
      expect(bet.rows[0]?.name).toBe('b');
    }

    const nul = await db.run('SELECT name FROM t WHERE city IS NULL');
    if (nul.type === 'rows') expect(nul.rowCount).toBeGreaterThanOrEqual(1);

    expect(() => parseSql('SELECT * FROM t WHERE age IN (1,2)')).not.toThrow();
    await db.close();
  });

  it('FT-V13-ISO coerce unsupported isolation', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
    const db = await open({ storagePath });
    const id = await db.beginTransaction('SERIALIZABLE');
    expect(typeof id).toBe('number');
    await db.rollbackTransaction(id);
    await db.close();
  });

  it('FT-V13-CLI noninteractive create + drop --yes', async () => {
    const storagePath = path.join(await tmpDir(), 'db');
    await create({ storagePath });
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

    const createR = spawnSync(
      process.execPath,
      [
        cli,
        'table',
        'create',
        '--name',
        'cli_t',
        '--field',
        'n:string',
        '--path',
        storagePath,
      ],
      { encoding: 'utf8' },
    );
    expect(createR.status).toBe(0);
    expect(createR.stdout).toContain('cli_t');

    const dropR = spawnSync(
      process.execPath,
      [cli, 'table', 'drop', 'cli_t', '--yes', '--path', storagePath],
      { encoding: 'utf8' },
    );
    expect(dropR.status).toBe(0);
  });
});
