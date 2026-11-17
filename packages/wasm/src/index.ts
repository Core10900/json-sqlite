import {
  open,
  type Document,
  type JsonQuery,
  type JSONSQLite,
} from '@webofcat/jsonsqlite';

const VERSION = '3.6.0';

export const meta = {
  experimental: true,
  readOnly: true,
  version: VERSION,
} as const;

/** Clear experimental read-only refusal for write APIs. */
export class ExperimentalReadonlyError extends Error {
  readonly code = 'EXPERIMENTAL_READONLY' as const;

  constructor(operation: string) {
    super(
      `@webofcat/jsonsqlite-wasm is experimental and read-only; ${operation} is not supported. ` +
        'Write paths are not part of any LTS commitment for this optional package.',
    );
    this.name = 'ExperimentalReadonlyError';
  }
}

export interface OpenReadonlyOptions {
  storagePath: string;
}

/**
 * Node experimental read-only facade over an existing JSONSQLite directory.
 * True browser WASM compile is not shipped; this package is the
 * optional `@webofcat/jsonsqlite-wasm` adapter (pure JS; LTS-4 write path excluded).
 */
export interface ReadonlyDb {
  findById(collection: string, id: string): Promise<Document | null>;
  query(query: JsonQuery): Promise<Document[]>;
  close(): Promise<void>;
  insert(
    collection: string,
    data: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<never>;
  update(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<never>;
  delete(collection: string, id: string): Promise<never>;
}

class ReadonlyDbImpl implements ReadonlyDb {
  constructor(private readonly db: JSONSQLite) {}

  findById(collection: string, id: string): Promise<Document | null> {
    return this.db.findById(collection, id);
  }

  query(query: JsonQuery): Promise<Document[]> {
    return this.db.query(query);
  }

  close(): Promise<void> {
    return this.db.close();
  }

  async insert(): Promise<never> {
    throw new ExperimentalReadonlyError('insert');
  }

  async update(): Promise<never> {
    throw new ExperimentalReadonlyError('update');
  }

  async delete(): Promise<never> {
    throw new ExperimentalReadonlyError('delete');
  }
}

/**
 * Open an existing DB directory for experimental read-only access.
 * Uses `@webofcat/jsonsqlite` under the hood; mutations throw.
 */
export async function openReadonly(
  options: OpenReadonlyOptions,
): Promise<ReadonlyDb> {
  if (!options?.storagePath || typeof options.storagePath !== 'string') {
    throw new TypeError('openReadonly requires { storagePath: string }');
  }
  const db = await open({ storagePath: options.storagePath });
  return new ReadonlyDbImpl(db);
}
