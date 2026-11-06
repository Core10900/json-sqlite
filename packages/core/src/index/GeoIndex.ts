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

/** Optional bounding-box index. Without it, `$geoWithin` still scans. */
export class GeoIndex implements Index {
  private readonly points = new Map<string, GeoPoint>();

  constructor(readonly meta: IndexMeta) {}

  build(docs: Document[]): void {
    this.points.clear();
    for (const doc of docs) this.insert(doc);
  }

  insert(doc: Document): void {
    const point = readGeoPoint(fieldValue(doc, this.meta.field));
    if (!point) {
      this.points.delete(doc._id);
      return;
    }
    this.points.set(doc._id, point);
  }

  update(prev: Document | undefined, next: Document): void {
    if (prev) this.remove(prev);
    this.insert(next);
  }

  remove(doc: Document): void {
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
    const ids: string[] = [];
    for (const [id, point] of this.points) {
      if (pointInBox(point, box)) ids.push(id);
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
    for (const [id, packed] of snapshot.entries) {
      const point = readGeoPoint(JSON.parse(packed[0] ?? 'null') as unknown);
      if (point) this.points.set(id, point);
    }
  }
}
