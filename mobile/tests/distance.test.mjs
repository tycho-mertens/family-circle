import test from "node:test";
import assert from "node:assert/strict";
import { distanceMeters, formatDistance } from "../src/distance.ts";

test("same point, equator reference, date line and antipodes", () => {
  assert.equal(distanceMeters({ latitude: 52, longitude: 21 }, { latitude: 52, longitude: 21 }), 0);
  const oneDegree = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
  assert.ok(Math.abs(oneDegree - 111195.08) < 1);
  const acrossDateLine = distanceMeters(
    { latitude: 0, longitude: 179.5 },
    { latitude: 0, longitude: -179.5 },
  );
  assert.ok(Math.abs(acrossDateLine - oneDegree) < 0.01);
  assert.ok(
    Math.abs(
      distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 }) - 20015114.4,
    ) < 1,
  );
});
test("units convert to miles rather than just changing the label", () => {
  assert.equal(formatDistance(1609.344, "mi"), "1 mi");
  assert.equal(formatDistance(1609.344, "km"), "1.6 km");
  assert.equal(formatDistance(0, "mi"), "<0.1 mi");
  assert.equal(formatDistance(99, "km"), "<0.1 km");
});
