import http from 'node:http';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { JSONSQLite } from '../engine/JSONSQLite.js';
import { getAdminHtml } from '../admin/dashboard.js';

export interface HttpServerOptions {
  host?: string;
  port?: number;
  adminToken?: string | null;
}

export async function startHttpServer(
  db: JSONSQLite,
  opts: HttpServerOptions = {},
): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3000;
  const token = opts.adminToken ?? null;

  if (!isLoopbackHost(host) && !token) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      `Admin server bound to non-loopback host '${host}' requires adminToken`,
    );
  }
  if (isLoopbackHost(host) && !token) {
    console.warn(
      '[jsonsqlite] Admin server started on loopback without adminToken — do not expose this port',
    );
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);

      if (url.pathname === '/health') {
        const h = await db.health();
        return json(res, 200, h);
      }

      if (url.pathname.startsWith('/admin')) {
        if (token) {
          const auth = req.headers.authorization ?? '';
          if (auth !== `Bearer ${token}`) {
            return json(res, 401, { error: 'unauthorized' });
          }
        }
        if (url.pathname === '/admin' || url.pathname === '/admin/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(getAdminHtml());
          return;
        }
        if (url.pathname === '/admin/metrics') {
          return json(res, 200, db.getMetrics());
        }
      }

      if (url.pathname === '/query' && req.method === 'POST') {
        if (token && req.headers.authorization !== `Bearer ${token}`) {
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
