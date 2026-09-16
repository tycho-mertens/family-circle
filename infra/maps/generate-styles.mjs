import { layers, namedFlavor } from "@protomaps/basemaps";
import { mkdirSync, writeFileSync } from "node:fs";
const base = process.env.PUBLIC_MAP_URL?.replace(/\/$/, "");
if (!base || !/^https?:\/\//.test(base))
  throw new Error("Set PUBLIC_MAP_URL to the URL reachable by your phones");
const maxzoom = Number(process.env.MAP_MAX_ZOOM ?? 15);
mkdirSync("public/styles", { recursive: true });
for (const theme of ["light", "dark"]) {
  const style = {
    version: 8,
    name: `Family Circle ${theme}`,
    glyphs: `${base}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${base}/sprites/v4/${theme}`,
    sources: {
      protomaps: {
        type: "vector",
        tiles: [`${base}/tiles/world/{z}/{x}/{y}.mvt`],
        minzoom: 0,
        maxzoom,
        attribution: "© OpenStreetMap contributors · Protomaps",
      },
    },
    layers: layers("protomaps", namedFlavor(theme), { lang: "en" }),
  };
  writeFileSync(`public/styles/${theme}.json`, JSON.stringify(style));
}
console.log(`Generated local-only styles for ${base} (source max zoom ${maxzoom})`);
