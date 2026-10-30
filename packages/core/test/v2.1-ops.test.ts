import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  create,
  getCompatibilityInfo,
  getVersion,
  migrateDatabase,
  open,
  rekeyDatabase,
} from '../src/index.js';
import { pageFile } from '../src/utils/path.js';

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const cliJs = path.resolve(__dirname, '../dist/cli.js');
const repoRoot = path.resolve(__dirname, '../../..');

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-v21-'));
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
  vi.restoreAllMocks();
  while (dirs.length) {
    await fs.rm(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('v2.1.0 version', () => {
  it('FT-V21-VER-01 version is 2.1.0 and not LTS', () => {
    expect(getVersion()).toBe('2.1.0');
    const info = getCompatibilityInfo();
    expect(info.version).toBe('2.1.0');
    expect(info.lts).toBe(false);
    expect(info.writers).toBe('single');
    expect(info.cliSurface).toBe('2.1.0');
    expect(info.features).toEqual(
      expect.arrayContaining([
        'backup-differential',
        'alerts',
        'audit',
        'regex',
        'single-writer',
      ]),
    );
  });
});

describe('v2.1.0 backup ops', () => {
  it('FT-V21-BK-01 differential round-trip matches the source sample', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'a', name: 'alice' });
    await db.backupFull();
    await db.insert('users', { _id: 'b', name: 'bob' });
    const diff = await db.backupDifferential();
    expect(diff?.type).toBe('differential');
    await db.update('users', 'a', { name: 'alice2' });
    await db.close();

    const target = await tmpDir();
    await create({ storagePath: target });
    const dst = await open({ storagePath: target });
    // Copy backup dir into target so restoreChain can resolve the manifest.
    await fs.cp(path.join(storagePath, 'backups'), path.join(target, 'backups'), {
      recursive: true,
    });
    await dst.restoreChain({ type: 'differential' });
    expect((await dst.findById('users', 'a'))?.name).toBe('alice');
    expect((await dst.findById('users', 'b'))?.name).toBe('bob');
    await dst.close();
  });

  it('FT-V21-BK-02 keepDays / maxCount prune expired copies', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { name: 'x' });
    const a = await db.backupFull();
    await new Promise((r) => setTimeout(r, 5));
    await db.insert('users', { name: 'y' });
    const b = await db.backupFull();
    const list = await db.listBackups();
    expect(list.length).toBeGreaterThanOrEqual(2);

    // Make the older backup look expired.
    const manifest = path.join(storagePath, 'backups', 'manifest.json');
    const items = JSON.parse(await fs.readFile(manifest, 'utf8')) as Array<{
      file: string;
      timestamp: number;
    }>;
    const old = items.find((i) => i.file === a.file)!;
    old.timestamp = Date.now() - 10 * 86_400_000;
    await fs.writeFile(manifest, JSON.stringify(items, null, 2));

    const pruned = await db.pruneBackups({ keepDays: 1, maxCount: 10 });
    expect(pruned.removed.some((r) => r.file === a.file)).toBe(true);
    expect(pruned.kept.some((k) => k.file === b.file)).toBe(true);
    await expect(fs.access(a.file)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.access(b.file);
    await db.close();
  });

  it('FT-V21-BK-03 interval off means no backup timer', async () => {
    const db = await open({ storagePath: await tmpDir(), backupIntervalMs: 0 });
    expect(db.hasBackupScheduler()).toBe(false);
    await db.close();
  });

  it('FT-V21-BK-04 backup write failure raises an alert; DB stays usable', async () => {
    const storagePath = await tmpDir();
    const db = await open({
      storagePath,
      alerts: { rules: [{ kind: 'backup_failed' }] },
    });
    await db.insert('users', { _id: 'ok', name: 'ok' });
    const alerts: unknown[] = [];
    db.on('alert', (ev) => alerts.push(ev));

    const backupDir = path.join(storagePath, 'backups');
    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.writeFile(backupDir, 'not-a-dir');

    await expect(db.backupFull()).rejects.toBeTruthy();
    expect(alerts.some((a) => (a as { kind: string }).kind === 'backup_failed')).toBe(
      true,
    );
    expect((await db.findById('users', 'ok'))?.name).toBe('ok');
    await db.close();
  });
});

