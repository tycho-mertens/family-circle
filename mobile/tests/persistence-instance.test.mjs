import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { createChatPersistence } = await loadTypeScriptModule("src/persistence/chat.ts");
const transport = {
  uploadEnvelope: async () => 1,
  isMailboxChanged: () => false,
};

function storage() {
  return {
    configureChatState: async () => {},
    beginChatTransaction: async () => {},
    commitChatTransaction: async () => {},
    abortChatTransaction: async () => {},
  };
}

test("persistence instances isolate readiness, outboxes, listeners, and rollback", async () => {
  const first = createChatPersistence(storage(), transport);
  const second = createChatPersistence(storage(), transport);
  let firstSnapshot = { nicknames: { alice: "Alice" }, circles: [] };
  let secondSnapshot = { nicknames: { bob: "Bob" }, circles: [] };
  let firstCommits = 0;
  let secondCommits = 0;
  let effects = 0;
  first.bindRuntime({
    snapshot: () => firstSnapshot,
    restore: (saved) => {
      firstSnapshot = saved;
    },
    committed: () => {
      firstCommits++;
    },
    acknowledged: () => {},
  });
  second.bindRuntime({
    snapshot: () => secondSnapshot,
    restore: (saved) => {
      secondSnapshot = saved;
    },
    committed: () => {
      secondCommits++;
    },
    acknowledged: () => {},
  });
  await first.configureLocal(new Uint8Array(32), firstSnapshot);
  await assert.rejects(
    second.stateTransaction(async () => {}),
    /identity is still loading/,
  );
  await second.configureLocal(new Uint8Array(32), secondSnapshot);
  await assert.rejects(
    first.stateTransaction(async () => {
      firstSnapshot = { ...firstSnapshot, nicknames: { alice: "Changed" } };
      first.queueEnvelope("mailbox", {
        eventId: "message",
        kind: "application",
        epoch: 1,
        nonce: new Uint8Array([1]),
        ciphertext: new Uint8Array([2]),
      });
      first.afterStateCommit(() => {
        effects++;
      });
      await second.stateTransaction(async () => {
        secondSnapshot = { ...secondSnapshot, nicknames: { bob: "Updated Bob" } };
        second.afterStateCommit(() => {
          effects++;
        });
      });
      throw new Error("rollback first only");
    }),
    /rollback first only/,
  );

  assert.equal(firstSnapshot.nicknames.alice, "Alice");
  assert.equal(secondSnapshot.nicknames.bob, "Updated Bob");
  assert.equal(first.pendingMessageCount("mailbox"), 0);
  assert.equal(second.pendingMessageCount("mailbox"), 0);
  assert.equal(firstCommits, 0);
  assert.equal(secondCommits, 1);
  assert.equal(effects, 1);
});

test("storage cannot transact before binding or silently replace its runtime owner", async () => {
  const persistence = createChatPersistence(storage(), transport);
  const snapshot = { nicknames: {}, circles: [] };
  await persistence.configureLocal(new Uint8Array(32), snapshot);
  assert.equal(persistence.ready, false);
  await assert.rejects(
    persistence.stateTransaction(async () => {}),
    /runtime is not bound/,
  );
  const binding = {
    snapshot: () => snapshot,
    restore() {},
    committed() {},
    acknowledged() {},
  };
  persistence.bindRuntime(binding);
  assert.equal(persistence.ready, true);
  assert.throws(() => persistence.bindRuntime(binding), /already has a runtime owner/);
  await persistence.stateTransaction(async () => {});
});
