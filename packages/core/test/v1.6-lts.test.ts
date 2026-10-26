import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import * as pkg from '../src/index.js';
import {
  ErrorCode,
  FORMAT_VERSION,
  create,
  getCompatibilityInfo,
  getVersion,
  open,
} from '../src/index.js';
import { helpRoot, helpRootCommandsBlock, helpTable } from '../src/cli/help.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');
const repoRoot = path.resolve(__dirname, '../../..');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v16-'));
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
      { timeout: 20_000 },
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

const VALUE_EXPORTS = [
  'JSONSQLite',
  'open',
  'create',
  'init',
  'getVersion',
  'getCompatibilityInfo',
  'parseSql',
  'rekeyDatabase',
  'JSONSQLiteError',
  'ErrorCode',
  'FORMAT_VERSION',
] as const;

const INVENTORY_COMMANDS = [
  'version',
  'help',
  'create',
  'init',
  'tables',
  'collections',
  'table',
  'insert',
  'update',
  'delete',
  'get',
  'count',
  'run',
  'sql',
  'query',
  'index',
  'stats',
  'explain',
  'backup',
  'vacuum',
  'rekey',
  'doctor',
] as const;

describe('v1.6.0 gate (1.5.5)', () => {
  it('FT-V16-GATE-02 inventory exists', async () => {
    const inv = path.join(
      repoRoot,
      'devDocs/releases/v1.5.5/cli-command-inventory.md',
    );
    const text = await fs.readFile(inv, 'utf8');
    expect(text).toContain('insert');
    expect(text).toContain('rekey');
    expect(text).toContain('explain');
  });

  it('FT-V16-GATE-03 V155 suite present', async () => {
    await fs.access(path.join(__dirname, 'v1.5.5-cli.test.ts'));
  });
});

describe('v1.6.0 root docs', () => {
  it('FT-V16-DOC-01/02/04 CLI-API + API exist with LTS headers', async () => {
    const cliApi = await fs.readFile(path.join(repoRoot, 'CLI-API.md'), 'utf8');
    const api = await fs.readFile(path.join(repoRoot, 'API.md'), 'utf8');
    expect(cliApi).toMatch(/1\.6\.x LTS/);
    expect(cliApi).toMatch(/1\.5\.5/);
    expect(cliApi).toContain('insert');
    expect(cliApi).toContain('explain');
    expect(cliApi).toContain('sql');
    expect(api).toMatch(/1\.6\.x LTS/);
    expect(api).toContain('ErrorCode');
    expect(api).toContain('getCompatibilityInfo');
    expect(api).toContain('JSONSQLiteOptions');
  });

  it('FT-V16-DOC-03 README links authority docs', async () => {
    const readme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('CLI-API.md');
    expect(readme).toContain('API.md');
  });

  it('FT-V16-DOC-06 inventory ⊆ CLI-API quick table', async () => {
    const cliApi = await fs.readFile(path.join(repoRoot, 'CLI-API.md'), 'utf8');
    for (const cmd of INVENTORY_COMMANDS) {
      expect(cliApi.toLowerCase()).toContain(cmd);
    }
  });
});

describe('v1.6.0 API contract', () => {
  it('FT-V16-API-01/02 exports ⊆ API.md', async () => {
    const api = await fs.readFile(path.join(repoRoot, 'API.md'), 'utf8');
    for (const name of VALUE_EXPORTS) {
      expect(api).toContain(name);
      expect(pkg).toHaveProperty(name);
    }
  });

  it('FT-V16-API-03 ErrorCode complete in API.md', async () => {
    const api = await fs.readFile(path.join(repoRoot, 'API.md'), 'utf8');
    for (const code of Object.values(ErrorCode)) {
      expect(api).toContain(code);
    }
  });

  it('FT-V16-API-04 Options defaults documented', async () => {
    const api = await fs.readFile(path.join(repoRoot, 'API.md'), 'utf8');
    expect(api).toMatch(/lazyCollections/);
    expect(api).toMatch(/schemaMode/);
    expect(api).toMatch(/syncMode/);
    expect(api).toMatch(/encryptionKey/);
  });

  it('FT-V16-API-05 getCompatibilityInfo', () => {
    const info = getCompatibilityInfo();
    expect(typeof info.lts).toBe('boolean');
    expect(typeof info.cliSurface).toBe('string');
    expect(info.formatVersion).toBe(FORMAT_VERSION);
    expect(info.version).toBe(getVersion());
    expect(info.features.length).toBeGreaterThan(0);
    // 1.6 LTS line freeze; 1.7+ may extend cliSurface while keeping 1.5.5 commands
    if (info.version.startsWith('1.6.')) {
      expect(info.lts).toBe(true);
      expect(info.cliSurface).toBe('1.5.5');
    }
  });
});

