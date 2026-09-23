import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const unauthorized = "ERR_MLS_UNAUTHORIZED_COMMIT";
const malformed = "ERR_MLS_INVALID_CONTROL";
const clone = (value) => JSON.parse(JSON.stringify(value));
const failure = (code) => Object.assign(new Error("private native details"), { code });

// Use the real sync/control handlers, checkpoint adapter, transaction journal,
// metadata encoder and outbox. Only native operations, application delivery,
// notifications and relay transport are substitutes. Native state deliberately
// changes before a rejection, so catching and skipping inside the transaction
// cannot pass the rollback assertions.
async function harness({
  code = unauthorized,
  disk = {},
  network = { uploads: [], attempts: [] },
  firstIsValid = false,
} = {}) {
  let nativeState = clone(disk.native ?? { epoch: 1, members: ["alice", "bob"], touched: 0 });
  let rollback;
  let reject = !firstIsValid;
  let failSave;
  let failAbort = false;
  let failMemberRefresh;
  const warnings = [];
  let circles = {
    family: {
      circleId: "family", mailboxId: "mailbox", role: "member",
      isAdmin: false, adminId: "bob", membershipAuthority: "v1",
      members: ["alice", "bob"], pendingChats: ["queued draft"],
    },
  };
  let timeline = [];
  const globals = { console: { warn: (line) => warnings.push(line) } };
  const { createCircleCheckpoints } = await loadTypeScriptModule(
    "src/runtime/circle-checkpoints.ts", { globals },
  );
  const checkpoints = createCircleCheckpoints({
    getCircles: () => circles,
    replaceCircles: (saved) => { circles = saved; },
  });
  const snapshot = () => clone({
    nicknames: {}, timeline,
    circles: checkpoints.toBackedUpCircles(circles),
  });
  const restore = (saved) => {
    checkpoints.restoreCircles(saved.circles);
    timeline = clone(saved.timeline ?? []);
  };
  const native = {
    configureChatState: async () => {},
    beginChatTransaction: async () => { rollback = clone(nativeState); },
    abortChatTransaction: async () => {
      if (failAbort) throw failure("EIO");
      nativeState = clone(rollback);
    },
    commitChatTransaction: async (bytes) => {
      const metadata = JSON.parse(new TextDecoder().decode(bytes));
      if (failSave?.when(metadata)) {
        const error = failSave.error;
        failSave = undefined;
        throw error;
      }
      disk.native = clone(nativeState);
      disk.metadata = metadata;
    },
  };
  const { createChatPersistence } = await loadTypeScriptModule(
    "src/persistence/chat.ts", { globals },
  );
  const persistence = createChatPersistence(native, {
    isMailboxChanged: () => false,
    uploadEnvelope: async (_mailbox, envelope) => {
      assert.ok(disk.metadata.outbox.some((entry) => entry.eventId === envelope.eventId),
        "publication must follow a durable checkpoint");
      network.uploads.push(envelope.eventId);
      return 100 + network.uploads.length;
    },
  });
  if (disk.metadata) restore(disk.metadata);
  persistence.bindRuntime({ snapshot, restore, committed() {}, acknowledged() {} });
  await persistence.configureLocal(new Uint8Array(32), disk.metadata ?? snapshot());

  const patchCircle = (id, patch) => { circles[id] = { ...circles[id], ...patch }; };
  const identity = {
    deviceIdRef: { current: "alice" }, nicknamesRef: { current: {} },
    profilePhotosRef: { current: {} },
  };
  const envelope = (sequenceId, kind, epoch) => ({
    sequenceId, eventId: `incoming-${sequenceId}`, kind, epoch,
    nonce: new Uint8Array([0]), ciphertext: new Uint8Array([sequenceId]),
  });
  const envelopes = [
    envelope(1, "commit", 1),
    envelope(2, "commit", firstIsValid ? 2 : 1),
    envelope(3, "application", firstIsValid ? 3 : 2),
  ];
  const bridge = {
    processCommit: async (_slot, _circle, bytes) => {
      network.attempts.push(bytes[0]);
      if (bytes[0] === 1) {
        nativeState.touched++;
        if (reject) throw failure(code);
      }
      nativeState.epoch++;
      if (bytes[0] === 2) nativeState.members.push("carol");
    },
    decryptEvent: async (_slot, _circle, incoming) => {
      assert.equal(nativeState.epoch, incoming.epoch, "required commit must precede decryption");
      return {
        senderDeviceId: "bob",
        plaintext: new TextEncoder().encode(JSON.stringify({ type: "chat", text: "legitimate" })),
      };
    },
    encryptEvent: async () => ({
      eventId: "draft", epoch: nativeState.epoch,
      nonce: new Uint8Array([0]), ciphertext: new Uint8Array([9]),
    }),
  };
  const backup = { ...persistence, syncBackupNow: async () => {} };
  // Separate VM loads must share the same internal error class, as they do in
  // the app's module graph. This is real code, not a replacement classifier.
  const rejection = await loadTypeScriptModule("src/runtime/rejected-commit.ts");
  const mocks = {
    "./rejected-commit": rejection,
    "../backup": backup, "../bridge": bridge,
    "../relay": {
      fetchEnvelopes: async (_mailbox, after) => envelopes.filter((item) => item.sequenceId > after),
    },
    "../location": { receiveLocationControl: async () => {} },
    "./identity": { MAX_NICKNAME_LEN: 100 },
  };
  const { createControlHandler } = await loadTypeScriptModule(
    "src/runtime/control-handler.ts", { globals, mocks },
  );
  const { handleControl } = createControlHandler({
    checkpoints, identity, patchCircle,
    appendSystem() {}, enqueueMembershipChange() {}, broadcastToCircle: async () => {},
    refreshMembers: async () => nativeState.members,
    setNotice() {}, forgetCircle() {}, notifyIfBackgrounded() {},
    notifyNewMembers: async (id) => {
      if (failMemberRefresh) {
        const error = failMemberRefresh;
        failMemberRefresh = undefined;
        throw error;
      }
      patchCircle(id, { members: [...nativeState.members] });
    },
  });
  const { createCircleSync } = await loadTypeScriptModule(
    "src/runtime/circle-sync.ts", { globals, mocks },
  );
  const sync = createCircleSync({
    ...checkpoints, identity, patchCircle, handleControl,
    listCircles: () => Object.values(circles), getCircle: (id) => circles[id],
    handleApplication: async (_id, _circle, _sender, payload) => { timeline = [...timeline, payload]; },
    appendSystem() {}, eraseCircle: async () => true, putCircle() {},
    getNotice: () => null, setNotice() {}, queueControl: () => "control",
    enqueueMembershipChange() {}, stageNextMembershipChange: async () => {},
    queueEnvelope: persistence.queueEnvelope,
  });
  return {
    disk, network, warnings, poll: sync.pollAll, persistence,
    get state() { return clone(nativeState); },
    get circle() { return circles.family; },
    get cursor() { return checkpoints.lastSeenSequenceId.current.get("family") ?? 0; },
    allowFirstCommit: () => { reject = false; },
    rejectFirstCommit: () => { reject = true; },
    failRollback: () => { failAbort = true; },
    failAfterNativeCommit: (error) => { failMemberRefresh = error; },
    failCheckpointAt: (cursor, error = failure("ENOSPC")) => {
      failSave = { error, when: (saved) => saved.circles[0].lastSeenSequenceId === cursor };
    },
  };
}

