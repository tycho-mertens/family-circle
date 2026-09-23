import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { circleLifecycle, canWriteMessages, departureAction, canTransferAdmin } =
  await loadTypeScriptModule("src/runtime/circle-lifecycle.ts");
const member = {
  circleId: "c",
  mailboxId: "m",
  role: "member",
  members: ["alice", "bob"],
  isAdmin: false,
  membershipAuthority: "v1",
};

test("a pending commit permits drafts but blocks admin transfer", () => {
  const circle = { ...member, isAdmin: true, pendingCommitEventId: "commit" };
  assert.equal(circleLifecycle(circle).publication, "pending");
  assert.equal(canWriteMessages(circle), true);
  assert.equal(canTransferAdmin(circle), false);
  assert.equal(canTransferAdmin({ ...circle, pendingCommitEventId: undefined }), true);
});

test("departure overrides stale membership and recovery flags", () => {
  const circle = { ...member, deleting: true, recoveryRequired: true, syncError: "retry" };
  assert.equal(circleLifecycle(circle).status, "leaving");
  assert.equal(circleLifecycle({ ...circle, departureConfirmedAt: 100 }).status, "departed");
  assert.equal(canWriteMessages(circle), false);
  assert.equal(departureAction(circle), "none");
});

test("only healthy members can draft messages", () => {
  for (const circle of [
    undefined,
    { ...member, role: "joining" },
    { ...member, role: "removed" },
    { ...member, recoveryRequired: true },
    { ...member, syncError: "failed" },
  ]) {
    assert.equal(canWriteMessages(circle), false);
    assert.equal(canTransferAdmin(circle), false);
  }
  assert.equal(canWriteMessages(member), true);
});

test("leaving waits for admin acknowledgement but sole members can erase locally", () => {
  assert.equal(departureAction(undefined), "none");
  assert.equal(departureAction({ ...member, isAdmin: true }), "handover");
  const handover = { id: "transfer", adminId: "bob" };
  assert.equal(departureAction({ ...member, handover }), "handover");
  assert.equal(
    departureAction({ ...member, handover: { ...handover, confirmed: true } }),
    "request",
  );
  assert.equal(
    departureAction({ ...member, isAdmin: true, members: ["alice"], handover }),
    "erase",
  );
  assert.equal(departureAction({ ...member, role: "joining" }), "erase");
  assert.equal(departureAction({ ...member, role: "removed" }), "erase");
});