describe('v2.1.0 monitor audit recovery', () => {
  it('FT-V21-MON-01 error-rate rule delivers an EventEmitter alert', async () => {
    const db = await open({
      storagePath: await tmpDir(),
      alerts: { rules: [{ kind: 'error_rate', errorRateAbove: 0.01 }] },
    });
    const seen: unknown[] = [];
    db.on('alert', (ev) => seen.push(ev));
    await db.recordErrorForAlerts();
    expect(seen.some((a) => (a as { kind: string }).kind === 'error_rate')).toBe(true);
    await db.close();
  });

  it('FT-V21-AUD-01 rekey / rollback / drop / migrate are listable', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'u', name: 'v1' });
    await db.update('users', 'u', { name: 'v2' });
    const ts = Date.now();
    await db.rollbackToTime('users', ts - 60_000);
    await db.dropTable('users');
    await db.close();

    const out = await tmpDir();
    await rekeyDatabase({
      storagePath,
      toKey: 'new-secret-key',
      targetPath: out,
    });
    const auditRekey = await open({ storagePath: out, encryptionKey: 'new-secret-key' });
    const rekeyEntries = await auditRekey.listAudit({ action: 'rekey' });
    expect(rekeyEntries.length).toBeGreaterThan(0);
    await auditRekey.close();

    const src = await tmpDir();
    const legacy = await tmpDir();
    // Minimal format-1 source for migrate audit on target.
    await fs.mkdir(path.join(legacy, 'meta'), { recursive: true });
    await fs.mkdir(path.join(legacy, 'collections', 't', 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(legacy, 'meta', 'catalog.json'),
      JSON.stringify({
        formatVersion: 1,
        collections: { t: { name: 't', createdAt: 1, documentCount: 1 } },
      }),
    );
    await fs.writeFile(
      path.join(legacy, 'collections', 't', 'docs', 'data.jsonl'),
      `${JSON.stringify({
        _id: '1',
        _version: 1,
        _createdAt: 1,
        _updatedAt: 1,
        n: 1,
      })}\n`,
    );
    const migrated = await migrateDatabase({ from: legacy, to: src, yes: true });
    const mdb = await open({ storagePath: migrated.storagePath });
    const mig = await mdb.listAudit({ action: 'migrate' });
    expect(mig.length).toBeGreaterThan(0);

    // Source DB still has drop + rollback audits.
    const srcDb = await open({ storagePath });
    const all = await srcDb.listAudit();
    expect(all.some((e) => e.action === 'drop')).toBe(true);
    expect(all.some((e) => e.action === 'rollbackToTime')).toBe(true);
    await srcDb.close();
    await mdb.close();
  });

  it('FT-V21-REC-01 corrupt index segment rebuilds on reopen', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { name: 'z', age: 9 });
    await db.createIndex('users', 'name', 'object');
    await db.close();
    const idxDir = path.join(storagePath, 'meta', 'idx');
    const files = await fs.readdir(idxDir);
    await fs.writeFile(path.join(idxDir, files[0]!), 'broken', 'utf8');
    const db2 = await open({ storagePath });
    expect(db2.indexPersistence().rebuilt).toContain('users');
    const rows = await db2.query({ collection: 'users', filter: { name: 'z' } });
    expect(rows).toHaveLength(1);
    await db2.close();
  });

  it('FT-V21-REC-02 corrupt data page refuses open with DATA_CORRUPT', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, pageSize: 4 });
    await db.insert('users', { _id: 'a', name: 'a' });
    await db.close();
    const page = pageFile(storagePath, 'users', 1);
    await fs.writeFile(page, '{not-json\n', 'utf8');
    await expect(open({ storagePath })).rejects.toMatchObject({
      code: ErrorCode.DATA_CORRUPT,
    });
  });

  it('FT-V21-REC-03 explicit repair rebuilds indexes; open does not rewrite pages', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath });
    await db.insert('users', { name: 'r' });
    await db.createIndex('users', 'name', 'object');
    const beforePage = await fs.readFile(pageFile(storagePath, 'users', 1));
    const result = await db.repair({ rebuildIndexes: true });
    expect(result.rebuiltIndexes).toContain('users');
    const afterPage = await fs.readFile(pageFile(storagePath, 'users', 1));
    expect(afterPage).toEqual(beforePage);
    const audit = await db.listAudit({ action: 'repair' });
    expect(audit.length).toBeGreaterThan(0);
    await db.close();
  });
});

