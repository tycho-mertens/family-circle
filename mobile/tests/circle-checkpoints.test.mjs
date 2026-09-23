import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { createCircleCheckpoints } = await loadTypeScriptModule(
  "src/runtime/circle-checkpoints.ts",
);
const plain = (value) => JSON.parse(JSON.stringify(value));

function checkpointStore(circles = {}) {
  const circlesRef = { current: circles };
  const checkpoints = createCircleCheckpoints({
    getCircles: () => circlesRef.current,
    replaceCircles: (next) => {
      circlesRef.current = next;
    },
  });
  return { circlesRef, checkpoints };
}

const member = {
  circleId: "family",
  mailboxId: "mailbox",
  role: "member",
  isAdmin: true,
  members: ["alice", "bob"],
  membershipAuthority: "v1",
  adminId: "alice",
};

test("checkpoint round trip preserves pending membership, drafts, and mailbox replay protection", () => {
  const circle = {
    ...member,
    circleName: "Family",
    pendingChats: [{ messageId: "draft", text: "hello", sentAt: 123 }],
    pendingBroadcasts: ['{"type":"nickname","nickname":"Alice"}'],
    membershipChanges: [{ type: "remove", memberId: "bob" }],
    pendingCommitEventId: "commit",
    handover: { id: "transfer", adminId: "bob", confirmed: false },
    pendingJoinRequestNames: { request: "Charlie" },
    pendingJoinRequestMemberIds: { request: "charlie" },
    blockedAutoJoinIds: ["former-member"],
  };
  const { circlesRef, checkpoints } = checkpointStore({ family: circle });
  checkpoints.lastSeenSequenceId.current.set("family", 42);
  for (const name of [
    "myOwnEventIds",
    "processedKeyPackageIds",
    "triedWelcomeIds",
    "processedLeaveIds",
    "processedRejoinRequestIds",
  ])
    checkpoints[name].current.set("family", new Set([`${name}-event`]));
  checkpoints.pendingJoinKeyPackages.current.set(
    "family",
    new Map([["request", new Uint8Array([0, 127, 255])]]),
  );
  checkpoints.pendingRejoinKeyPackages.current.set(
    "family",
    new Map([["bob", new Uint8Array([1, 2, 3])]]),
  );
  checkpoints.awaitingRejoinNonce.current.set("family", "rejoin-secret");

  // JSON is the actual persistence boundary: Maps and Sets cannot leak into it.
  const saved = plain(checkpoints.toBackedUpCircles(circlesRef.current));
  const restored = checkpointStore();
  restored.checkpoints.restoreCircles(saved);
  assert.deepEqual(
    plain(restored.checkpoints.toBackedUpCircles(restored.circlesRef.current)),
    saved,
  );
  assert.deepEqual(
    [...restored.checkpoints.pendingJoinKeyPackages.current.get("family").get("request")],
    [0, 127, 255],
  );
  assert.deepEqual(plain(restored.circlesRef.current.family.pendingJoinRequests), [
    "request",
  ]);
  assert.deepEqual(plain(restored.circlesRef.current.family.pendingRejoinRequests), [
    "bob",
  ]);
  assert.equal(restored.checkpoints.awaitingRejoinWelcome.current.has("family"), true);
});

test("rollback removes requests and cursors created after the saved checkpoint", () => {
  const { circlesRef, checkpoints } = checkpointStore({ family: member });
  const before = plain(checkpoints.toBackedUpCircles(circlesRef.current));
  checkpoints.lastSeenSequenceId.current.set("other-circle", 99);
  checkpoints.pendingJoinKeyPackages.current.set(
    "family",
    new Map([["new-request", new Uint8Array([1])]]),
  );
  checkpoints.awaitingRejoinNonce.current.set("other-circle", "stale");
  checkpoints.awaitingRejoinWelcome.current.add("other-circle");
  circlesRef.current = { "other-circle": { ...member, circleId: "other-circle" } };

  checkpoints.restoreCircles(before);
  assert.deepEqual(Object.keys(circlesRef.current), ["family"]);
  assert.equal(checkpoints.lastSeenSequenceId.current.has("other-circle"), false);
  assert.equal(checkpoints.pendingJoinKeyPackages.current.get("family").size, 0);
  assert.equal(checkpoints.awaitingRejoinNonce.current.size, 0);
  assert.equal(checkpoints.awaitingRejoinWelcome.current.size, 0);
});

test("legacy checkpoints default missing roles and retain an already known roster", () => {
  const { circlesRef, checkpoints } = checkpointStore({ family: member });
  checkpoints.restoreCircles([
    { circleId: "family", mailboxId: "mailbox", isCreator: true },
  ]);
  assert.equal(circlesRef.current.family.role, "member");
  assert.deepEqual(circlesRef.current.family.members, ["alice", "bob"]);
  assert.equal(checkpoints.lastSeenSequenceId.current.get("family"), 0);
  assert.equal(checkpoints.myOwnEventIds.current.get("family").size, 0);
});

test("restoring an empty identity clears every previous Circle checkpoint", () => {
  const { circlesRef, checkpoints } = checkpointStore({ family: member });
  checkpoints.restoreCircles([
    {
      ...member,
      isCreator: member.isAdmin,
      ownEventIds: ["event"],
      awaitingRejoinNonce: "secret",
    },
  ]);
  checkpoints.restoreCircles([]);
  assert.deepEqual(Object.keys(circlesRef.current), []);
  for (const value of Object.values(checkpoints))
    if (value && typeof value === "object" && "current" in value)
      assert.equal(value.current.size, 0);
});

test("admin naming preserves the legacy checkpoint format across handover and restart", () => {
  const { circlesRef, checkpoints } = checkpointStore();
  checkpoints.restoreCircles([
    { circleId: "family", mailboxId: "mailbox", isCreator: true },
  ]);
  assert.equal(circlesRef.current.family.isAdmin, true);
  assert.equal(Object.hasOwn(circlesRef.current.family, "isCreator"), false);
  circlesRef.current.family = {
    ...circlesRef.current.family,
    isAdmin: false,
    adminId: "bob",
  };
  const saved = plain(checkpoints.toBackedUpCircles(circlesRef.current));
  assert.equal(saved[0].isCreator, false);
  assert.equal(Object.hasOwn(saved[0], "isAdmin"), false);
  checkpoints.restoreCircles(saved);
  assert.equal(circlesRef.current.family.isAdmin, false);
  assert.equal(circlesRef.current.family.adminId, "bob");
});
