import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { helpRoot } from '../src/cli/help.js';
import {
  DANGEROUS_CONFIG_KEYS,
  FROZEN_CONFIG_KEYS,
  V30_CONFIG_KEYS,
  V31_CONFIG_KEYS,
  V32_CONFIG_KEYS,
  V33_CONFIG_KEYS,
  V34_CONFIG_KEYS,
  validateConfig,
  validateConfigFile,
} from '../src/config/validate.js';
import { ErrorCode, getCompatibilityInfo, getVersion, migrateDatabase, open } from '../src/index.js';
import { catalogFile, docsFile } from '../src/utils/path.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');
const exampleFile = path.resolve(__dirname, '../config.example.json');
const drillScript = path.resolve(__dirname, '../scripts/backup-drill.mjs');
const repoRoot = path.resolve(__dirname, '../../..');

const FROZEN_HELP_COMMANDS = [
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
  'advise',
  'aggregate',
  'admin',
  'watch',
  'compat',
  'version',
  'backup',
  'vacuum',
  'rekey',
  'tune',
  'audit',
  'migrate',
  'doctor',
  'config',
] as const;

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v22-'));
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

describe('v2.2.0 LTS-2', () => {
  it('FT-V22-VER-01 / FT-V22-LTS-01 version is 2.2.0 LTS-2', () => {
    const info = getCompatibilityInfo();
    expect(info.version).toBe(getVersion());
    expect(info.writers).toBe('single');
    expect(info.formatVersion).toBe(2);
    expect(info.features).toContain('lts-2');
    expect(info.features).not.toEqual(expect.arrayContaining(['cluster', 'replica']));
    if (
      info.version.startsWith('2.2.') ||
      info.version.startsWith('2.3.') ||
      info.version.startsWith('2.4.')
    ) {
      expect(info.ltsLine).toBe('2.2');
    }
    if (info.version.startsWith('2.2.')) {
      expect(getVersion()).toBe('2.2.0');
      expect(info.lts).toBe(true);
      expect(info.cliSurface).toBe('2.2.0');
    }
  });

  it('FT-V22-CFG-02 a second writer is still rejected', async () => {
    const storagePath = await tmpDir();
    const a = await open({ storagePath });
    await expect(open({ storagePath })).rejects.toMatchObject({
      code: ErrorCode.LOCK_FAILED,
    });
    await a.close();
  });

  it('FT-V22-CFG-01 example config validates and dangerous keys are refused', async () => {
    const resolved = await validateConfigFile(exampleFile);
    expect(resolved.storagePath).toBe('./data');
    expect(resolved.defaultIsolation).toBe('READ_COMMITTED');
    expect(resolved.pageSize).toBe(32);
    expect(resolved.maxResidentDocs).toBe(256);
    expect(resolved.backupIntervalMs).toBe(0);
    expect(resolved.tiering).toBe(false);

    const example = JSON.parse(await fs.readFile(exampleFile, 'utf8')) as Record<string, unknown>;
    const frozen = new Set<string>([
      ...FROZEN_CONFIG_KEYS,
      ...V30_CONFIG_KEYS,
      ...V31_CONFIG_KEYS,
      ...V32_CONFIG_KEYS,
      ...V33_CONFIG_KEYS,
      ...V34_CONFIG_KEYS,
    ]);
    const dangerous = new Set<string>(DANGEROUS_CONFIG_KEYS);
    for (const key of Object.keys(example)) {
      expect(frozen.has(key)).toBe(true);
      expect(dangerous.has(key)).toBe(false);
    }
    const requiredDangerous = ['cluster', 'cache', 'raft'];
    if (
      !getVersion().startsWith('3.3.') &&
      !getVersion().startsWith('3.4.') &&
      !getVersion().startsWith('3.5.') &&
      !getVersion().startsWith('3.6.')
    ) {
      requiredDangerous.push('replica');
    }
    if (
      !getVersion().startsWith('3.2.') &&
      !getVersion().startsWith('3.3.') &&
      !getVersion().startsWith('3.4.') &&
      !getVersion().startsWith('3.5.') &&
      !getVersion().startsWith('3.6.')
    ) {
      requiredDangerous.push('l3', 'redis');
    }
    if (getVersion().startsWith('2.2.') || getVersion().startsWith('2.3.')) {
      requiredDangerous.push('writers');
    }
    for (const key of requiredDangerous) {
      expect(dangerous.has(key)).toBe(true);
      if (key !== 'l3' && key !== 'redis' && key !== 'replica') {
        expect(example).not.toHaveProperty(key);
      }
    }

    expect(() =>
      validateConfig({ storagePath: './data', cluster: { nodes: 3 } }),
    ).toThrow(/Rejected dangerous config key/);
    expect(validateConfig({ storagePath: './data', graphql: false }).graphql).toBe(false);

    const cliOk = await cli(['config', 'validate', '--file', exampleFile, '--json']);
    expect(cliOk.code).toBe(0);
    const okBody = JSON.parse(cliOk.stdout) as { action: string; ltsLine: string };
    expect(okBody.action).toBe('config.validate');
    if (getVersion().startsWith('2.5.') || getVersion().startsWith('3.')) expect(okBody.ltsLine).toBe('2.5');
    else expect(okBody.ltsLine).toBe('2.2');

    const badFile = path.join(await tmpDir(), 'cluster.json');
    await fs.writeFile(
      badFile,
      JSON.stringify({ storagePath: './data', cluster: true, checkpointInterval: 1 }),
    );
    const cliBad = await cli(['config', 'validate', '--file', badFile, '--json']);
    expect(cliBad.code).toBe(1);
    const badBody = JSON.parse(cliBad.stdout) as { ok: boolean; code: string; message: string };
    expect(badBody.ok).toBe(false);
    expect(badBody.code).toBe('INVALID_CONFIG');
    expect(badBody.message).toMatch(/cluster/);
    expect(badBody.message).toMatch(/not applied|Refused/);
    expect(badBody.message).toMatch(/checkpointInterval/);
  });

  it('FT-V22-CLI-01 version --json reports LTS-2', async () => {
    const ver = await cli(['version', '--json']);
    expect(ver.code).toBe(0);
    const body = JSON.parse(ver.stdout) as {
      version: string;
      lts: boolean;
      ltsLine: string;
      writers: string;
    };
    expect(body.writers).toBe('single');
    if (body.version.startsWith('2.5.') || body.version.startsWith('3.')) expect(body.ltsLine).toBe('2.5');
    else expect(body.ltsLine).toBe('2.2');
    if (body.version.startsWith('2.2.')) {
      expect(body.version).toBe('2.2.0');
      expect(body.lts).toBe(true);
    }

    const compat = await cli(['compat', '--json']);
    expect(compat.code).toBe(0);
    const compatLine = (JSON.parse(compat.stdout) as { ltsLine: string }).ltsLine;
    if (body.version.startsWith('2.5.') || body.version.startsWith('3.')) expect(compatLine).toBe('2.5');
    else expect(compatLine).toBe('2.2');
  });

  it('FT-V22-CLI-02 help matches the frozen CLI-API surface', async () => {
    const help = helpRoot();
    const cliApi = await fs.readFile(path.join(repoRoot, 'CLI-API.md'), 'utf8');
    const commands = help.slice(help.indexOf('Commands:'), help.indexOf('Exit codes:'));
    for (const token of FROZEN_HELP_COMMANDS) {
      expect(commands).toContain(token);
      expect(cliApi).toContain(token);
    }
    const banned = getVersion().startsWith('2.2.')
      ? ['plugin', 'replica', 'cluster', 'graphql', 'savepoint']
      : getVersion().startsWith('3.3.') ||
          getVersion().startsWith('3.4.') ||
          getVersion().startsWith('3.5.') ||
          getVersion().startsWith('3.6.')
        ? ['cluster', 'savepoint']
        : ['replica', 'cluster', 'graphql', 'savepoint'];
    for (const token of banned) {
      expect(commands).not.toContain(token);
    }
    expect(cliApi).toMatch(/2\.2\.x PATCH/);
    expect(cliApi).toMatch(/config validate --file/);
    expect(help).toMatch(/Exit codes: 0 ok · 1 usage\/business · 2 system\/IO · 3 lock failed/);
  });

  it('FT-V22-MIG-01 the 1.8 sample in the migration guide round-trips', async () => {
    const guide = await fs.readFile(
      path.join(repoRoot, 'devDocs/releases/v2.2.0/迁移指南.md'),
      'utf8',
    );
    expect(guide).toMatch(/1\.6/);
    expect(guide).toMatch(/1\.8/);
    expect(guide).toMatch(/cold\.jsonl/);
    expect(guide).toMatch(/migrate --from/);
    expect(guide).toContain('"name": "寒"');

    const from = path.join(await tmpDir(), 'src');
    const to = path.join(await tmpDir(), 'dst');
    await fs.mkdir(path.join(from, 'meta'), { recursive: true });
    await fs.mkdir(path.join(from, 'collections', 'users', 'docs'), { recursive: true });
    await fs.writeFile(
      catalogFile(from),
      JSON.stringify({
        formatVersion: 1,
        collections: {
          users: { name: 'users', createdAt: 1, documentCount: 1 },
        },
      }),
    );
    await fs.writeFile(
      docsFile(from, 'users'),
      `${JSON.stringify({
        _id: 'u1',
        _version: 1,
        _createdAt: 1,
        _updatedAt: 1,
        name: '寒',
      })}\n`,
    );
    const result = await migrateDatabase({ from, to, yes: true });
    expect(result.formatVersion).toBe(2);
    expect(result.documentCounts.users).toBe(1);
    const db = await open({ storagePath: to });
    expect((await db.findById('users', 'u1'))?.name).toBe('寒');
    await expect(open({ storagePath: to })).rejects.toMatchObject({
      code: ErrorCode.LOCK_FAILED,
    });
    await db.close();
  });

  it('FT-V22-DRILL-01/02 backup drill script', async () => {
    const { stdout } = await execFileAsync(process.execPath, [drillScript], {
      timeout: 30_000,
    });
    const report = JSON.parse(stdout) as {
      ok: boolean;
      scenarios: Record<string, boolean>;
    };
    expect(report.ok).toBe(true);
    expect(report.scenarios).toEqual({
      full: true,
      incremental: true,
      differential: true,
      checksum: true,
      walMiddle: true,
      dataPage: true,
    });
  });

  it('FT-V22 docs name LTS-2, the support window, and the core README', async () => {
    const readme = await fs.readFile(path.resolve(__dirname, '../README.md'), 'utf8');
    expect(readme).toMatch(/2\.2\.0/);
    expect(readme).toMatch(/LTS-2/);
    expect(readme).toMatch(/ltsLine: '2\.2'/);
    expect(readme).toMatch(/READ_COMMITTED/);
    expect(readme).toMatch(/REPEATABLE_READ/);
    expect(readme).toMatch(/LOCK_FAILED/);
    expect(readme).toMatch(/config validate --file/);
    expect(readme).toMatch(/12 个月|12 months/);
    expect(readme).toMatch(/多写者|multi-writer/);
    expect(readme).not.toMatch(/Vision Complete/);

    const changelog = await fs.readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/## 2\.2\.0/);
    expect(changelog).toMatch(/LTS-2/);
    const api = await fs.readFile(path.join(repoRoot, 'API.md'), 'utf8');
    expect(api).toMatch(/LTS-2/);
    expect(api).toMatch(/2\.2\.x/);
  });
});
