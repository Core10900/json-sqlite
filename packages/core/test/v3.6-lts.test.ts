import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { helpRoot } from '../src/cli/help.js';
import {
  FORMAT_VERSION,
  create,
  getCompatibilityInfo,
  getVersion,
  open,
} from '../src/index.js';
import { catalogFile } from '../src/utils/path.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');
const repoRoot = path.resolve(__dirname, '../../..');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v36-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliJs, ...args], {
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: '1' },
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

describe('v3.6.0 LTS-4 gate', () => {
  it('FT-V36-VER-01 version --json is 3.6.0 with lts true and ltsLine 3.6', async () => {
    const info = getCompatibilityInfo();
    expect(getVersion()).toBe('3.6.0');
    expect(info).toMatchObject({
      version: '3.6.0',
      lts: true,
      ltsLine: '3.6',
      cliSurface: '3.6.0',
      writers: 'single',
      formatVersion: FORMAT_VERSION,
    });
    expect(info.ltsLine).not.toBe(info.version);
    expect(info.features).toEqual(
      expect.arrayContaining([
        'lts-2',
        'lts-3',
        'lts-4',
        'cli-3.5',
        'cli-3.6',
        'cluster-election',
        'cluster-rebalance',
        'cluster-lock',
      ]),
    );

    expect(helpRoot()).toMatch(/3\.6\.0, lts: true, ltsLine 3\.6/);

    const ver = await cli(['version', '--json']);
    expect(ver.code).toBe(0);
    const body = JSON.parse(ver.stdout) as {
      version: string;
      lts: boolean;
      ltsLine: string;
      cliSurface: string;
      writers: string;
    };
    expect(body).toMatchObject({
      version: '3.6.0',
      lts: true,
      ltsLine: '3.6',
      cliSurface: '3.6.0',
      writers: 'single',
    });
  });

  it('FT-V36-REG-01 default open stays single-writer with replica and cluster off', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    expect((await db.lockReport()).writers).toBe('single');
    expect(db.replicaStatus().enabled).toBe(false);
    expect(db.clusterStatus().enabled).toBe(false);
    await db.insert('docs', { _id: 'a', name: 'solo' });
    expect((await db.findById('docs', 'a'))?.name).toBe('solo');
    await db.close();
  });

  it('FT-V36-FMT-01 opening a 3.5-shaped catalog does not bump formatVersion', async () => {
    const storagePath = await tmpDir();
    await create({ storagePath });
    const before = JSON.parse(await fs.readFile(catalogFile(storagePath), 'utf8')) as {
      formatVersion: number;
    };
    expect(before.formatVersion).toBe(FORMAT_VERSION);

    const db = await open({ storagePath });
    expect(db.replicaStatus().enabled).toBe(false);
    expect(db.clusterStatus().enabled).toBe(false);
    await db.insert('docs', { _id: 'x', v: 1 });
    await db.close();

    const after = JSON.parse(await fs.readFile(catalogFile(storagePath), 'utf8')) as {
      formatVersion: number;
    };
    expect(after.formatVersion).toBe(before.formatVersion);
    expect(after.formatVersion).toBe(2);
  });

  it('FT-V36-MIG-01 2.5-shaped library opens as single with replica/cluster off', async () => {
    const storagePath = await tmpDir();
    // formatVersion 2 is the 2.5 / 3.5 on-disk line; 3.6 does not bump it.
    await create({ storagePath });
    const raw = JSON.parse(await fs.readFile(catalogFile(storagePath), 'utf8')) as Record<string, unknown>;
    expect(raw.formatVersion).toBe(2);

    const db = await open({ storagePath });
    expect((await db.lockReport()).writers).toBe('single');
    expect(db.replicaStatus().enabled).toBe(false);
    expect(db.clusterStatus().enabled).toBe(false);
    await db.insert('users', { _id: 'u1', name: 'mig' });
    expect((await db.findById('users', 'u1'))?.name).toBe('mig');
    await db.close();
  });

  it('FT-V36-CLI-01 help surface has no new default cluster command vs 3.5 freeze', () => {
    const text = helpRoot();
    const commands = text.slice(text.indexOf('Commands:'), text.indexOf('Exit codes:'));
    expect(commands).not.toMatch(/^\s*cluster\b/m);
    expect(text).toMatch(/3\.6\.0, lts: true, ltsLine 3\.6/);
    expect(text).not.toMatch(/Vision Complete/);
  });

  it('FT-V36-DOC-01/02 release notes and migration guide name LTS-4', async () => {
    const readme = await fs.readFile(path.resolve(__dirname, '../README.md'), 'utf8');
    expect(readme).toMatch(/3\.6\.0/);
    expect(readme).toMatch(/LTS-4/);
    expect(readme).toMatch(/lts: true/);
    expect(readme).toMatch(/ltsLine: '3\.6'/);
    expect(readme).toMatch(/lts-4/);
    expect(readme).toMatch(/默认.*单写者|单写者.*默认/);
    expect(readme).toMatch(/复制/);
    expect(readme).toMatch(/集群/);
    expect(readme).not.toMatch(/Vision Complete/);

    const rootReadme = await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8');
    expect(rootReadme).toMatch(/3\.6\.0/);
    expect(rootReadme).toMatch(/LTS-4/);
    expect(rootReadme).toMatch(/lts-4/);

    const changelog = await fs.readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/## 3\.6\.0/);
    expect(changelog).toMatch(/LTS-4/);
    expect(changelog).toMatch(/默认不启用复制和集群|复制关|集群关/);

    const migrate = await fs.readFile(
      path.join(repoRoot, 'devDocs/releases/v3.6.0/迁移指南.md'),
      'utf8',
    );
    expect(migrate).toMatch(/2\.5/);
    expect(migrate).toMatch(/3\.5/);
    expect(migrate).toMatch(/3\.6/);

    const cliApi = await fs.readFile(path.join(repoRoot, 'CLI-API.md'), 'utf8');
    expect(cliApi).toMatch(/## 27\. 3\.6 LTS-4/);
    expect(cliApi).toMatch(/ltsLine: "3\.6"/);

    const api = await fs.readFile(path.join(repoRoot, 'API.md'), 'utf8');
    expect(api).toMatch(/## 3\.6 LTS-4/);
    expect(api).toMatch(/ltsLine: '3\.6'/);
  });
});