describe('v1.6.0 CLI contract (frozen 1.5.5)', () => {
  it('FT-V16-CLI-01 help ⊆ CLI-API', async () => {
    const cliApi = await fs.readFile(path.join(repoRoot, 'CLI-API.md'), 'utf8');
    const help = helpRoot();
    for (const token of [
      'insert',
      'update',
      'delete',
      'get',
      'count',
      'index',
      'stats',
      'explain',
      'sql',
      'vacuum',
      'rekey',
      'doctor',
    ]) {
      expect(help.toLowerCase()).toContain(token);
      expect(cliApi.toLowerCase()).toContain(token);
    }
    expect(helpRootCommandsBlock()).toContain('Exit codes:');
    expect(helpTable()).toContain('table export');
  });

  it('FT-V16-CLI-02 nested help', async () => {
    const a = await cli(['table', '--help']);
    expect(a.code).toBe(0);
    const b = await cli(['insert', '--help']);
    expect(b.code).toBe(0);
  });

  it('FT-V16-CLI-03 smoke create/init/insert/get/count', async () => {
    const storagePath = await tmpDir();
    expect((await cli(['create', storagePath, '--json'])).code).toBe(0);
    expect((await cli(['init', '-p', storagePath, '--json'])).code).toBe(0);
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
    const ins = await cli([
      'insert',
      'u',
      '--data',
      '{"n":"x"}',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(ins.code).toBe(0);
    const id = JSON.parse(ins.stdout).ids[0] as string;
    const g = await cli(['get', 'u', '--id', id, '-p', storagePath, '--json']);
    expect(g.code).toBe(0);
    const c = await cli(['count', 'u', '-p', storagePath, '--json']);
    expect(JSON.parse(c.stdout).count).toBe(1);
  });

  it('FT-V16-CLI-04/06 non-TTY + json error envelope', async () => {
    const storagePath = await tmpDir();
    await cli(['init', '-p', storagePath]);
    const bad = await cli([
      'get',
      'missing',
      '--id',
      'x',
      '-p',
      storagePath,
      '--json',
    ]);
    expect(bad.code).toBe(1);
    const body = JSON.parse(bad.stdout || bad.stderr);
    expect(body.ok).toBe(false);
    expect(body.code).toBeTruthy();
    expect(body.message).toBeTruthy();

    const create = await cli(['table', 'create', '-p', storagePath]);
    expect(create.code).toBe(1);
  });

  it('FT-V16-CLI-05 lock exit 3', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    const r = await cli(['tables', '-p', storagePath, '--json']);
    await db.close();
    expect(r.code).toBe(3);
  });

  it('FT-V16-CLI-07 no undocumented new top-level commands in help', () => {
    const block = helpRootCommandsBlock();
    // Frozen surface tokens — help must not invent a 1.6 mega-command brand
    expect(block).not.toMatch(/\bmigrate-all\b/);
    expect(block).not.toMatch(/\bcluster\b/);
  });
});

describe('v1.6.0 LTS behavior freeze', () => {
  it('FT-V16-LTS-01 single-writer lock', async () => {
    const storagePath = await tmpDir();
    const a = await open({ storagePath });
    await expect(open({ storagePath })).rejects.toMatchObject({
      code: ErrorCode.LOCK_FAILED,
    });
    await a.close();
  });

  it('FT-V16-LTS-02 syncMode normal persists', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, syncMode: 'normal' });
    await db.insert('t', { v: 1 });
    await db.close();
    const db2 = await open({ storagePath });
    expect(await db2.count('t')).toBe(1);
    await db2.close();
  });

  it('FT-V16-LTS-03 SQL boundary', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await expect(db.run('SELECT * FROM (SELECT 1)')).rejects.toMatchObject({
      code: expect.stringMatching(/^SQL_/),
    });
    await db.close();
  });

  it('FT-V16-LTS-04 formatVersion open', async () => {
    const storagePath = await tmpDir();
    await create({ storagePath });
    const db = await open({ storagePath });
    expect(FORMAT_VERSION).toBe(1);
    await db.close();
  });

  it('FT-V16-LTS-05 schemaMode default off', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.createTable('u', {
      fields: [{ name: 'age', type: 'number' }],
    });
    // off: non-number still inserts
    await db.insert('u', { age: 'not-a-number' });
    expect(await db.count('u')).toBe(1);
    await db.close();
  });

  it('FT-V16-LTS-06 drop requires --yes non-TTY', async () => {
    const storagePath = await tmpDir();
    await cli(['table', 'create', '--name', 't', '-p', storagePath]);
    const deny = await cli(['table', 'drop', 't', '-p', storagePath]);
    expect(deny.code).toBe(1);
    const ok = await cli(['table', 'drop', 't', '--yes', '-p', storagePath]);
    expect(ok.code).toBe(0);
  });
});

describe('v1.6.0 version + release artifacts', () => {
  it('FT-V16-VER-01 getVersion matches package.json', () => {
    const pj = require('../package.json') as { version: string };
    expect(getVersion()).toBe(pj.version);
    expect(pj.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('FT-V16-DOC-05 smoke examples (lib + CLI)', async () => {
    const storagePath = await tmpDir();
    await create({ storagePath });
    const db = await open({ storagePath });
    await db.insert('demo', { ok: true });
    expect(await db.findById('demo', (await db.query({ collection: 'demo' }))[0]!._id)).toBeTruthy();
    await db.run('SELECT * FROM demo');
    await db.close();

    await cli(['tables', '-p', storagePath, '--json']);
    await cli(['count', 'demo', '-p', storagePath, '--json']);
    await cli(['doctor', '-p', storagePath, '--json']);
  });

  it('FT-V16-REL-01 CHANGELOG mentions LTS and 1.5.5', async () => {
    const log = await fs.readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(log).toMatch(/1\.6\.0/);
    expect(log).toMatch(/LTS/i);
    expect(log).toMatch(/1\.5\.5/);
  });
});
