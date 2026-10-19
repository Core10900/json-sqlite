import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonsqlite-pack-'));
try {
  execSync('pnpm pack', { cwd: pkgRoot, stdio: 'inherit' });
  const tgz = fs.readdirSync(pkgRoot).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('No tarball produced');
  const tarball = path.join(pkgRoot, tgz);

  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'smoke', type: 'module', private: true }, null, 2),
  );
  execSync(`npm install ${JSON.stringify(tarball)}`, {
    cwd: tmp,
    stdio: 'inherit',
  });

  const esm = `
    import { open } from '@webofcat/jsonsqlite';
    const db = await open({ storagePath: './data' });
    await db.insert('t', { ok: true });
    const rows = await db.query({ collection: 't' });
    if (rows.length !== 1) throw new Error('esm smoke failed');
    await db.close();
    console.log('ESM smoke OK');
  `;
  fs.writeFileSync(path.join(tmp, 'esm.mjs'), esm);
  execSync('node esm.mjs', { cwd: tmp, stdio: 'inherit' });

  const cjs = `
    const { open } = require('@webofcat/jsonsqlite');
    (async () => {
      const db = await open({ storagePath: './data-cjs' });
      await db.insert('t', { ok: true });
      await db.close();
      console.log('CJS smoke OK');
    })();
  `;
  fs.writeFileSync(path.join(tmp, 'cjs.cjs'), cjs);
  execSync('node cjs.cjs', { cwd: tmp, stdio: 'inherit' });

  console.log('pack:smoke passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of fs.readdirSync(pkgRoot)) {
    if (f.endsWith('.tgz')) fs.unlinkSync(path.join(pkgRoot, f));
  }
}
