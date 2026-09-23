import test from "node:test";
import assert from "node:assert/strict";
import { possiblyOffline } from "../src/location-freshness.ts";
test("chosen cadence plus 25%, fresh updates and legacy snapshots", () => {
  const fix = { updatedAt: 1000000, updateInterval: 120000 };
  assert.equal(possiblyOffline(fix, 1150000), false);
  assert.equal(possiblyOffline(fix, 1150001), true);
  assert.equal(possiblyOffline({ ...fix, updatedAt: 1150001 }, 1150001), false);
  assert.equal(possiblyOffline({ ...fix, updateInterval: 1800000 }, 1150001), false);
  assert.equal(possiblyOffline({}, 1150001), false);
  assert.equal(possiblyOffline(null, 1150001), false);
  assert.equal(possiblyOffline({ ...fix, updatedAt: 2000000 }, 1150001), false);
});
