export type DistanceUnit = "km" | "mi";
interface Point {
  latitude: number;
  longitude: number;
}
/** Great-circle distance, including crossings of the date line. */
export function distanceMeters(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
export function formatDistance(meters: number, unit: DistanceUnit): string {
  const value = meters / (unit === "mi" ? 1609.344 : 1000);
  if (value < 0.1) return `<0.1 ${unit}`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}
