import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { getVersion, open } from '../src/index.js';
import { helpRoot, helpRootCommandsBlock, helpTable } from '../src/cli/help.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v155-'));
  dirs.push(dir);
  return dir;
}

async function cli(
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliJs, ...args],
      {
        env: { ...process.env, ...opts?.env },
        timeout: 20_000,
      },
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

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v1.5.5 CLI global contract', () => {
  it('FT-V155-G-01 help / --help', async () => {
    const a = await cli(['help']);
    expect(a.code).toBe(0);
    expect(a.stdout).toMatch(/insert|vacuum|doctor|table/);
    const b = await cli(['--help']);
    expect(b.code).toBe(0);
  });

  it('FT-V155-G-02 nested help', async () => {
    const a = await cli(['table', '--help']);
    expect(a.code).toBe(0);
    expect(a.stdout).toMatch(/table create/);
    const b = await cli(['table', 'create', '--help']);
    expect(b.code).toBe(0);
    expect(b.stdout).toMatch(/--name/);
  });

  it('FT-V155-G-03 unknown command', async () => {
    const r = await cli(['nope-cmd']);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/Unknown|未知|help/i);
  });

  it('FT-V155-G-04 -p equals --path', async () => {
    const storagePath = await tmpDir();
    await cli(['init', '--path', storagePath]);
    await cli([
      'table',
      'create',
      '--name',
      't',
      '-p',
      storagePath,
      '--field',
      'a:string',
    ]);
    const r = await cli(['tables', '-p', storagePath, '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
    expect(j.tables.some((t: { name: string }) => t.name === 't')).toBe(true);
  });

  it('FT-V155-G-05/06 --json success and failure', async () => {
    const storagePath = await tmpDir();
    await cli(['init', '-p', storagePath]);
    const ok = await cli(['tables', '-p', storagePath, '--json']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).ok).toBe(true);

    const bad = await cli(['get', 'missing', '--id', 'x', '-p', storagePath, '--json']);
    expect(bad.code).toBe(1);
    const body = JSON.parse(bad.stdout || bad.stderr);
    expect(body.ok).toBe(false);
    expect(body.code).toBeTruthy();
  });

  it('FT-V155-G-07 NO_COLOR', async () => {
    const r = await cli(['help'], { env: { NO_COLOR: '1' } });
    expect(r.stdout).not.toMatch(/\x1b\[/);
  });

  it('FT-V155-G-08 lock exit code 3', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const r = await cli(['tables', '-p', storagePath, '--json']);
    await db.close();
    expect(r.code).toBe(3);
    const body = JSON.parse(r.stdout || r.stderr);
    expect(body.ok).toBe(false);
    expect(body.code).toMatch(/LOCK/i);
  });
});

describe('v1.5.5 TTY guards', () => {
  it('FT-V155-TTY-01 non-TTY table create without flags', async () => {
    const storagePath = await tmpDir();
    const r = await cli(['table', 'create', '-p', storagePath]);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/--name|TTY|终端/);
  });

  it('FT-V155-TTY-02 non-TTY drop without --yes', async () => {
    const storagePath = await tmpDir();
    await cli(['table', 'create', '--name', 't', '-p', storagePath]);
    const r = await cli(['table', 'drop', 't', '-p', storagePath]);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/--yes/);
  });

  it('FT-V155-TTY-03 non-TTY sql REPL', async () => {
    const storagePath = await tmpDir();
    const r = await cli(['sql', '-p', storagePath]);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/run|TTY|REPL/);
  });
});

