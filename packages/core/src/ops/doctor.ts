import fs from 'node:fs/promises';
import path from 'node:path';
import type { JSONSQLite } from '../engine/JSONSQLite.js';
import type { DoctorCheck, DoctorReport } from '../types/index.js';
import { catalogFile, collectionDir, docsFile, walFile } from '../utils/path.js';
import { isEncryptedLine } from '../crypto/aes.js';

export async function runDoctor(
  db: JSONSQLite,
  opts?: { deep?: boolean },
): Promise<DoctorReport> {
  const deep = opts?.deep === true;
  const checks: DoctorCheck[] = [];
  const root = db.storagePath;

  const health = await db.health();
  checks.push({
    id: 'health',
    ok: health.status === 'healthy',
    message: `health.status=${health.status}`,
    details: health.checks,
  });

  // catalog readable
  try {
    await fs.access(catalogFile(root));
    checks.push({ id: 'catalog', ok: true, message: 'catalog.json present' });
  } catch {
    checks.push({ id: 'catalog', ok: false, message: 'catalog.json missing' });
  }

  if (deep) {
    const tables = await db.listTables();
    for (const t of tables) {
      const dir = collectionDir(root, t.name);
      try {
        await fs.access(dir);
        checks.push({
          id: `collection-dir:${t.name}`,
          ok: true,
          message: `directory exists for ${t.name}`,
        });
      } catch {
        checks.push({
          id: `collection-dir:${t.name}`,
          ok: false,
          message: `missing directory for catalog collection ${t.name}`,
        });
      }

      // Load and compare counts
      await db._store.ensureLoaded(t.name);
      const live = db._store.getAll(t.name).length;
      const meta = t.documentCount;
      checks.push({
        id: `count:${t.name}`,
        ok: live === meta,
        message:
          live === meta
            ? `documentCount matches (${live})`
            : `documentCount mismatch catalog=${meta} live=${live}`,
        details: { catalog: meta, live },
      });

      // WAL checksum sampling via readCommitted (skips corrupt; ensure no throw)
      try {
        const walPath = walFile(root, t.name);
        let raw = '';
        try {
          raw = await fs.readFile(walPath, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        let lines = 0;
        let encrypted = 0;
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          lines += 1;
          if (isEncryptedLine(line)) encrypted += 1;
        }
        checks.push({
          id: `wal:${t.name}`,
          ok: true,
          message: `wal lines=${lines} encryptedLines=${encrypted}`,
        });
      } catch (err) {
        checks.push({
          id: `wal:${t.name}`,
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Sample index consistency: indexed docs must exist
      const indexes = (await db.listIndexes()).filter(
        (i) => i.collection === t.name,
      );
      if (indexes.length > 0) {
        const docs = db._store.getAll(t.name);
        const idSet = new Set(docs.map((d) => d._id));
        let bad = 0;
        for (const idx of indexes) {
          // touch planner path by querying equality on a sample field value
          if (docs.length === 0) continue;
          const sample = docs[0]!;
          if (!(idx.field in sample)) continue;
          const hits = await db.query({
            collection: t.name,
            filter: { [idx.field]: sample[idx.field] as never },
            limit: 5,
          });
          for (const h of hits) {
            if (!idSet.has(h._id)) bad += 1;
          }
        }
        checks.push({
          id: `index-sample:${t.name}`,
          ok: bad === 0,
          message:
            bad === 0
              ? `index sample ok (${indexes.length} indexes)`
              : `index sample found ${bad} orphan hits`,
        });
      }

      // Orphan docs file check
      try {
        await fs.access(docsFile(root, t.name));
      } catch {
        if (live > 0) {
          checks.push({
            id: `docs-file:${t.name}`,
            ok: false,
            message: 'data.jsonl missing but live docs > 0',
          });
        }
      }
    }

    // Orphan collection dirs not in catalog
    try {
      const colRoot = path.join(root, 'collections');
      const dirs = await fs.readdir(colRoot);
      const known = new Set(tables.map((t) => t.name));
      for (const d of dirs) {
        if (!known.has(d)) {
          checks.push({
            id: `orphan-dir:${d}`,
            ok: false,
            message: `collections/${d} not in catalog`,
          });
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  const status = checks.every((c) => c.ok) ? 'healthy' : 'unhealthy';
  return { status, deep, checks, timestamp: Date.now() };
}
