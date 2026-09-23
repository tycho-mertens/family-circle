#!/usr/bin/env node
// Write the current LAN relay and map URLs before start/android builds.
// Re-run after changing networks, then regenerate the map styles.
// Phone and dev machine must share a LAN; for USB forwarding, set the URL
// after this script runs and before bundling.

const fs = require("fs");
const os = require("os");
const path = require("path");

const RELAY_PORT = process.env.FAMILY_CIRCLE_RELAY_PORT || "5080";
const MAP_PORT = process.env.FAMILY_CIRCLE_MAP_PORT || "8090";
const ENV_PATH = path.join(__dirname, "..", ".env");

function findLanIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      candidates.push({ name, address: addr.address });
    }
  }
  if (candidates.length === 0) return null;

  // Prefer a Wi-Fi-looking interface name over things like Docker/virtual
  // bridges, but fall back to whatever's available.
  const wifiLike = candidates.find((c) => /wl|wifi|en0|wlan/i.test(c.name));
  return (wifiLike || candidates[0]).address;
}

const ip = findLanIp();

if (!ip) {
  console.warn(
    "[detect-lan-ip] Could not find a LAN IPv4 address. Is this machine on WiFi? " +
      "Set EXPO_PUBLIC_RELAY_URL and EXPO_PUBLIC_MAP_URL in mobile/.env if auto-detection keeps failing.",
  );
  process.exit(0); // don't fail the whole `npm run android` over this
}

const relayUrl = `http://${ip}:${RELAY_PORT}`;
const mapUrl = `http://${ip}:${MAP_PORT}`;

let existing = "";
try {
  existing = fs.readFileSync(ENV_PATH, "utf8");
} catch {
  // no .env yet, that's fine
}

const otherLines = existing
  .split(/\r?\n/)
  .filter((line) => line && !/^\s*(?:export\s+)?EXPO_PUBLIC_(RELAY|MAP)_URL\s*=/.test(line));
fs.writeFileSync(
  ENV_PATH,
  [...otherLines, `EXPO_PUBLIC_RELAY_URL=${relayUrl}`, `EXPO_PUBLIC_MAP_URL=${mapUrl}`, ""].join(
    "\n",
  ),
);

console.log(`[detect-lan-ip] EXPO_PUBLIC_RELAY_URL=${relayUrl} (written to mobile/.env)`);
console.log(`[detect-lan-ip] EXPO_PUBLIC_MAP_URL=${mapUrl} (written to mobile/.env)`);
console.log(
  "[detect-lan-ip] Start the local services with scripts/start-services.sh from the repository root.",
);
