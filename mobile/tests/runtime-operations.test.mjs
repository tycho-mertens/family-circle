import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { createMembershipPublication } = await loadTypeScriptModule(
  "src/runtime/membership-publication.ts",
);
const { createCircleNotifications } = await loadTypeScriptModule(
  "src/runtime/circle-notifications.ts",
);
const { createProfileActions } = await loadTypeScriptModule(
  "src/runtime/profile-actions.ts",
);

test("membership staging skips completed removals and links the Welcome to its commit", async () => {
  let circle = {
    mailboxId: "mailbox",
    members: ["alice"],
    membershipChanges: [
      { type: "remove", memberId: "gone" },
      { type: "add", keyPackage: "AQ==" },
      { type: "refresh" },
    ],
  };
  const queued = [];
  const operations = createMembershipPublication({
    getCircle: () => circle,
    getDeviceId: () => "alice",
    patchCircle: (_id, patch) => {
      circle = { ...circle, ...patch };
    },
    listMembers: async () => ["alice"],
    prepareMembershipChange: async (_id, key, removals) => {
      assert.deepEqual(Array.from(key), [1]);
      assert.equal(removals.length, 0);
      return { commitBytes: new Uint8Array([2]), welcomeBytes: new Uint8Array([3]) };
    },
    queueControl: () => "commit-id",
    queueEnvelope: (_mailbox, envelope) => queued.push(envelope),
    randomId: () => "welcome-id",
    appendSystem() {},
    reportFailure() {},
  });
  await operations.stageNextMembershipChange("circle");
  assert.equal(circle.pendingCommitEventId, "commit-id");
  assert.equal(circle.membershipChanges.length, 1);
  assert.equal(circle.membershipChanges[0].type, "refresh");
  assert.equal(queued[0].commitEventId, "commit-id");
});

test("notification effects wait for commit and reaction cooldowns are scoped to the reactor", () => {
  const effects = [];
  const delivered = [];
  let state = "active";
  let now = 0;
  const notifications = createCircleNotifications({
    getCircle: () => ({ notifications: { chat: true } }),
    getAppState: () => state,
    afterStateCommit: (effect) => effects.push(effect),
    showNotification: (...args) => delivered.push(args),
    reportFailure() {},
    now: () => now,
  });
  notifications.notifyIfBackgrounded("circle", "title", "body");
  assert.equal(effects.length, 0);
  state = "background";
  notifications.notifyIfBackgrounded("circle", "title", "body");
  assert.equal(delivered.length, 0);
  effects.shift()();
  assert.equal(delivered.length, 1);
  assert.equal(notifications.shouldNotifyReaction("circle", "message", "alice"), true);
  assert.equal(notifications.shouldNotifyReaction("circle", "message", "alice"), false);
  assert.equal(notifications.shouldNotifyReaction("circle", "message", "bob"), true);
  now = 30_000;
  assert.equal(notifications.shouldNotifyReaction("circle", "message", "alice"), true);
});

test("profile actions read restored state and avoid broadcasting unchanged values", async () => {
  let identity = { deviceId: "alice", nicknames: { alice: "Alice" }, profilePhotos: {} };
  let circle = {
    circleId: "circle",
    role: "member",
    isAdmin: true,
    circleName: "Family",
  };
  let backups = 0;
  const actions = createProfileActions({
    getCircle: () => circle,
    listCircles: () => [circle],
    patchCircle: (_id, patch) => {
      circle = { ...circle, ...patch };
    },
    getIdentity: () => identity,
    updateNicknames: (update) => {
      identity = { ...identity, nicknames: update(identity.nicknames) };
    },
    updateProfilePhotos: (update) => {
      identity = { ...identity, profilePhotos: update(identity.profilePhotos) };
    },
    refreshMembers: async () => [],
    notifyIfBackgrounded() {},
    appendSystem() {},
    scheduleBackup: () => {
      backups++;
    },
  });
  await actions.setNickname(" Alice ");
  assert.equal(backups, 0);
  identity = { ...identity, nicknames: { alice: "Restored" } };
  await actions.setNickname("Alice");
  assert.equal(backups, 1);
  assert.equal(JSON.parse(circle.pendingBroadcasts[0]).nickname, "Alice");
  circle = { ...circle, isAdmin: false };
  await actions.setCircleName("circle", "Unauthorized");
  assert.equal(circle.circleName, "Family");
});