describe('v1.5.5 existing commands', () => {
  it('FT-V155-OLD-01/02 create init tables json', async () => {
    const storagePath = await tmpDir();
    const c = await cli(['create', storagePath, '--json']);
    expect(JSON.parse(c.stdout).ok).toBe(true);
    const i = await cli(['init', '-p', storagePath, '--json']);
    expect(JSON.parse(i.stdout).ok).toBe(true);
    await cli(['table', 'create', '--name', 'u', '--field', 'n:string', '-p', storagePath]);
    const t = await cli(['tables', '-p', storagePath, '--json']);
    const j = JSON.parse(t.stdout);
    expect(j.tables[0].name).toBe('u');
    expect(j.tables[0].documents).toBe(0);
  });

  it('FT-V155-OLD-03/04 create + drop --yes', async () => {
    const storagePath = await tmpDir();
    await cli(['init', '-p', storagePath]);
    await cli([
      'table',
      'create',
      '--name',
      'u',
      '--field',
      'n:string',
      '-p',
      storagePath,
    ]);
    const d = await cli(['table', 'drop', 'u', '--yes', '-p', storagePath, '--json']);
    expect(d.code).toBe(0);
    const t = await cli(['tables', '-p', storagePath, '--json']);
    expect(JSON.parse(t.stdout).tables).toHaveLength(0);
  });

  it('FT-V155-OLD-05/06 show empty and paged json', async () => {
    const storagePath = await tmpDir();
    await cli(['table', 'create', '--name', 'u', '-p', storagePath]);
    const empty = await cli(['table', 'show', 'u', '-p', storagePath]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toMatch(/空/);

    await cli([
      'insert',
      'u',
      '--data',
      '{"n":1}',
      '-p',
      storagePath,
    ]);
    const show = await cli([
      'table',
      'show',
      'u',
      '--page',
      '1',
      '--size',
      '10',
      '-p',
      storagePath,
      '--json',
    ]);
    const j = JSON.parse(show.stdout);
    expect(j.total).toBe(1);
    expect(j.page).toBe(1);
  });

  it('FT-V155-OLD-07/08 run select and bad sql', async () => {
    const storagePath = await tmpDir();
    await cli(['table', 'create', '--name', 'u', '--field', 'n:string', '-p', storagePath]);
    await cli(['insert', 'u', '--field', 'n=hi', '-p', storagePath]);
    const ok = await cli(['run', 'SELECT * FROM u', '-p', storagePath]);
    expect(ok.code).toBe(0);
    const bad = await cli(['run', 'JOIN foo', '-p', storagePath, '--json']);
    expect(bad.code).toBe(1);
  });

  it('FT-V155-OLD-09 doctor unhealthy', async () => {
    const storagePath = await tmpDir();
    await cli(['init', '-p', storagePath]);
    await fs.mkdir(path.join(storagePath, 'collections', 'ghost'), {
      recursive: true,
    });
    const r = await cli(['doctor', '--deep', '-p', storagePath, '--json']);
    expect(r.code).not.toBe(0);
  });

  it('FT-V155-OLD-10 help snapshot', () => {
    const block = helpRootCommandsBlock();
    expect(block).toContain('insert / update / delete');
    expect(block).toContain('Exit codes:');
    expect(helpTable()).toContain('table export');
    expect(helpRoot()).toMatch(/jsonsqlite/);
  });
});

describe('v1.5.5 new commands', () => {
  it('FT-V155-NEW-01/02/06 insert get file', async () => {
    const storagePath = await tmpDir();
    await cli(['table', 'create', '--name', 'u', '-p', storagePath]);
    const ins = await cli([
      'insert',
      'u',
      '--data',
      '{"name":"寒"}',
      '-p',
      storagePath,
      '--json',
    ]);
    const id = JSON.parse(ins.stdout).ids[0] as string;
    const g = await cli(['get', 'u', '--id', id, '-p', storagePath, '--json']);
    expect(JSON.parse(g.stdout).doc.name).toBe('寒');

    const file = path.join(storagePath, 'rows.jsonl');
    await fs.writeFile(file, '{"name":"a"}\n{"name":"b"}\n');
    const multi = await cli(['insert', 'u', '--file', file, '-p', storagePath, '--json']);
    expect(JSON.parse(multi.stdout).count).toBe(2);

    const miss = await cli(['get', 'u', '--id', 'nope', '-p', storagePath, '--json']);
    expect(miss.code).toBe(1);
  });

  it('FT-V155-NEW-03/04/05 update delete', async () => {
    const storagePath = await tmpDir();
    await cli(['table', 'create', '--name', 'u', '-p', storagePath]);
    const ins = await cli([
      'insert',
      'u',
      '--data',
      '{"name":"x","age":1}',
      '-p',
      storagePath,
      '--json',
    ]);
    const id = JSON.parse(ins.stdout).ids[0] as string;
    await cli(['update', 'u', '--id', id, '--set', 'age=2', '-p', storagePath]);
    const g = await cli(['get', 'u', '--id', id, '-p', storagePath, '--json']);
    expect(JSON.parse(g.stdout).doc.age).toBe(2);

    const deny = await cli(['update', 'u', '--set', 'age=3', '-p', storagePath]);
    expect(deny.code).toBe(1);

    const del = await cli(['delete', 'u', '--id', id, '--yes', '-p', storagePath, '--json']);
    expect(JSON.parse(del.stdout).changes).toBe(1);
  });

  it('FT-V155-NEW-07 count', async () => {
    const storagePath = await tmpDir();
    await cli(['table', 'create', '--name', 'u', '-p', storagePath]);
    await cli(['insert', 'u', '--data', '{"age":10}', '-p', storagePath]);
    await cli(['insert', 'u', '--data', '{"age":20}', '-p', storagePath]);
    const all = await cli(['count', 'u', '-p', storagePath, '--json']);
    expect(JSON.parse(all.stdout).count).toBe(2);
    const filtered = await cli([
      'count',
      'u',
      '--where',
      '{"age":{"$gt":15}}',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(JSON.parse(filtered.stdout).count).toBe(1);
  });

  it('FT-V155-NEW-08 index create/list/drop', async () => {
    const storagePath = await tmpDir();
    await cli(['table', 'create', '--name', 'u', '-p', storagePath]);
    await cli(['insert', 'u', '--field', 'age=1', '-p', storagePath]);
    await cli(['index', 'create', 'u', 'age', '--type', 'tree', '-p', storagePath]);
    const list = await cli(['index', 'list', '-p', storagePath, '--json']);
    expect(JSON.parse(list.stdout).indexes.length).toBe(1);
    await cli(['index', 'drop', 'u', 'age', '-p', storagePath]);
    const list2 = await cli(['index', 'list', '-p', storagePath, '--json']);
    expect(JSON.parse(list2.stdout).indexes.length).toBe(0);
  });

  it('FT-V155-NEW-09/10 stats explain', async () => {
    const storagePath = await tmpDir();
    await cli(['table', 'create', '--name', 'u', '-p', storagePath]);
    await cli(['insert', 'u', '--data', '{"age":1}', '-p', storagePath]);
    const s = await cli(['stats', '-p', storagePath, '--json']);
    const sj = JSON.parse(s.stdout);
    expect(sj.tables).toBe(1);
    expect(sj.documents).toBe(1);

    const e = await cli([
      'explain',
      'SELECT * FROM u WHERE age > 0',
      '-p',
      storagePath,
      '--json',
    ]);
    const ej = JSON.parse(e.stdout);
    expect(ej.collection).toBe('u');
    expect(Array.isArray(ej.advice)).toBe(true);
  });
});

describe('v1.5.5 ops + version + inventory', () => {
  it('FT-V155-OPS-01 export/import', async () => {
    const a = await tmpDir();
    const b = await tmpDir();
    await cli(['table', 'create', '--name', 'u', '-p', a]);
    await cli(['insert', 'u', '--data', '{"n":1}', '-p', a]);
    const file = path.join(a, 'out.jsonl');
    await cli(['table', 'export', 'u', '--file', file, '-p', a]);
    await cli(['table', 'import', 'u', '--file', file, '--mode', 'replace', '-p', b]);
    const c = await cli(['count', 'u', '-p', b, '--json']);
    expect(JSON.parse(c.stdout).count).toBe(1);
  });

  it('FT-V155-OPS-02/04 vacuum doctor', async () => {
    const storagePath = await tmpDir();
    await cli(['table', 'create', '--name', 'u', '-p', storagePath]);
    await cli(['insert', 'u', '--data', '{"n":1}', '-p', storagePath]);
    const v = await cli(['vacuum', '-y', '-p', storagePath, '--json']);
    expect(v.code).toBe(0);
    const d = await cli(['doctor', '--deep', '-p', storagePath, '--json']);
    expect(d.code).toBe(0);
  });

  it('FT-V155-OPS-03 rekey --out', async () => {
    const source = await tmpDir();
    const target = await tmpDir();
    // seed encrypted via API
    const db = await open({ storagePath: source, encryptionKey: 'old' });
    await db.insert('u', { n: 1 });
    await db.close();
    const r = await cli([
      'rekey',
      '-p',
      source,
      '--out',
      target,
      '--from-key',
      'old',
      '--to-key',
      'new',
      '--json',
    ]);
    expect(r.code).toBe(0);
    const db2 = await open({ storagePath: target, encryptionKey: 'new' });
    expect(await db2.count('u')).toBe(1);
    await db2.close();
  });

  it('FT-V155-VER-01 version', async () => {
    expect(getVersion()).toBe('1.5.5');
    const r = await cli(['--version']);
    expect(r.stdout.trim()).toBe('1.5.5');
  });

  it('FT-V155-INV-01 inventory file exists', async () => {
    const inv = path.resolve(
      __dirname,
      '../../../devDocs/releases/v1.5.5/cli-command-inventory.md',
    );
    const text = await fs.readFile(inv, 'utf8');
    expect(text).toContain('insert');
    expect(text).toContain('rekey');
    expect(text).toContain('explain');
  });
});
