import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
async function generate(env) {
  let xml = "";
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync("plugins/with-lan-network-security.js", "utf8"), {
    module,
    URL,
    process: { env },
    require: (name) => {
      if (name === "node:path") return path;
      if (name === "node:fs")
        return {
          mkdirSync() {},
          writeFileSync(file, value) {
            if (file.includes("/main/")) xml = value;
          },
        };
      if (name === "expo/config-plugins")
        return {
          withAndroidManifest: (config, action) => action(config),
          withDangerousMod: (config, [_platform, action]) => ({
            ...config,
            finish: () => action(config),
          }),
        };
      throw Error(name);
    },
  });
  const config = module.exports({
    modResults: { manifest: { application: [{ $: {} }] } },
    modRequest: { platformProjectRoot: "/unused" },
  });
  await config.finish();
  return xml;
}
test("HTTPS deployments grant no HTTP exceptions", async () => {
  const xml = await generate({ EXPO_PUBLIC_RELAY_URL: "https://circle.example" });
  assert.match(xml, /base-config cleartextTrafficPermitted="false"/);
  assert.doesNotMatch(xml, /cleartextTrafficPermitted="true"/);
});
test("LAN build permits only exact configured hosts", async () => {
  const xml = await generate({
    EXPO_PUBLIC_RELAY_URL: "http://192.168.0.242:5080",
    EXPO_PUBLIC_MAP_URL: "http://192.168.0.242:8090",
  });
  assert.match(xml, /<domain includeSubdomains="false">192\.168\.0\.242<\/domain>/);
  assert.equal((xml.match(/<domain /g) || []).length, 1);
  assert.match(xml, /base-config cleartextTrafficPermitted="false"/);
});
test("public HTTP relay configuration fails instead of disabling transport protection", async () => {
  await assert.rejects(
    generate({ EXPO_PUBLIC_RELAY_URL: "http://circle.example" }),
    /must use HTTPS/,
  );
  await assert.rejects(generate({ EXPO_PUBLIC_RELAY_URL: "http://8.8.8.8" }), /must use HTTPS/);
});
