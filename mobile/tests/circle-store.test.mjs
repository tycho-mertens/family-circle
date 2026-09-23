import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { createCircleStore } = await loadTypeScriptModule("src/runtime/circle-store.ts");
const member = {
  circleId: "family",
  mailboxId: "mailbox",
  role: "member",
  isAdmin: false,
  members: ["alice", "bob"],
};

test("late patches cannot resurrect a removed Circle or change its ID", () => {
  let notifications = 0;
  const store = createCircleStore(() => notifications++);
  store.put(member);
  store.patch("family", { circleId: "other", circleName: "Family" });
  assert.equal(store.get("family").circleId, "family");
  store.remove("family");
  store.patch("family", { members: ["alice"] });
  assert.equal(store.get("family"), undefined);
  assert.equal(store.list().length, 0);
  assert.equal(notifications, 3);
});

test("readers see restored state while earlier snapshots remain usable", () => {
  const store = createCircleStore(() => {});
  const get = store.get;
  store.put(member);
  const before = store.snapshot();
  store.patch("family", { isAdmin: true });
  assert.equal(before.family.isAdmin, false);
  store.replace(before);
  assert.equal(get("family").isAdmin, false);
});
