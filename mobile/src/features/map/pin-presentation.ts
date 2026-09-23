import { distanceMeters } from "../../distance";
import type { LocationPin } from "../../location";

export function age(at: number, now: number) {
  const total = Math.max(0, Math.floor((now - at) / 5000) * 5);
  if (total === 0) return "Just now";
  const seconds = total % 60,
    minutes = Math.floor(total / 60) % 60,
    hours = Math.floor(total / 3600) % 24,
    days = Math.floor(total / 86400);
  return `${days ? `${days} d ` : ""}${total >= 3600 ? `${hours} hr ` : ""}${total >= 60 ? `${minutes} min ` : ""}${seconds} sec ago`;
}
// Nearby members can otherwise occupy the same native marker view. This
// changes only the annotation's screen offset, never its true coordinate.
export function markerOffset(pin: LocationPin, pins: LocationPin[]): [number, number] {
  const nearby = pins
    .filter((other) => other.fix && pin.fix && distanceMeters(pin.fix, other.fix) < 100)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  if (nearby.length < 2) return [0, 0];
  const index = nearby.findIndex((other) => other.sessionId === pin.sessionId);
  const angle = (Math.PI * 2 * index) / nearby.length - Math.PI / 2;
  return [Math.round(Math.cos(angle) * 28), Math.round(Math.sin(angle) * 28)];
}
