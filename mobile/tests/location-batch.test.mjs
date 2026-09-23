import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";
async function harness(count = 101) {
  const state = {
    pins: Array.from({ length: count }, (_, i) => ({
      sessionId: String(i).padStart(64, "0"),
      circleId: "c",
      senderId: "sender",
      fix: null,
    })),
    shares: [],
    pending: [],
    controls: [],
  };
  const batches = [];
  let bad = false;
  let malformed = false;
  const native = {
    loadLocations: async () => {},
    locationCommand: async (raw) => {
      const command = JSON.parse(raw);
      if (command.op === "status") return JSON.stringify(state);
      if (command.op === "receive") {
        if (command.snapshot.invalid) throw Error("invalid signature");
        state.pins.find((p) => p.sessionId === command.snapshot.sessionId).fix = {
          latitude: 1,
          longitude: 2,
        };
      }
      return "true";
    },
  };
  const fetch = async (path, init) => {
    if (path.endsWith("/generation"))
      return new Response(JSON.stringify({ generation: "generation" }));
    assert.ok(path.endsWith("/batch"));
    const body = JSON.parse(init.body);
    batches.push(body);
    return new Response(
      JSON.stringify({
        generation: "generation",
        results: body.sessions.map((item) => ({
          sessionId: malformed ? "wrong" : item.sessionId,
          status: item.revision === 1 ? "unchanged" : "changed",
          snapshot: { sessionId: item.sessionId, revision: 1, invalid: bad },
        })),
      }),
    );
  };
  const globals = {
    process: { env: { EXPO_PUBLIC_RELAY_URL: "http://test" } },
    AbortSignal,
    Uint8Array,
    setTimeout,
  };
  const dependencies = {
    "./relay-access": { relayFetch: fetch },
    "../modules/family-circle-bridge": { default: native },
    "./relay": {
      relayCapabilities: async () => ({ locationBatch: true }),
      uploadEnvelope: async () => {},
    },
    "./backup": { syncBackupNow: async () => {} },
  };
  const location = await loadTypeScriptModule("src/location.ts", {
    globals,
    mocks: dependencies,
  });
  await location.loadLocations("alice");
  return {
    sync: () => location.synchronizeLocations(),
    state,
    batches,
    setBad: (value) => (bad = value),
    setMalformed: (value) => (malformed = value),
  };
}
test("101 pins use bounded batches and reuse only verified local revisions", async () => {
  const h = await harness();
  await h.sync();
  assert.deepEqual(
    h.batches.map((b) => b.sessions.length),
    [100, 1],
  );
  await h.sync();
  assert.ok(h.batches.slice(2).every((b) => b.sessions.every((s) => s.revision === 1)));
  // Restoring an older local state must fetch its snapshot again.
  h.state.pins[0].fix = null;
  await h.sync();
  assert.equal(h.batches[4].sessions[0].revision, undefined);
});
test("rejected snapshots are fetched again and malformed batches fail closed", async () => {
  const h = await harness(1);
  h.setBad(true);
  await h.sync();
  await h.sync();
  assert.equal(h.batches[1].sessions[0].revision, undefined);
  assert.equal(h.state.pins[0].fix, null);
  h.setMalformed(true);
  await assert.rejects(h.sync(), /batch order/);
});
