export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface GeoBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Accept `{ lat, lon }`, `{ latitude, longitude }`, `{ lon, lat }`,
 * GeoJSON Point `[lon, lat]`, or a bare `[lon, lat]` pair.
 */
export function readGeoPoint(value: unknown): GeoPoint | null {
  if (Array.isArray(value)) {
    const lon = num(value[0]);
    const lat = num(value[1]);
    if (lat === null || lon === null) return null;
    return { lat, lon };
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.type === 'Point' && Array.isArray(record.coordinates)) {
    return readGeoPoint(record.coordinates);
  }
  const lat = num(record.lat ?? record.latitude);
  const lon = num(record.lon ?? record.lng ?? record.longitude);
  if (lat === null || lon === null) return null;
  return { lat, lon };
}

export function pointInBox(value: unknown, box: GeoBox): boolean {
  const point = readGeoPoint(value);
  if (!point) return false;
  return (
    point.lat >= box.minLat &&
    point.lat <= box.maxLat &&
    point.lon >= box.minLon &&
    point.lon <= box.maxLon
  );
}

export function assertGeoBox(box: GeoBox): void {
  for (const key of ['minLat', 'minLon', 'maxLat', 'maxLon'] as const) {
    if (typeof box[key] !== 'number' || !Number.isFinite(box[key])) {
      throw new Error(`$geoWithin.${key} must be a finite number`);
    }
  }
}
