import type { Document } from '../types/index.js';
import type { Index, IndexMeta, IndexSnapshot } from './types.js';
import { pointInBox, readGeoPoint, type GeoBox, type GeoPoint } from './geo.js';

function fieldValue(doc: Document, field: string): unknown {
  if (!field.includes('.')) return doc[field];
  return field.split('.').reduce<unknown>((cur, part) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[part];
    return undefined;
  }, doc);
}

/**
 * Grid index for `$geoWithin`. A lookup visits only cells that overlap
 * the box, then the points in those cells. It does not walk every point.
 * Without this index the planner still scans, and explain marks that scan.
 */
export class GeoIndex implements Index {
  private readonly points = new Map<string, GeoPoint>();
  private readonly cells = new Map<string, Set<string>>();
  /** Points inspected by the last lookupGeo (cell hits only). */
  examined = 0;
  /** Grid cells touched by the last lookupGeo, including empty ones in the box. */
  cellVisits = 0;
  readonly cellSize = 1;

  constructor(readonly meta: IndexMeta) {}

  resetAccess(): void {
    this.examined = 0;
    this.cellVisits = 0;
  }

  build(docs: Document[]): void {
    this.points.clear();
    this.cells.clear();
    for (const doc of docs) this.insert(doc);
  }

  insert(doc: Document): void {
    this.remove(doc);
    const point = readGeoPoint(fieldValue(doc, this.meta.field));
    if (!point) return;
    this.points.set(doc._id, point);
    this.addCell(doc._id, point);
  }

  private cellKey(point: GeoPoint): string {
    const y = Math.floor(point.lat / this.cellSize);
    const x = Math.floor(point.lon / this.cellSize);
    return `${y}:${x}`;
  }

  private addCell(id: string, point: GeoPoint): void {
    const key = this.cellKey(point);
    let set = this.cells.get(key);
    if (!set) {
      set = new Set();
      this.cells.set(key, set);
    }
    set.add(id);
  }

  update(prev: Document | undefined, next: Document): void {
    if (prev) this.remove(prev);
    this.insert(next);
  }

  remove(doc: Document): void {
    const point = this.points.get(doc._id);
    if (point) {
      const set = this.cells.get(this.cellKey(point));
      set?.delete(doc._id);
      if (set && set.size === 0) this.cells.delete(this.cellKey(point));
    }
    this.points.delete(doc._id);
  }

  lookupEq(value: unknown): string[] {
    const point = readGeoPoint(value);
    if (!point) return [];
    const ids: string[] = [];
    for (const [id, stored] of this.points) {
      if (stored.lat === point.lat && stored.lon === point.lon) ids.push(id);
    }
    return ids;
  }

  lookupRange(): string[] {
    return [];
  }

  lookupText(): string[] {
    return [];
  }

  stats(): { keys: number; docs: number } {
    return { keys: this.points.size, docs: this.points.size };
  }

  lookupGeo(box: GeoBox): string[] {
    this.examined = 0;
    this.cellVisits = 0;
    const y0 = Math.floor(box.minLat / this.cellSize);
    const y1 = Math.floor(box.maxLat / this.cellSize);
    const x0 = Math.floor(box.minLon / this.cellSize);
    const x1 = Math.floor(box.maxLon / this.cellSize);
    const ids: string[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        this.cellVisits += 1;
        const set = this.cells.get(`${y}:${x}`);
        if (!set) continue;
        for (const id of set) {
          this.examined += 1;
          const point = this.points.get(id);
          if (point && pointInBox(point, box)) ids.push(id);
        }
      }
    }
    return ids;
  }

  exportEntries(): IndexSnapshot {
    return {
      entries: [...this.points].map(([id, point]) => [id, [JSON.stringify(point)]]),
    };
  }

  importEntries(snapshot: IndexSnapshot): void {
    this.points.clear();
    this.cells.clear();
    for (const [id, packed] of snapshot.entries) {
      const point = readGeoPoint(JSON.parse(packed[0] ?? 'null') as unknown);
      if (!point) continue;
      this.points.set(id, point);
      this.addCell(id, point);
    }
  }
}
