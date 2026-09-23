const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

// Standalone LAN demos need the same local-server access as debug builds.
// Never grant a blanket HTTP exception or allow public HTTP hosts.
module.exports = function withLanNetworkSecurity(config) {
  const hosts = [
    ...new Set(
      ["EXPO_PUBLIC_RELAY_URL", "EXPO_PUBLIC_MAP_URL"].flatMap((key) => {
        const value = process.env[key];
        if (!value) return [];
        const url = new URL(value);
        if (url.protocol !== "http:") return [];
        const host = url.hostname;
        const octets = host.split(".").map(Number);
        const privateIp =
          octets.length === 4 &&
          octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
          (octets[0] === 10 ||
            octets[0] === 127 ||
            (octets[0] === 192 && octets[1] === 168) ||
            (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
        if (host !== "localhost" && !privateIp)
          throw new Error(`${key} must use HTTPS outside a private LAN demo`);
        return [host];
      }),
    ),
  ];
  config = withAndroidManifest(config, (config) => {
    config.modResults.manifest.application[0].$["android:networkSecurityConfig"] =
      "@xml/family_circle_network_security";
    return config;
  });
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const folder = path.join(config.modRequest.platformProjectRoot, "app/src/main/res/xml");
      fs.mkdirSync(folder, { recursive: true });
      const exceptions = hosts.length
        ? `<domain-config cleartextTrafficPermitted="true">${hosts.map((host) => `<domain includeSubdomains="false">${host}</domain>`).join("")}</domain-config>`
        : "";
      fs.writeFileSync(
        path.join(folder, "family_circle_network_security.xml"),
        `<?xml version="1.0" encoding="utf-8"?><network-security-config><base-config cleartextTrafficPermitted="false"/>${exceptions}</network-security-config>`,
      );
      // Preserve Expo's usual Metro access in debug builds only.
      const debugFolder = path.join(config.modRequest.platformProjectRoot, "app/src/debug/res/xml");
      fs.mkdirSync(debugFolder, { recursive: true });
      fs.writeFileSync(
        path.join(debugFolder, "family_circle_network_security.xml"),
        '<?xml version="1.0" encoding="utf-8"?><network-security-config><base-config cleartextTrafficPermitted="true"/></network-security-config>',
      );
      return config;
    },
  ]);
};
