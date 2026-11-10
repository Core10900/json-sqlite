import fs from 'node:fs/promises';
import path from 'node:path';
import { open as fsOpen } from 'node:fs/promises';
import { ErrorCode, JSONSQLiteError } from '../errors.js';

export type SyncMode = 'none' | 'normal' | 'full';

let atomicSeq = 0;

function mapIoError(err: unknown): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC') {
    throw new JSONSQLiteError(
      ErrorCode.STORAGE_FULL,
      'Disk is full; the write was not committed',
      { code },
    );
  }
  if (code === 'EACCES' || code === 'EPERM') {
    throw new JSONSQLiteError(
      ErrorCode.STORAGE_PERMISSION,
      'Write path is not writable; the write was not committed',
      { code },
    );
  }
  throw err;
}

/** Write file via tmp + rename; optionally fsync file and parent directory. */
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  syncMode: SyncMode = 'normal',
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(mapIoError);
  const tmp = `${file}.tmp.${process.pid}.${atomicSeq++}.${Date.now()}`;
  try {
    const handle = await fsOpen(tmp, 'w');
    try {
      await handle.writeFile(data);
      if (syncMode !== 'none') {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
    if (syncMode === 'full') {
      await fsyncPath(file);
      await fsyncDir(path.dirname(file));
    } else if (syncMode === 'normal') {
      await fsyncDir(path.dirname(file));
    }
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    mapIoError(err);
  }
}

/** Append text; optionally fsync the file afterward. */
export async function appendFileDurable(
  file: string,
  data: string,
  syncMode: SyncMode = 'normal',
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, data, 'utf8');
    if (syncMode !== 'none') {
      await fsyncPath(file);
    }
  } catch (err) {
    mapIoError(err);
  }
}

export async function fsyncPath(file: string): Promise<void> {
  try {
    const handle = await fsOpen(file, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    // Some platforms may not allow r+ on empty; try r
    try {
      const handle = await fsOpen(file, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      /* best-effort */
    }
  }
}

export async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await fsOpen(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* directory fsync unsupported on some platforms — ignore */
  }
}
