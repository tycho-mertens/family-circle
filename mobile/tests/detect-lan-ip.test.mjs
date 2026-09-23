import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = readFileSync("scripts/detect-lan-ip.js", "utf8");

function detect(existing, interfaces, env = {}) {
  let written;
  let exitCode;
  const stopped = Symbol("exit");
  try {
    vm.runInNewContext(source, {
      __dirname: "/project/mobile/scripts",
      console: { log() {}, warn() {} },
      process: {
        env,
        exit(code) {
          exitCode = code;
          throw stopped;
        },
      },
      require(name) {
        if (name === "path") return path;
        if (name === "os") return { networkInterfaces: () => interfaces };
        if (name === "fs")
          return {
            readFileSync: () => existing,
            writeFileSync(file, contents) {
              assert.equal(file, "/project/mobile/.env");
              written = contents;
            },
          };
        throw new Error(`Unexpected module: ${name}`);
      },
    });
  } catch (error) {
    if (error !== stopped) throw error;
  }
  return { written, exitCode };
}

const address = (address, internal = false) => ({ family: "IPv4", address, internal });

test("replaces both hosted URLs with the Wi-Fi IP and preserves other settings", () => {
  const existing =
    "# Local settings\r\nEXPO_PUBLIC_MAP_URL=https://maps.example.org\r\n" +
    "export EXPO_PUBLIC_RELAY_URL = https://relay.example.org\r\nOTHER_SETTING=keep\r\n";
  const { written } = detect(existing, {
    lo: [address("127.0.0.1", true)],
    docker0: [address("172.17.0.1")],
    wlp13s0: [address("192.168.0.242")],
  });
  assert.equal(
    written,
    "# Local settings\nOTHER_SETTING=keep\n" +
      "EXPO_PUBLIC_RELAY_URL=http://192.168.0.242:5080\n" +
      "EXPO_PUBLIC_MAP_URL=http://192.168.0.242:8090\n",
  );
});

test("supports port overrides and produces the same settings on repeated runs", () => {
  const interfaces = { eth0: [address("10.0.0.42")] };
  const env = { FAMILY_CIRCLE_RELAY_PORT: "5090", FAMILY_CIRCLE_MAP_PORT: "8095" };
  const first = detect("", interfaces, env).written;
  assert.match(first, /EXPO_PUBLIC_RELAY_URL=http:\/\/10\.0\.0\.42:5090\n/);
  assert.match(first, /EXPO_PUBLIC_MAP_URL=http:\/\/10\.0\.0\.42:8095\n/);
  assert.equal(detect(first, interfaces, env).written, first);
});

test("leaves the existing configuration alone when no external IPv4 address is available", () => {
  const result = detect("EXPO_PUBLIC_RELAY_URL=http://192.168.0.42:5080\n", {
    lo: [address("127.0.0.1", true)],
    eth0: [{ family: "IPv6", address: "fe80::1", internal: false }],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.written, undefined);
});