for (const code of [unauthorized, malformed]) {
  test(`${code}: rollback rejection, process later traffic, resume sending and survive restart`, async () => {
    let h = await harness({ code });
    await h.poll();
    assert.equal(h.cursor, 3, "permanent rejection must not strand later traffic");
    assert.equal(h.state.touched, 0, "rejected processing must be rolled back before advancing");
    assert.equal(h.state.epoch, 2);
    assert.deepEqual(h.state.members, ["alice", "bob", "carol"]);
    assert.deepEqual(h.circle.members, h.state.members);
    assert.equal(h.disk.metadata.timeline[0].text, "legitimate");
    assert.equal(h.circle.syncError, undefined);
    assert.deepEqual(clone(h.circle.rejectedControl), { sequenceId: 1, code, count: 1 });
    assert.deepEqual(h.network.uploads, ["draft"]);
    assert.ok(h.warnings.every((line) => !line.includes("private native details")));
    const attempts = [...h.network.attempts];
    h = await harness({ code, disk: h.disk, network: h.network });
    await h.poll();
    assert.equal(h.cursor, 3);
    assert.deepEqual(clone(h.circle.rejectedControl), { sequenceId: 1, code, count: 1 });
    assert.deepEqual(h.network.attempts, attempts, "restart must not replay rejected controls");
    assert.equal(h.disk.metadata.timeline.length, 1);
    assert.deepEqual(h.network.uploads, ["draft"]);
  });
}

