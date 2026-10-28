import path from 'node:path';

export function collectionDir(storagePath: string, name: string): string {
  return path.join(storagePath, 'collections', name);
}

export function docsFile(storagePath: string, name: string): string {
  return path.join(collectionDir(storagePath, name), 'docs', 'data.jsonl');
}

/** Page directory for formatVersion 2. Document bodies live in page files. */
export function pagesManifest(storagePath: string, name: string): string {
  return path.join(collectionDir(storagePath, name), 'docs', 'pages.json');
}

export function pageFile(storagePath: string, name: string, pageId: number): string {
  const n = String(pageId).padStart(6, '0');
  return path.join(collectionDir(storagePath, name), 'docs', 'pages', `p${n}.jsonl`);
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
