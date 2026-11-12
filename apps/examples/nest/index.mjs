/**
 * Nest-style module pattern without pulling @nestjs/* into core.
 * Demonstrates providers / module wiring around JSONSQLite.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { open } from '@webofcat/jsonsqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storagePath = path.join(__dirname, 'data');
const port = Number(process.env.PORT ?? 3200);

/** @typedef {{ db: import('@webofcat/jsonsqlite').JSONSQLite }} JsonSqliteModule */

async function createJsonSqliteModule() {
  const db = await open({ storagePath });
  return {
    module: 'JsonSqliteModule',
    providers: {
      JSONSQLITE: db,
      UsersCollection: db.collection('users'),
    },
    exports: ['JSONSQLITE', 'UsersCollection'],
    async onModuleDestroy() {
      await db.close({ flush: true });
    },
  };
}

const mod = await createJsonSqliteModule();
const users = mod.providers.UsersCollection;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  res.setHeader('Content-Type', 'application/json');
  try {
    if (req.method === 'POST' && url.pathname === '/users') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const doc = await users.insert(body);
      res.writeHead(201);
      res.end(JSON.stringify({ doc, module: mod.module }));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/users/')) {
      const id = decodeURIComponent(url.pathname.slice('/users/'.length));
      const doc = await users.findById(id);
      if (!doc) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'DOCUMENT_NOT_FOUND' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ doc }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(port, () => {
  console.log(`nest-like example on http://127.0.0.1:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    server.close();
    await mod.onModuleDestroy();
    process.exit(0);
  });
}
