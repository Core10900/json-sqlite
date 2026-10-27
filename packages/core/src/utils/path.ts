import path from 'node:path';

export function collectionDir(storagePath: string, name: string): string {
  return path.join(storagePath, 'collections', name);
}

export function docsFile(storagePath: string, name: string): string {
  return path.join(collectionDir(storagePath, name), 'docs', 'data.jsonl');
}

/** Cold-tier JSONL (experimental). Absent when tiering is off. */
export function coldDocsFile(storagePath: string, name: string): string {
  return path.join(collectionDir(storagePath, name), 'docs', 'cold.jsonl');
}

export function walFile(storagePath: string, name: string): string {
  return path.join(storagePath, 'wal', `${name}.wal`);
}

export function catalogFile(storagePath: string): string {
  return path.join(storagePath, 'meta', 'catalog.json');
}

export function lockFile(storagePath: string): string {
  return path.join(storagePath, 'meta', '.lock');
}
