import fs from 'node:fs/promises';
import path from 'node:path';
import { open } from '../dist/index.js';

const [op, storagePath, role = 'a', value = 'v', id = 'doc1'] = process.argv.slice(2);

function report(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

async function barrier(name, expectCount) {
  const dir = path.join(storagePath, 'meta', 'barriers');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), '1');
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const names = await fs.readdir(dir);
    if (names.length >= expectCount) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`barrier timeout for ${name}`);
}

async function main() {
  if (op === 'crash-after') {
    const db = await open({ storagePath, writers: 'multi' });
    await db.insert('docs', { _id: id, name: 'kept', n: 1 });
    await db.insert('docs', { _id: 'other', name: 'kept-too', n: 1 });
    await db.createIndex('docs', 'name', 'object');
    await db.beginTransaction();
    await db.update('docs', id, { name: 'gone', n: 2 });
    process.exit(9);
  }

  const db = await open({ storagePath, writers: 'multi' });
  try {
    if (op === 'conflict') {
      await db.findById('docs', id);
      await barrier(role, 2);
      await db.update('docs', id, { name: value });
      report({ ok: true, name: value, role });
    } else if (op === 'distinct') {
      await db.findById('docs', id);
      await barrier(role, 2);
      await db.update('docs', id, { name: value });
      report({ ok: true, name: value, id, role });
    } else if (op === 'serializable') {
      await db.beginTransaction('SERIALIZABLE');
      await db.findById('docs', id);
      await barrier(role, 2);
      await db.update('docs', id, { name: value });
      await db.commitTransaction();
      report({ ok: true, name: value, role });
    } else if (op === 'deadlock') {
      const first = role === 'a' ? 'd1' : 'd2';
      const second = role === 'a' ? 'd2' : 'd1';
      await db.beginTransaction();
      await db.acquireDocLock('docs', first);
      await db.update('docs', first, { owner: role });
      await barrier(role, 2);
      await db.acquireDocLock('docs', second);
      await db.update('docs', second, { owner: role });
      await db.commitTransaction();
      report({ ok: true, role });
    } else {
      throw new Error(`unknown op ${op}`);
    }
    await db.close();
  } catch (err) {
    report({
      ok: false,
      role,
      code: err && err.code ? err.code : 'ERR',
      retryable: Boolean(err && err.details && err.details.retryable),
      message: err instanceof Error ? err.message : String(err),
    });
    await db.close().catch(() => undefined);
  }
}

main().catch((err) => {
  report({ ok: false, code: 'ERR', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
