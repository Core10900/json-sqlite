import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JSONSQLite } from '../engine/JSONSQLite.js';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import type { Document, FilterCondition, JsonQuery } from '../types/index.js';

export interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

/**
 * Minimal string-based GraphQL executor for two shapes only:
 * - `query { documents(collection: "users", filter?: "...") { field... } }`
 * - `mutation { insert(collection: "users", data: "{...}") { field... } }`
 */
export async function executeGraphQL(
  db: JSONSQLite,
  source: string,
): Promise<GraphQLResult> {
  const text = source.trim();
  if (!text) {
    return { errors: [{ message: 'Empty GraphQL source' }] };
  }

  try {
    if (/^\s*mutation\b/i.test(text) || /\binsert\s*\(/i.test(text)) {
      return { data: { insert: await runInsert(db, text) } };
    }
    if (/^\s*query\b/i.test(text) || /\bdocuments\s*\(/i.test(text)) {
      return { data: { documents: await runDocuments(db, text) } };
    }
    return {
      errors: [
        {
          message:
            'Unsupported GraphQL. Use query { documents(...) } or mutation { insert(...) }',
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { errors: [{ message }] };
  }
}

async function runDocuments(db: JSONSQLite, source: string): Promise<Document[]> {
  const collection = extractStringArg(source, 'collection');
  if (!collection) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      'documents() requires collection: "name"',
    );
  }
  const filterRaw = extractStringArg(source, 'filter');
  const fields = extractSelection(source, 'documents');
  const query: JsonQuery = { collection };
  if (filterRaw) {
    query.filter = JSON.parse(filterRaw) as FilterCondition;
  }
  if (fields.length > 0 && !fields.includes('_id')) {
    query.projection = fields;
  } else if (fields.length > 0) {
    query.projection = fields;
  }
  const rows = await db.query(query);
  return projectDocs(rows, fields);
}

async function runInsert(db: JSONSQLite, source: string): Promise<Document> {
  const collection = extractStringArg(source, 'collection');
  const dataRaw = extractStringArg(source, 'data');
  if (!collection || dataRaw === null) {
    throw new JSONSQLiteError(
      ErrorCode.INVALID_CONFIG,
      'insert() requires collection and data string args',
    );
  }
  const data = JSON.parse(dataRaw) as Record<string, unknown>;
  const doc = (await db.insert(collection, data)) as Document;
  const fields = extractSelection(source, 'insert');
  return projectDocs([doc], fields)[0]!;
}

function extractStringArg(source: string, name: string): string | null {
  const re = new RegExp(
    `${name}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`,
    'i',
  );
  const m = source.match(re);
  if (!m) return null;
  return m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function extractSelection(source: string, field: string): string[] {
  const re = new RegExp(
    `${field}\\s*\\([^)]*\\)\\s*\\{([^}]*)\\}`,
    'i',
  );
  const m = source.match(re);
  if (!m) return [];
  return m[1]!
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function projectDocs(docs: Document[], fields: string[]): Document[] {
  if (fields.length === 0) return docs;
  return docs.map((doc) => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f in doc) out[f] = doc[f];
    }
    return out as Document;
  });
}

/**
 * Express-style request handler factory (also usable with node:http).
 * Expects JSON body `{ query: string }` or raw GraphQL text.
 */
export function createGraphqlHandler(db: JSONSQLite) {
  return async function graphqlHandler(
    req: IncomingMessage & { body?: unknown },
    res: ServerResponse & {
      status?: (code: number) => { json: (body: unknown) => void };
      json?: (body: unknown) => void;
    },
  ): Promise<void> {
    try {
      let source = '';
      if (typeof req.body === 'string') {
        source = req.body;
      } else if (req.body && typeof req.body === 'object') {
        const body = req.body as { query?: string };
        source = body.query ?? '';
      } else {
        source = await readIncomingBody(req);
        const trimmed = source.trim();
        if (trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed) as { query?: string };
            if (typeof parsed.query === 'string') source = parsed.query;
          } catch {
            /* treat as raw GraphQL */
          }
        }
      }
      const result = await executeGraphQL(db, source);
      const status = result.errors?.length ? 400 : 200;
      if (typeof res.status === 'function' && typeof res.json === 'function') {
        res.status(status).json(result);
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (typeof res.status === 'function' && typeof res.json === 'function') {
        res.status(500).json({ errors: [{ message }] });
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message }] }));
    }
  };
}

function readIncomingBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
