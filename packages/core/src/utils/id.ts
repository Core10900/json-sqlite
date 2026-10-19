import { randomBytes } from 'node:crypto';

/** Compact unique id (time-sortable-ish + random). */
export function generateId(): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(8).toString('hex');
  return `${time}_${rand}`;
}
