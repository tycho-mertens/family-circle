import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

async function harness(failure, fetchFailure = false, application = false) {
  const warnings = [];
  const cursor = { current: new Map() };
  let circle = {
    circleId: "family",
    mailboxId: "mailbox",
    role: application ? "member" : "joining",
    isAdmin: false,
    members: [],
  };
  const { createCircleSync } = await loadTypeScriptModule("src/runtime/circle-sync.ts", {
    globals: { console: { warn: (line) => warnings.push(line) } },
    mocks: {
      "../bridge": {
        decryptEvent: async () => ({
          senderDeviceId: "bob",
          plaintext: new TextEncoder().encode(
            JSON.stringify({ type: "nickname", nickname: "Bob" }),
          ),
        }),
      },
      "../relay": {
        fetchEnvelopes: async () => {
          if (fetchFailure) throw failure;
          return [
            {
              sequenceId: 7,
              eventId: "incoming",
              kind: application ? "application" : "commit",
            },
          ];
        },
      },
      "../backup": {
        stateTransaction: async (operation) => {
          const before = circle;
          const sequences = new Map(cursor.current);
          try {
            return await operation();
          } catch (error) {
            circle = before;
            cursor.current = sequences;
            throw error;
          }
        },
        hasRejectedEnvelope: () => false,
        flushOutbox: async () => {},
        syncBackupNow: async () => {},
      },
    },
  });
  const sync = createCircleSync({
    lastSeenSequenceId: cursor,
    myOwnEventIds: { current: new Map() },
    listCircles: () => [circle],
    getCircle: () => circle,
    patchCircle: (_id, patch) => {
      circle = { ...circle, ...patch };
    },
    identity: { deviceIdRef: { current: "alice" }, nicknamesRef: { current: {} } },
    appendSystem: () => {},
    handleControl: async () => {
      throw failure;
    },
    handleApplication: async () => {
      throw failure;
    },
    awaitingRejoinWelcome: { current: new Set() },
    eraseCircle: async () => true,
    putCircle: (next) => {
      circle = next;
    },
    getNotice: () => null,
    setNotice: () => {},
    queueControl: () => "event",
    enqueueMembershipChange: () => {},
    stageNextMembershipChange: async () => {},
    queueEnvelope: () => {},
  });
  return { sync: sync.pollAll, cursor, warnings, current: () => circle };
}

test("structured stale and duplicate control errors advance the cursor", async () => {
  for (const code of [
    "ERR_MLS_STALE_EPOCH",
    "ERR_MLS_OWN_MESSAGE",
    "ERR_MLS_ALREADY_PROCESSED",
  ]) {
    const h = await harness({ code, message: "different native wording" });
    await h.sync();
    assert.equal(h.cursor.current.get("family"), 7);
    assert.equal(h.current().syncError, undefined);
    assert.equal(h.warnings.length, 0);
  }
});

test("unexpected control failures retain the cursor and log no private message", async () => {
  const h = await harness({ code: "ENOSPC", message: "private StaleEpoch payload" });
  await h.sync();
  assert.equal(h.cursor.current.get("family"), undefined);
  assert.ok(h.current().syncError);
  assert.match(h.warnings[0], /code=ENOSPC/);
  assert.doesNotMatch(h.warnings[0], /private|payload/);
});

test("mailbox failures are observable, throttled, and do not change sync state", async () => {
  const h = await harness(
    { code: "RELAY_HTTP", status: 503, message: "private body" },
    true,
  );
  await h.sync();
  await h.sync();
  assert.equal(h.cursor.current.size, 0);
  assert.equal(h.current().lastSuccessfulSync, undefined);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /Mailbox fetch.*status=503/);
  assert.doesNotMatch(h.warnings[0], /private/);
});

test("application handler failures retain the cursor instead of being swallowed as decryption errors", async () => {
  const h = await harness({ code: "ENOSPC", message: "disk full" }, false, true);
  await h.sync();
  assert.equal(h.cursor.current.get("family"), undefined);
  assert.ok(h.current().syncError);
  assert.match(h.warnings[0], /Incoming Circle update.*ENOSPC/);
});

test("protocol-like errors from application handlers still roll back for retry", async () => {
  const h = await harness({ code: "ERR_MLS_STALE_EPOCH" }, false, true);
  await h.sync();
  assert.equal(h.cursor.current.get("family"), undefined);
  assert.match(h.current().syncError, /message update/);
});
