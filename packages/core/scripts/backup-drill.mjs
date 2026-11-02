#!/usr/bin/env node
/**
 * LTS-2 backup drill: full, incremental, differential, bad checksum,
 * middle-of-file WAL corruption, and a bad data page.
 * Exit 0 only when every scenario refuses damage without dropping
 * already-committed bytes.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ErrorCode, create, open } from '../dist/index.js';

function pageFile(storage, name, pageId = 1) {
  const n = String(pageId).padStart(6, '0');
  return path.join(storage, 'collections', name, 'docs', 'pages', `p${n}.jsonl`);
}

function walPath(storage, name) {
  return path.join(storage, 'wal', `${name}.wal`);
}

function walLine(entry) {
  const checksum = createHash('sha256')
    .update(JSON.stringify({ ...entry, checksum: '' }))
    .digest('hex')
    .slice(0, 16);
  return JSON.stringify({ ...entry, checksum });
}

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'jsonsqlite-lts2-drill-'));
}

async function names(db) {
  return (await db.query({ collection: 'users' })).map((d) => d.name).sort();
}

const report = {
  full: false,
  incremental: false,
  differential: false,
  checksum: false,
  walMiddle: false,
  dataPage: false,
};

const dirs = [];

try {
  {
    const storagePath = await tmp();
    dirs.push(storagePath);
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'a', name: 'full' });
    await db.backupFull();
    await db.update('users', 'a', { name: 'dirty' });
    await db.restoreChain({ type: 'full' });
    if ((await db.findById('users', 'a'))?.name !== 'full') {
      throw new Error('full restore did not return the sampled document');
    }
    await db.close();
    report.full = true;
  }

  {
    const storagePath = await tmp();
    dirs.push(storagePath);
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'a', name: 'a' });
    await db.backupFull();
    await db.insert('users', { _id: 'b', name: 'b' });
    const inc = await db.backupIncremental();
    if (inc?.type !== 'incremental') throw new Error('incremental backup missing');
    await db.delete('users', 'a');
    await db.insert('users', { _id: 'c', name: 'c' });
    await db.restoreChain({ type: 'incremental' });
    const got = await names(db);
    if (got.join(',') !== 'a,b') {
      throw new Error(`incremental sample mismatch: ${got.join(',')}`);
    }
    await db.close();
    report.incremental = true;
  }

  {
    const storagePath = await tmp();
    dirs.push(storagePath);
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'a', name: 'alice' });
    await db.backupFull();
    await db.insert('users', { _id: 'b', name: 'bob' });
    const diff = await db.backupDifferential();
    if (diff?.type !== 'differential') throw new Error('differential backup missing');
    await db.update('users', 'a', { name: 'alice2' });
    await db.close();

    const target = await tmp();
    dirs.push(target);
    await create({ storagePath: target });
    await fs.cp(path.join(storagePath, 'backups'), path.join(target, 'backups'), {
      recursive: true,
    });
    const dst = await open({ storagePath: target });
    await dst.restoreChain({ type: 'differential' });
    const alice = await dst.findById('users', 'a');
    const bob = await dst.findById('users', 'b');
    if (alice?.name !== 'alice' || bob?.name !== 'bob') {
      throw new Error('differential sample mismatch');
    }
    await dst.close();
    report.differential = true;
  }

  {
    const storagePath = await tmp();
    dirs.push(storagePath);
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'a', name: 'kept' });
    await db.backupFull();
    await db.close();
    const page = pageFile(storagePath, 'users');
    const before = await fs.readFile(page);
    const manifestPath = path.join(storagePath, 'backups', 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest[0].checksum = '0'.repeat(64);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const db2 = await open({ storagePath });
    let refused = false;
    try {
      await db2.restoreChain({ type: 'full' });
    } catch (err) {
      if (err?.code !== ErrorCode.BACKUP_CHECKSUM) throw err;
      refused = true;
    }
    if (!refused) throw new Error('tampered checksum was applied');
    const after = await fs.readFile(page);
    if (!after.equals(before)) throw new Error('checksum failure rewrote the page');
    if ((await db2.findById('users', 'a'))?.name !== 'kept') {
      throw new Error('checksum failure dropped the committed document');
    }
    await db2.close();
    report.checksum = true;
  }

  {
    const storagePath = await tmp();
    dirs.push(storagePath);
    const db = await open({ storagePath });
    await db.insert('users', { _id: 'base', name: 'base' });
    await db.close();
    const page = pageFile(storagePath, 'users');
    const before = await fs.readFile(page);
    const good = walLine({
      ts: 2,
      txId: null,
      committed: true,
      op: 'insert',
      collection: 'users',
      payload: {
        _id: 'sneaky',
        _version: 1,
        _createdAt: 2,
        _updatedAt: 2,
        name: 'sneaky',
      },
      seq: 2,
    });
    const bad = walLine({
      ts: 1,
      txId: null,
      committed: true,
      op: 'insert',
      collection: 'users',
      payload: {
        _id: 'bad',
        _version: 1,
        _createdAt: 1,
        _updatedAt: 1,
        name: 'bad',
      },
      seq: 1,
    }).replace(/"checksum":"[a-f0-9]+"/, '"checksum":"0000000000000000"');
    await fs.mkdir(path.dirname(walPath(storagePath, 'users')), { recursive: true });
    await fs.writeFile(walPath(storagePath, 'users'), `${bad}\n${good}\n`, 'utf8');
    let refused = false;
    try {
      await open({ storagePath });
    } catch (err) {
      if (err?.code !== ErrorCode.WAL_CORRUPT) throw err;
      refused = true;
    }
    if (!refused) throw new Error('middle WAL corruption was opened');
    const after = await fs.readFile(page);
    if (!after.equals(before)) throw new Error('middle WAL corruption rewrote the page');
    report.walMiddle = true;
  }

  {
    const storagePath = await tmp();
    dirs.push(storagePath);
    const db = await open({ storagePath, pageSize: 4 });
    await db.insert('users', { _id: 'a', name: 'a' });
    await db.close();
    const page = pageFile(storagePath, 'users');
    const corrupt = '{not-json\n';
    await fs.writeFile(page, corrupt, 'utf8');
    let refused = false;
    try {
      await open({ storagePath });
    } catch (err) {
      if (err?.code !== ErrorCode.DATA_CORRUPT) throw err;
      refused = true;
    }
    if (!refused) throw new Error('bad data page was opened');
    const after = await fs.readFile(page, 'utf8');
    if (after !== corrupt) throw new Error('bad data page was rewritten');
    report.dataPage = true;
  }

  const ok = Object.values(report).every(Boolean);
  console.log(JSON.stringify({ ok, scenarios: report }));
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.log(JSON.stringify({ ok: false, scenarios: report, error: String(err?.message ?? err) }));
  process.exitCode = 1;
} finally {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
}
