import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { circleTransition, remainingAdmin } = await loadTypeScriptModule(
  "src/runtime/circle-transitions.ts",
);
const { circleLifecycle, canTransferAdmin, departureAction } = await loadTypeScriptModule(
  "src/runtime/circle-lifecycle.ts",
);
const member = {
  circleId: "family",
  mailboxId: "mailbox",
  role: "member",
  isAdmin: true,
  adminId: "alice",
  members: ["alice", "bob"],
  membershipAuthority: "v1",
};
const apply = (circle, event) => ({
  ...circle,
  ...circleTransition(circle, event, "alice"),
});

test("an accepted Welcome clears obsolete join and recovery state", () => {
  const before = {
    ...member,
    role: "joining",
    joinNonce: "secret",
    joinRequestedAt: 1,
    recoveryRequired: true,
    syncError: "retry",
    authorityAdminId: "bob",
  };
  const joined = apply(before, { type: "joined" });
  assert.equal(circleLifecycle(joined).status, "member");
  for (const key of ["joinNonce", "joinRequestedAt", "syncError", "authorityAdminId"])
    assert.equal(joined[key], undefined);
  assert.equal(joined.adminId, "bob");
  assert.equal(joined.isAdmin, false);
  assert.equal(joined.membershipAuthority, "v1");
  assert.equal(before.joinNonce, "secret");
});

test("handover removes local admin rights and requires acknowledgement before departure", () => {
  const circle = apply(member, {
    type: "handover-started",
    id: "transfer",
    adminId: "bob",
  });
  assert.equal(circle.isAdmin, false);
  assert.equal(circle.adminId, "bob");
  assert.equal(canTransferAdmin(circle), false);
  assert.equal(departureAction(circle), "handover");
  assert.equal(
    departureAction({ ...circle, handover: { ...circle.handover, confirmed: true } }),
    "request",
  );
});

test("departure clears unsent work and admin selection excludes departing members", () => {
  const adminId = remainingAdmin(member, member.members, ["alice"], "alice");
  const circle = apply(
    {
      ...member,
      pendingChats: ["draft"],
      pendingBroadcasts: ["profile"],
      membershipChanges: [{ type: "refresh" }],
    },
    { type: "leave-requested", departingMembers: ["alice"], adminId },
  );
  assert.equal(circleLifecycle(circle).status, "leaving");
  assert.equal(circle.isAdmin, false);
  assert.equal(circle.adminId, "bob");
  for (const key of ["pendingChats", "pendingBroadcasts", "membershipChanges"])
    assert.equal(circle[key].length, 0);
  assert.equal(remainingAdmin(member, member.members, [], "alice"), "alice");
});

test("commit confirmation releases publication and recovery without discarding drafts", () => {
  const circle = apply(
    {
      ...member,
      pendingCommitEventId: "commit",
      recoveryRequired: true,
      pendingChats: ["draft"],
    },
    { type: "commit-confirmed" },
  );
  assert.equal(circleLifecycle(circle).publication, "ready");
  assert.equal(circle.pendingChats[0], "draft");
});

test("a delayed Welcome cannot cancel an already requested departure", () => {
  const before = { ...member, deleting: true, leaveEpoch: 3, recoveryRequired: true };
  const joined = apply(before, { type: "joined" });
  assert.equal(circleLifecycle(joined).status, "leaving");
  assert.equal(joined.leaveEpoch, 3);
  assert.equal(departureAction(joined), "none");
});