describe('v2.1.0 query and tune', () => {
  it('FT-V21-TUN-01 AutoTune apply failure rolls indexes back', async () => {
    const db = await open({
      storagePath: await tmpDir(),
      autoTune: true,
      autoTuneDryRun: false,
    });
    await db.insert('users', { name: 'a', city: 'x' });
    const before = await db.listIndexes();
    db.configureAutoTune({ enabled: true, dryRun: false, minHits: 1 });
    db.setAutoTuneValidate(() => {
      throw new Error('gray failed');
    });
    await db.runAutoTune({
      collection: 'users',
      filter: { city: 'x' },
    });
    const after = await db.listIndexes();
    expect(after).toEqual(before);
    expect(db.getTuneHistory().some((h) => h.kind === 'rollback')).toBe(true);
    await db.close();
  });

  it('FT-V21-Q-01 $regex matches and rejects invalid patterns', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { name: 'Alice' });
    await db.insert('users', { name: 'bob' });
    const hit = await db.query({
      collection: 'users',
      filter: { name: { $regex: { pattern: '^a', flags: 'i' } } },
    });
    expect(hit.map((d) => d.name)).toEqual(['Alice']);
    const miss = await db.query({
      collection: 'users',
      filter: { name: { $regex: '^zzz' } },
    });
    expect(miss).toHaveLength(0);
    await expect(
      db.query({
        collection: 'users',
        filter: { name: { $regex: '(' } },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_CONFIG });
    await db.close();
  });

  it('FT-V21-Q-02 selective filter reads fewer pages than a full scan', async () => {
    const storagePath = await tmpDir();
    const db = await open({ storagePath, pageSize: 4, maxResidentDocs: 8 });
    for (let i = 0; i < 40; i++) {
      await db.insert('items', { sku: `s${i}`, n: i });
    }
    await db.createIndex('items', 'sku', 'object');
    await db.close();

    const db2 = await open({ storagePath, pageSize: 4, maxResidentDocs: 8 });
    db2.resetPageReads();
    await db2.query({ collection: 'items', filter: { sku: 's3' } });
    const selective = db2.pagingStats().pageReads;
    db2.resetPageReads();
    await db2.query({ collection: 'items', filter: { n: { $gte: 0 } } });
    const fullish = db2.pagingStats().pageReads;
    expect(selective).toBeGreaterThan(0);
    expect(selective).toBeLessThan(fullish);
    expect(selective).toBeLessThan(10);
    await db2.close();
  });

  it('FT-V21-Q-03 Advisor dry-run suggests rewrites without creating indexes', async () => {
    const db = await open({ storagePath: await tmpDir() });
    await db.insert('users', { name: 'n', age: 1 });
    const before = await db.listIndexes();
    const advice = db.advise({ collection: 'users', filter: { age: 1 } });
    expect(advice.some((a) => a.type === 'index' || a.type === 'rewrite')).toBe(true);
    expect(await db.listIndexes()).toEqual(before);
    await db.close();
  });
});

describe('v2.1.0 CLI', () => {
  it('FT-V21-CLI-01 backup --type differential is scriptable', async () => {
    const storagePath = await tmpDir();
    const init = await cli(['init', '-p', storagePath, '--json']);
    expect(init.code).toBe(0);
    await cli([
      'insert',
      'users',
      '-p',
      storagePath,
      '--data',
      '{"name":"a"}',
      '--json',
      '--yes',
    ]);
    const full = await cli(['backup', '-p', storagePath, '--type', 'full', '--json']);
    expect(full.code).toBe(0);
    await cli([
      'insert',
      'users',
      '-p',
      storagePath,
      '--data',
      '{"name":"b"}',
      '--json',
      '--yes',
    ]);
    const diff = await cli([
      'backup',
      '-p',
      storagePath,
      '--type',
      'differential',
      '--json',
    ]);
    expect(diff.code).toBe(0);
    expect(diff.stdout).toMatch(/differential/);
  });

  it('FT-V21-CLI-02 tune --dry-run does not change indexes', async () => {
    const storagePath = await tmpDir();
    await cli(['init', '-p', storagePath, '--json']);
    await cli([
      'insert',
      'users',
      '-p',
      storagePath,
      '--data',
      '{"name":"a","city":"x"}',
      '--json',
      '--yes',
    ]);
    const tune = await cli([
      'tune',
      '-p',
      storagePath,
      '--dry-run',
      '--json',
      '{"collection":"users","filter":{"city":"x"}}',
    ]);
    expect(tune.code).toBe(0);
    const body = JSON.parse(tune.stdout) as {
      dryRun: boolean;
      indexes: unknown[];
    };
    expect(body.dryRun).toBe(true);
    expect(body.indexes).toEqual([]);
  });
});

describe('v2.1.0 docs gate', () => {
  it('FT-V21-DOC release notes mark non-LTS single-writer', async () => {
    const changelog = await fs.readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/2\.1\.0/);
    expect(changelog).toMatch(/非 LTS|非LTS|not LTS|non-LTS/i);
    const api = await fs.readFile(path.join(repoRoot, 'API.md'), 'utf8');
    expect(api).toMatch(/2\.1/);
    expect(api).toMatch(/单写者/);
  });
});
