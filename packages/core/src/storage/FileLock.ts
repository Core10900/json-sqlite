import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { ErrorCode, JSONSQLiteError } from '../errors.js';
import { lockFile } from '../utils/path.js';

/**
 * Simple exclusive file lock for single-writer guarantee (v1).
 * Uses O_EXCL create; stale lock from dead process is detected via pid check when possible.
 */
export class FileLock {
  private readonly lockPath: string;
  private held = false;

  constructor(private readonly storagePath: string) {
    this.lockPath = lockFile(storagePath);
  }

  async acquire(): Promise<void> {
    await fsPromises.mkdir(pathDir(this.lockPath), { recursive: true });

    try {
      const fd = fs.openSync(this.lockPath, 'wx');
      const payload = JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
      });
      fs.writeFileSync(fd, payload, 'utf8');
      fs.closeSync(fd);
      this.held = true;
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw new JSONSQLiteError(
          ErrorCode.LOCK_FAILED,
          `Failed to acquire lock: ${(err as Error).message}`,
        );
      }
    }

    // Lock exists — check if holder is alive
    try {
      const raw = await fsPromises.readFile(this.lockPath, 'utf8');
      const info = JSON.parse(raw) as { pid?: number };
      if (info.pid && !isPidAlive(info.pid)) {
        await fsPromises.unlink(this.lockPath);
        return this.acquire();
      }
    } catch {
      // ignore parse errors; treat as held
    }

    throw new JSONSQLiteError(
      ErrorCode.LOCK_FAILED,
      `Storage path is locked by another process: ${this.storagePath}`,
    );
  }

  async release(): Promise<void> {
    if (!this.held) return;
    try {
      await fsPromises.unlink(this.lockPath);
    } catch {
      // ignore
    }
    this.held = false;
  }
}

function pathDir(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx >= 0 ? filePath.slice(0, idx) : '.';
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
