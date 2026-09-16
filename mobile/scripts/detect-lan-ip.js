#!/usr/bin/env node
// Auto-connect to the relay: writes mobile/.env with this machine's
// current LAN IP so the app doesn't need the relay URL typed in by hand.
// Runs automatically before `npm run android` / `npm start` (see
// package.json's "pre*" hooks) — re-run any time this machine's IP
// changes (new WiFi network, DHCP lease renewal, etc.).
//
// Assumes the phone and development machine are on the same Wi-Fi network.
// For USB-only setups without a shared WiFi network, set
// EXPO_PUBLIC_RELAY_URL by hand in mobile/.env instead (e.g. after
// `adb reverse tcp:5080 tcp:5080`, use http://127.0.0.1:5080) and delete
// this script's write, or just re-run it and edit the result.

const fs = require("fs");
const os = require("os");
const path = require("path");

const RELAY_PORT = process.env.FAMILY_CIRCLE_RELAY_PORT || "5080";
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
      "Set EXPO_PUBLIC_RELAY_URL by hand in mobile/.env if auto-detection keeps failing.",
  );
  process.exit(0); // don't fail the whole `npm run android` over this
}

const relayUrl = `http://${ip}:${RELAY_PORT}`;
const mapUrl = `http://${ip}:${process.env.FAMILY_CIRCLE_MAP_PORT || "8090"}`;
const line = `EXPO_PUBLIC_RELAY_URL=${relayUrl}\nEXPO_PUBLIC_MAP_URL=${mapUrl}\n`;

let existing = "";
try {
  existing = fs.readFileSync(ENV_PATH, "utf8");
} catch {
  // no .env yet, that's fine
}

const otherLines = existing
  .split("\n")
  .filter((l) => l && !l.startsWith("EXPO_PUBLIC_RELAY_URL=") && !l.startsWith("EXPO_PUBLIC_MAP_URL="));
fs.writeFileSync(ENV_PATH, [...otherLines, line].join("\n"));

console.log(`[detect-lan-ip] EXPO_PUBLIC_RELAY_URL=${relayUrl} (written to mobile/.env)`);
console.log(
  "[detect-lan-ip] Make sure the relay is running with --urls http://0.0.0.0:" +
    RELAY_PORT +
    " — 'dotnet run' alone only listens on localhost.",
);
