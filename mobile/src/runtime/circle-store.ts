import type { CircleInfo } from "./circle-types";

/** Owns the Circle map. A patch cannot recreate a Circle removed during async work. */
export function createCircleStore(onChange: () => void) {
  let circles: Record<string, CircleInfo> = {};
  const replace = (next: Record<string, CircleInfo>) => {
    circles = next;
    onChange();
  };
  return {
    get: (id: string): CircleInfo | undefined => circles[id],
    list: () => Object.values(circles),
    snapshot: () => circles,
    replace,
    put(circle: CircleInfo) {
      replace({ ...circles, [circle.circleId]: circle });
    },
    patch(id: string, patch: Partial<CircleInfo>) {
      const current = circles[id];
      if (!current) return;
      replace({ ...circles, [id]: { ...current, ...patch, circleId: id } });
    },
    remove(id: string) {
      if (!circles[id]) return;
      const next = { ...circles };
      delete next[id];
      replace(next);
    },
  };
}
