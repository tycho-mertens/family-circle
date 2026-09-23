import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { SyncCoordinator } = await loadTypeScriptModule("src/sync-coordinator.ts");
test("notifications during catch-up coalesce into one ordered follow-up", async () => {
  let release;
  let count = 0;
  let concurrent = 0;
  let maximum = 0;
  const gate = new Promise((resolve) => (release = resolve));
  const sync = new SyncCoordinator(async () => {
    count++;
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    if (count === 1) await gate;
    concurrent--;
  });
  const first = sync.request();
  await Promise.resolve();
  for (let i = 0; i < 100; i++) sync.request();
  release();
  await first;
  assert.equal(count, 2);
  assert.equal(maximum, 1);
});
test("a failed synchronization permits a later retry", async () => {
  let calls = 0;
  const sync = new SyncCoordinator(async () => {
    if (++calls === 1) throw Error("offline");
  });
  await assert.rejects(sync.request(), /offline/);
  await sync.request();
  assert.equal(calls, 2);
});
