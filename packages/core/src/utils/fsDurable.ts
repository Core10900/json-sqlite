import fs from 'node:fs/promises';
import path from 'node:path';
import { open as fsOpen } from 'node:fs/promises';

export type SyncMode = 'none' | 'normal' | 'full';

let atomicSeq = 0;

/** Write file via tmp + rename; optionally fsync file and parent directory. */
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  syncMode: SyncMode = 'normal',
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
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
    throw err;
  }
}

/** Append text; optionally fsync the file afterward. */
export async function appendFileDurable(
  file: string,
  data: string,
  syncMode: SyncMode = 'normal',
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, data, 'utf8');
  if (syncMode !== 'none') {
    await fsyncPath(file);
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
