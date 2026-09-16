const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

// Permit development HTTP only for the explicitly configured service hosts.
function networkSecurityXml() {
  const hosts = new Set();
  for (const name of ['EXPO_PUBLIC_RELAY_URL', 'EXPO_PUBLIC_MAP_URL']) {
    const value = process.env[name];
    if (!value) continue;
    const url = new URL(value);
    if (url.protocol === 'http:') hosts.add(url.hostname);
  }
  const escape = (value) => value.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c]);
  const domains = [...hosts].map((host) =>
    `<domain includeSubdomains="false">${escape(host)}</domain>`).join('');
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<network-security-config><base-config cleartextTrafficPermitted="false"/>' +
    (domains ? `<domain-config cleartextTrafficPermitted="true">${domains}</domain-config>` : '') +
    '</network-security-config>\n';
}

module.exports = function withLanNetworkSecurity(config) {
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application[0];
    application.$['android:networkSecurityConfig'] = '@xml/family_circle_network_security';
    return mod;
  });
  return withDangerousMod(config, ['android', async (mod) => {
    const directory = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'family_circle_network_security.xml'), networkSecurityXml());
    return mod;
  }]);
};
