import http from 'node:http';
import https from 'node:https';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { JSONSQLite } from '../engine/JSONSQLite.js';
import { getAdminHtml } from '../admin/dashboard.js';
import type { JsonQuery } from '../types/index.js';

export interface HttpServerOptions {
  host?: string;
  port?: number;
  adminToken?: string | null;
  /** PEM cert and key. Required together with adminToken when host is not loopback. */
  tls?: { cert: string | Buffer; key: string | Buffer } | null;
}

export async function startHttpServer(
  db: JSONSQLite,
  opts: HttpServerOptions = {},
): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3000;
  const token = opts.adminToken ?? null;

  if (!isLoopbackHost(host)) {
    const hasTls = Boolean(opts.tls?.cert && opts.tls?.key);
    if (!token || !hasTls) {
      throw new JSONSQLiteError(
        ErrorCode.INVALID_CONFIG,
        `Admin server bound to non-loopback host '${host}' requires adminToken and TLS cert/key`,
      );
    }
  }
  if (isLoopbackHost(host) && !token) {
    console.warn(
      '[jsonsqlite] Admin server started on loopback without adminToken — do not expose this port',
    );
  }

  const sseClients = new Set<http.ServerResponse>();
  const unsubData = db.subscribe((event) => {
    broadcast(sseClients, 'dataChanged', event);
  });
  const metricsTimer = setInterval(() => {
    try {
      broadcast(sseClients, 'metrics', db.getMetrics());
    } catch {
      /* closed */
    }
  }, 5000);

  const handler: http.RequestListener = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);

      if (url.pathname === '/health') {
        const h = await db.health();
        return json(res, 200, h);
      }

      if (url.pathname === '/events' || url.pathname === '/admin/events') {
        if (!authorize(req, token, url)) {
          return json(res, 401, { error: 'unauthorized' });
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': ok\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (
        url.pathname.startsWith('/admin') ||
        url.pathname === '/metrics' ||
        url.pathname === '/advise' ||
        url.pathname === '/profile' ||
        url.pathname === '/backup' ||
        url.pathname === '/tables' ||
        url.pathname === '/slow' ||
        url.pathname === '/timetravel'
      ) {
        if (!authorize(req, token, url)) {
          return json(res, 401, { error: 'unauthorized' });
        }

        if (url.pathname === '/admin' || url.pathname === '/admin/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(getAdminHtml());
          return;
        }

        const route = url.pathname.replace(/^\/admin/, '') || '/';
        if (route === '/metrics' || url.pathname === '/metrics') {
          return json(res, 200, db.getMetrics());
        }
        if (route === '/slow' || url.pathname === '/slow') {
          return json(res, 200, { slow: db.getSlowQueries() });
        }
        if (route === '/tables' || url.pathname === '/tables') {
          const tables = await db.listTables();
          return json(res, 200, { tables });
        }
        if (
          (route === '/advise' || url.pathname === '/advise') &&
          req.method === 'POST'
        ) {
          const body = JSON.parse(await readBody(req)) as JsonQuery;
          return json(res, 200, { advice: db.advise(body) });
        }
        if (
          (route === '/profile' || url.pathname === '/profile') &&
          req.method === 'POST'
        ) {
          const body = JSON.parse(await readBody(req)) as {
            usedIndex?: string;
            planMs?: number;
            executeMs?: number;
          };
          return json(
            res,
            200,
            db.profileQuery(body.usedIndex, body.planMs ?? 0, body.executeMs ?? 0),
          );
        }
        if (
          (route === '/backup' || url.pathname === '/backup') &&
          req.method === 'POST'
        ) {
          const info = await db.backupFull();
          return json(res, 200, { backup: info });
        }
        if (
          (route === '/timetravel' || url.pathname === '/timetravel') &&
          req.method === 'POST'
        ) {
          const body = JSON.parse(await readBody(req)) as {
            collection: string;
            timestamp: number;
            query?: Omit<JsonQuery, 'collection'>;
          };
          const rows = await db.queryAtTime(
            body.collection,
            body.timestamp,
            body.query ?? {},
          );
          return json(res, 200, { rows });
        }
        if (route === '/indexes' || url.pathname === '/admin/indexes') {
          return json(res, 200, { indexes: await db.listIndexes() });
        }
      }

      if (url.pathname === '/query' && req.method === 'POST') {
        if (!authorize(req, token, url)) {
          return json(res, 401, { error: 'unauthorized' });
        }
        const body = await readBody(req);
        const q = JSON.parse(body);
        const rows = await db.query(q);
        return json(res, 200, { rows });
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  };

  const server = opts.tls?.cert && opts.tls?.key
    ? https.createServer(
        { cert: opts.tls.cert, key: opts.tls.key },
        handler,
      )
    : http.createServer(handler);

  server.on('close', () => {
    clearInterval(metricsTimer);
    unsubData();
    for (const c of sseClients) c.end();
    sseClients.clear();
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });
  return server;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === '127.0.0.1' ||
    h === '::1' ||
    h === 'localhost' ||
    h === '0:0:0:0:0:0:0:1'
  );
}

function authorize(
  req: http.IncomingMessage,
  token: string | null,
  url?: URL,
): boolean {
  if (!token) return true;
  const auth = req.headers.authorization ?? '';
  if (auth === `Bearer ${token}`) return true;
  // EventSource cannot set Authorization — allow ?token=
  if (url?.searchParams.get('token') === token) return true;
  return false;
}

function broadcast(
  clients: Set<http.ServerResponse>,
  event: string,
  data: unknown,
): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