test("unknown native failures retain the cursor across retries and restart, and block saved outbox entries", async () => {
  let h = await harness({ code: "ERR_UNEXPECTED" });
  await h.persistence.stateTransaction(async () => h.persistence.queueEnvelope("mailbox", {
    eventId: "already-saved", kind: "application", epoch: 1,
    nonce: new Uint8Array([0]), ciphertext: new Uint8Array([9]),
  }));
  await h.poll();
  await h.poll();
  h = await harness({ code: "ERR_UNEXPECTED", disk: h.disk, network: h.network });
  await h.poll();
  assert.equal(h.cursor, 0);
  assert.deepEqual(h.network.attempts, [1, 1, 1]);
  assert.deepEqual(h.state, { epoch: 1, members: ["alice", "bob"], touched: 0 });
  assert.ok(h.circle.syncError);
  assert.deepEqual(h.network.uploads, []);
  assert.equal(h.persistence.pendingMessageCount("mailbox"), 1);
  assert.deepEqual(h.disk.metadata.timeline, []);
});

test("retryable native failure rolls back and retries the same commit before later traffic", async () => {
  const h = await harness({ code: "ENOSPC", firstIsValid: true });
  h.rejectFirstCommit();
  await h.poll();
  assert.equal(h.cursor, 0);
  assert.equal(h.state.touched, 0);
  assert.deepEqual(h.network.uploads, []);
  h.allowFirstCommit();
  await h.poll();
  assert.equal(h.cursor, 3);
  assert.equal(h.state.epoch, 3);
  assert.deepEqual(h.network.attempts, [1, 1, 2]);
  assert.equal(h.disk.metadata.timeline[0].text, "legitimate");
});

test("failed checkpoint rolls back a valid commit, then retries it before later traffic", async () => {
  const h = await harness({ code: "ENOSPC", firstIsValid: true });
  h.failCheckpointAt(1);
  await h.poll();
  assert.equal(h.cursor, 0);
  assert.equal(h.state.epoch, 1);
  assert.equal(h.state.touched, 0);
  assert.ok(h.circle.syncError);
  assert.deepEqual(h.network.uploads, []);
  await h.poll();
  assert.equal(h.cursor, 3);
  assert.equal(h.state.epoch, 3);
  assert.deepEqual(h.network.attempts, [1, 1, 2]);
  assert.equal(h.disk.metadata.timeline[0].text, "legitimate");
  assert.deepEqual(h.network.uploads, ["draft"]);
});

test("a rejection-shaped error from checkpoint storage must not authorize skipping a valid commit", async () => {
  const h = await harness({ firstIsValid: true });
  h.failCheckpointAt(1, failure(unauthorized));
  await h.poll();
  assert.equal(h.cursor, 0);
  assert.equal(h.state.epoch, 1);
  assert.equal(h.state.touched, 0);
  assert.deepEqual(h.network.attempts, [1]);
  assert.deepEqual(h.network.uploads, []);
  await h.poll();
  assert.equal(h.cursor, 3);
  assert.equal(h.state.epoch, 3);
});

test("a rejection-shaped error after native commit processing must roll back and retry", async () => {
  const h = await harness({ firstIsValid: true });
  h.failAfterNativeCommit(failure(unauthorized));
  await h.poll();
  assert.equal(h.cursor, 0);
  assert.equal(h.state.epoch, 1);
  assert.equal(h.state.touched, 0);
  assert.deepEqual(h.network.attempts, [1]);
  assert.deepEqual(h.network.uploads, []);
  await h.poll();
  assert.equal(h.cursor, 3);
  assert.equal(h.state.epoch, 3);
  assert.deepEqual(h.network.attempts, [1, 1, 2]);
});

test("failed persistence of the rejection cursor retries safely after restart", async () => {
  let h = await harness();
  h.failCheckpointAt(1);
  await h.poll();
  assert.equal(h.cursor, 0);
  assert.equal(h.state.touched, 0);
  assert.equal(h.circle.rejectedControl, undefined);
  assert.deepEqual(h.network.attempts, [1]);
  assert.deepEqual(h.network.uploads, []);
  h = await harness({ disk: h.disk, network: h.network });
  await h.poll();
  assert.equal(h.cursor, 3, "the rejection checkpoint should succeed on the next attempt");
  assert.equal(h.state.touched, 0);
  assert.deepEqual(h.network.attempts, [1, 1, 2]);
  assert.equal(h.disk.metadata.timeline.length, 1);
});

test("rollback failure stops subsequent transactions instead of advancing or publishing", async () => {
  const h = await harness();
  h.failRollback();
  await h.poll();
  await h.poll();
  assert.equal(h.cursor, 0);
  assert.deepEqual(h.network.attempts, [1]);
  assert.deepEqual(h.network.uploads, []);
  assert.equal(h.disk.native.touched, 0);
  assert.deepEqual(h.disk.metadata.timeline, []);
});
