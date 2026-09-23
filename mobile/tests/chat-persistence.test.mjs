import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the real backup and outbox code while replacing only Android storage
// and the network. The tiny ratchet model makes rollback visible without
// duplicating the cryptography tests that already live in Rust.
async function harness(
  disk = { state: null, session: null },
  network = { delivered: new Map(), fail: false, loseReply: false },
  clock = Date,
) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let ratchet = 0,
    before = 0,
    metadata = {},
    failCommit = false,
    exports = 0;
  const encode = (value) => encoder.encode(JSON.stringify(value));
  const decode = (bytes) => JSON.parse(decoder.decode(bytes));
  const native = {
    readChatState: async () => disk.state,
    configureChatState: async (_key, bytes) => {
      metadata = decode(bytes);
    },
    beginChatTransaction: async () => {
      before = ratchet;
    },
    commitChatTransaction: async (bytes) => {
      if (failCommit) {
        failCommit = false;
        throw new Error("disk full");
      }
      metadata = decode(bytes);
      disk.state = encode({ ratchet, metadata });
      return disk.state;
    },
    abortChatTransaction: async () => {
      ratchet = before;
    },
  };
  const bridge = {
    importEncryptedState: async (_slot, _key, bytes) => {
      const saved = decode(bytes);
      ratchet = saved.ratchet;
      return { deviceId: "alice", appMetadata: encode(saved.metadata) };
    },
    generateSeedPhrase: async () => "test only",
    createIdentityFromSeedPhrase: async () => ({
      deviceId: "alice",
      backupId: "backup",
      authKey: new Uint8Array(32),
      encKey: new Uint8Array(32),
    }),
    exportEncryptedState: async (_slot, _key, bytes) => {
      exports++;
      return encode({ ratchet, metadata: bytes.length ? decode(bytes) : {} });
    },
    deriveBackupCredentialsFromSeedPhrase: async () => ({
      backupId: "backup",
      authKey: new Uint8Array(32),
      encKey: new Uint8Array(32),
    }),
    computeBackupProof: async () => new Uint8Array(32),
  };
  const relay = {
    isMailboxChanged: (error) => error?.message === "mailbox-changed",
    requestBackupChallenge: async () => (disk.remote ? "AA==" : null),
    registerBackup: async () => true,
    updateBackup: async (_id, _nonce, _proof, ciphertext) => {
      disk.remote = ciphertext;
      return "ok";
    },
    uploadEnvelope: async (_mailbox, envelope) => {
      assert.ok(
        decode(disk.state).metadata.outbox.some(
          (item) => item.eventId === envelope.eventId,
        ),
        "envelope must be on disk before publication",
      );
      if (network.fail) throw new Error("offline");
      if (network.changed) throw new Error("mailbox-changed");
      const existing = network.delivered.get(envelope.eventId);
      if (existing)
        assert.equal(
          JSON.stringify(envelope),
          JSON.stringify(existing),
          "retry must preserve ciphertext/id",
        );
      network.delivered.set(envelope.eventId, envelope);
      network.onAccepted?.();
      if (network.loseReply) throw new Error("response lost after server accepted");
    },
    fetchBackup: async () => ({ status: "ok", ciphertext: disk.remote }),
  };
  const context = vm.createContext({
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Date: clock,
    console,
  });
  const modules = new Map();
  const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
  async function load(name, from = resolve(sourceRoot, "backup")) {
    const id = name.startsWith(".") ? resolve(dirname(from), name) : name;
    if (modules.has(id)) return modules.get(id);
    const mocks = {
      "expo-secure-store": {
        getItemAsync: async () => disk.session,
        setItemAsync: async (_key, value) => {
          disk.session = value;
        },
      },
      "expo-file-system": {
        File: class {
          exists = false;
        },
        Paths: { document: "", cache: "" },
      },
      "expo-sharing": {},
      [resolve(sourceRoot, "../modules/family-circle-bridge")]: { default: native },
      [resolve(sourceRoot, "bridge")]: bridge,
      [resolve(sourceRoot, "relay")]: relay,
    };
    let module;
    if (Object.hasOwn(mocks, id)) {
      const mock = mocks[id];
      module = new vm.SyntheticModule(
        Object.keys(mock),
        function () {
          for (const [key, value] of Object.entries(mock))
            this.setExport(
              key,
              mock === relay && typeof value === "function"
                ? (...args) => mock[key](...args)
                : value,
            );
        },
        { context, identifier: id },
      );
    } else {
      const path = `${id}.ts`;
      const source = ts.transpileModule(readFileSync(path, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      module = new vm.SourceTextModule(source, { context, identifier: id });
    }
    modules.set(id, module);
    return module;
  }
  const module = await load("./backup");
  await module.link((child, parent) => load(child, parent.identifier));
  await module.evaluate();
  const backup = module.namespace;
  if (disk.state) await backup.tryResumeFromLocalCache("device");
  else await backup.createNewIdentityWithBackup("device");
  let app = disk.state ? decode(disk.state).metadata : { nicknames: {}, circles: [] };
  let onAcknowledged = () => {};
  backup.bindRuntime({
    snapshot: () => structuredClone(app),
    restore: (restored) => {
      app = restored;
    },
    committed: () => {},
    acknowledged: (entry) => onAcknowledged(entry),
  });
  const send = () =>
    backup.stateTransaction(async () => {
      ratchet++;
      backup.queueEnvelope("mailbox", {
        eventId: `event-${ratchet}`,
        epoch: 1,
        kind: "application",
        nonce: new Uint8Array([ratchet]),
        ciphertext: new Uint8Array([ratchet, 9]),
        plaintext: "hello",
        expectedSequenceId: 0,
      });
    });
  return {
    backup,
    onEnvelopeAcknowledged: (listener) => {
      onAcknowledged = listener;
    },
    send,
    disk,
    network,
    native,
    relay,
    encode,
    decode,
    get exports() {
      return exports;
    },
    get ratchet() {
      return ratchet;
    },
    failCommit: () => {
      failCommit = true;
    },
    setApp: (value) => {
      app = value;
    },
  };
}

// Publication and crash recovery

test("offline send survives restart, retries exact envelope, then advances the sender ratchet", async () => {
  let app = await harness();
  await app.send();
  app.network.fail = true;
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.size, 0);
  app = await harness(app.disk, app.network);
  assert.equal(app.ratchet, 1);
  app.network.fail = false;
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.size, 1);
  await app.send();
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.size, 2);
  assert.equal(app.ratchet, 2);
});

test("lost upload response followed by restart causes one relay message, not two", async () => {
  let app = await harness();
  await app.send();
  app.network.loseReply = true;
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.size, 1);
  assert.equal(app.backup.pendingMessageCount("mailbox"), 1);
  app = await harness(app.disk, app.network);
  app.network.loseReply = false;
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.size, 1);
  assert.equal(app.backup.pendingMessageCount("mailbox"), 0);
});

test("failed local commit rolls back ratchet, cursor, outgoing queue and UI effects", async () => {
  const app = await harness();
  const previous = app.disk.state;
  let rendered = false;
  app.failCommit();
  await assert.rejects(
    app.backup.stateTransaction(async () => {
      app.setApp({
        nicknames: {},
        circles: [
          {
            circleId: "circle",
            mailboxId: "mailbox",
            isCreator: true,
            lastSeenSequenceId: 99,
          },
        ],
      });
      app.backup.queueEnvelope("mailbox", {
        eventId: "failed",
        epoch: 1,
        kind: "application",
        nonce: new Uint8Array([1]),
        ciphertext: new Uint8Array([2]),
      });
      app.backup.afterStateCommit(() => {
        rendered = true;
      });
    }),
    /disk full/,
  );
  assert.equal(app.disk.state, previous);
  assert.equal(rendered, false);
  assert.equal(app.backup.pendingMessageCount("mailbox"), 0);
  app.failCommit();
  await assert.rejects(app.send(), /disk full/);
  assert.equal(app.ratchet, 0);
  await app.send();
  await app.backup.flushOutbox();
  assert.equal(app.ratchet, 1);
  assert.deepEqual(app.decode(app.disk.state).metadata.circles, []);
});

test("concurrent send and background work serialize; receive cursor survives restart", async () => {
  let app = await harness();
  await Promise.all(Array.from({ length: 12 }, () => app.send()));
  app.setApp({
    nicknames: {},
    circles: [
      {
        circleId: "circle",
        mailboxId: "mailbox",
        isCreator: true,
        lastSeenSequenceId: 42,
      },
    ],
  });
  await app.backup.stateTransaction(async () => {});
  app = await harness(app.disk, app.network);
  assert.equal(app.ratchet, 12);
  assert.equal(app.decode(app.disk.state).metadata.circles[0].lastSeenSequenceId, 42);
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.size, 12);
});

test("restoring a remote backup blocks uncertain sender state and drops its outbox", async () => {
  const app = await harness();
  await app.send();
  app.disk.remote = app.encode({
    ratchet: 0,
    metadata: {
      nicknames: {},
      circles: [{ circleId: "circle", mailboxId: "mailbox", isCreator: false }],
      outbox: app.decode(app.disk.state).metadata.outbox,
    },
  });
  app.relay.requestBackupChallenge = async () => "AA==";
  const restored = await app.backup.restoreFromBackup("device", "test only");
  assert.equal(restored.circles[0].recoveryRequired, true);
  assert.equal(app.backup.pendingMessageCount("mailbox"), 0);
});

test("failure saving an upload acknowledgement retries the same accepted envelope", async () => {
  let app = await harness();
  await app.send();
  app.network.onAccepted = () => {
    app.failCommit();
    app.network.onAccepted = null;
  };
  await assert.rejects(app.backup.flushOutbox(), /disk full/);
  assert.equal(app.network.delivered.size, 1);
  app = await harness(app.disk, app.network);
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.size, 1);
  assert.equal(app.backup.pendingMessageCount("mailbox"), 0);
});

test("an unrecoverable rollback stops all later state changes and publication", async () => {
  const app = await harness();
  app.native.abortChatTransaction = async () => {
    throw new Error("rollback unavailable");
  };
  app.failCommit();
  await assert.rejects(app.send(), /disk full/);
  await assert.rejects(app.send(), /rollback unavailable/);
  await assert.rejects(app.backup.flushOutbox(), /rollback unavailable/);
  assert.equal(app.network.delivered.size, 0);
});

test("a rejected stale append catches up and reseals, while retaining its original event id", async () => {
  let app = await harness();
  await app.send();
  app.network.changed = true;
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.size, 0);
  app = await harness(app.disk, app.network);
  assert.equal(app.backup.hasRejectedEnvelope("mailbox"), true);
  await app.backup.stateTransaction(() =>
    app.backup.resealRejected("mailbox", 50, 2, async (plaintext) => {
      assert.equal(plaintext, "hello");
      return {
        eventId: "unused-new-id",
        epoch: 2,
        nonce: new Uint8Array([5]),
        ciphertext: new Uint8Array([8]),
      };
    }),
  );
  app.network.changed = false;
  await app.backup.flushOutbox();
  const delivered = app.network.delivered.get("event-1");
  assert.equal(delivered.epoch, 2);
  assert.equal(delivered.expectedSequenceId, 50);
  assert.equal(delivered.ciphertext[0], 8);
  assert.equal(app.network.delivered.size, 1);
});

// Membership changes are staged until the relay confirms their position.

test("a same-epoch retry keeps its ciphertext while a membership commit is pending", async () => {
  let app = await harness();
  await app.send();
  app.network.changed = true;
  await app.backup.flushOutbox();
  app = await harness(app.disk, app.network);
  await app.backup.stateTransaction(() =>
    app.backup.resealRejected("mailbox", 50, 1, async () => {
      throw new Error("must not consume a ratchet while a commit is pending");
    }),
  );
  app.network.changed = false;
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.get("event-1").ciphertext[0], 1);
  assert.equal(app.network.delivered.get("event-1").expectedSequenceId, 50);
});

async function stageMembership(app) {
  await app.backup.stateTransaction(async () => {
    app.setApp({
      nicknames: {},
      circles: [
        {
          circleId: "circle",
          mailboxId: "mailbox",
          isCreator: true,
          pendingCommitEventId: "commit-1",
          membershipChanges: [{ type: "remove", memberId: "carol" }],
        },
      ],
    });
    app.backup.queueEnvelope("mailbox", {
      eventId: "commit-1",
      epoch: 0,
      kind: "commit",
      nonce: new Uint8Array([0]),
      ciphertext: new Uint8Array([7]),
    });
    app.backup.queueEnvelope("mailbox", {
      eventId: "welcome-1",
      epoch: 0,
      kind: "welcome",
      nonce: new Uint8Array([0]),
      ciphertext: new Uint8Array([8]),
      commitEventId: "commit-1",
    });
  });
}

test("prepared commit, dependent Welcome and next membership intent survive an ambiguous upload and restart", async () => {
  let app = await harness();
  await stageMembership(app);
  app.network.loseReply = true;
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.size, 1); // Welcome waits for commit acceptance.
  app = await harness(app.disk, app.network);
  const circle = app.decode(app.disk.state).metadata.circles[0];
  assert.equal(circle.pendingCommitEventId, "commit-1");
  assert.equal(circle.membershipChanges[0].memberId, "carol");
  app.network.loseReply = false;
  await app.backup.flushOutbox();
  assert.deepEqual([...app.network.delivered.keys()], ["commit-1", "welcome-1"]);
  // The HTTP acknowledgement is not permission to switch the active epoch.
  assert.equal(
    app.decode(app.disk.state).metadata.circles[0].pendingCommitEventId,
    "commit-1",
  );
});

test("remote restore preserves only the exact prepared publication, not uncertain applications or later membership intents", async () => {
  const app = await harness();
  await stageMembership(app);
  await app.send();
  app.disk.remote = app.disk.state;
  app.relay.requestBackupChallenge = async () => "AA==";
  const restored = await app.backup.restoreFromBackup("device", "test only");
  const saved = app.decode(app.disk.state).metadata;
  assert.deepEqual(
    saved.outbox.map((entry) => entry.eventId),
    ["commit-1", "welcome-1"],
  );
  assert.equal(saved.outbox[0].ciphertext, "Bw==");
  assert.equal(restored.circles[0].recoveryRequired, true);
  assert.equal(restored.circles[0].pendingCommitEventId, "commit-1");
  assert.deepEqual(saved.circles[0].membershipChanges, []);
});

test("failed staging checkpoint rolls back the pending publication and its dependent Welcome", async () => {
  const app = await harness();
  const before = app.disk.state;
  app.failCommit();
  await assert.rejects(stageMembership(app), /disk full/);
  assert.equal(app.disk.state, before);
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.size, 0);
  await app.backup.stateTransaction(async () => {});
  assert.deepEqual(app.decode(app.disk.state).metadata.circles, []);
});

test("a failed membership update pauses that mailbox without blocking other Circles", async () => {
  const app = await harness();
  await stageMembership(app);
  app.setApp({
    nicknames: {},
    circles: [
      {
        circleId: "circle",
        mailboxId: "mailbox",
        isCreator: true,
        syncError: "cannot apply commit",
      },
    ],
  });
  await app.backup.stateTransaction(async () => {
    app.backup.queueEnvelope("other-mailbox", {
      eventId: "other-chat",
      epoch: 1,
      kind: "application",
      nonce: new Uint8Array([1]),
      ciphertext: new Uint8Array([2]),
    });
  });
  await app.backup.flushOutbox();
  assert.deepEqual([...app.network.delivered.keys()], ["other-chat"]);
  assert.deepEqual(
    app.decode(app.disk.state).metadata.outbox.map((entry) => entry.eventId),
    ["commit-1", "welcome-1"],
  );
});

// Local history is durable, but it deliberately stays out of cloud recovery.

test("history and cursor survive disk restart atomically and history stays out of recovery uploads", async () => {
  let app = await harness();
  const saved = {
    nicknames: {},
    circles: [{ circleId: "circle", mailboxId: "mailbox", lastSeenSequenceId: 42 }],
    timeline: [
      {
        id: "t0",
        circleId: "circle",
        kind: "chat",
        senderId: "bob",
        text: "saved private message",
        at: 123,
      },
    ],
  };
  await app.backup.stateTransaction(() => app.setApp(saved));
  app = await harness(app.disk, app.network);
  const resumed = await app.backup.tryResumeFromLocalCache("device");
  assert.equal(resumed.timeline[0].text, "saved private message");
  assert.equal(resumed.circles[0].lastSeenSequenceId, 42);
  app.failCommit();
  await assert.rejects(
    app.backup.stateTransaction(() =>
      app.setApp({
        ...saved,
        circles: [{ ...saved.circles[0], lastSeenSequenceId: 43 }],
        timeline: [...saved.timeline, { id: "t1", text: "failed" }],
      }),
    ),
    /disk full/,
  );
  await app.backup.stateTransaction(() => {});
  assert.deepEqual(app.decode(app.disk.state).metadata.timeline, saved.timeline);
  assert.equal(app.decode(app.disk.state).metadata.circles[0].lastSeenSequenceId, 42);
  app.relay.requestBackupChallenge = async () => "AA==";
  app.disk.remote = app.disk.state;
  await app.backup.syncBackupNow("device");
  assert.ok(app.disk.remote);
  assert.equal(app.decode(app.disk.remote).metadata.timeline, undefined);
  assert.deepEqual(app.decode(app.disk.state).metadata.timeline, saved.timeline);
});

test("deleting a Circle drops its queued messages durably, but a failed deletion preserves them", async () => {
  let app = await harness();
  await app.send();
  app.failCommit();
  await assert.rejects(
    app.backup.stateTransaction(async () => app.backup.discardMailboxOutbox("mailbox")),
    /disk full/,
  );
  assert.equal(app.backup.pendingMessageCount("mailbox"), 1);
  await app.backup.stateTransaction(async () =>
    app.backup.discardMailboxOutbox("mailbox"),
  );
  app = await harness(app.disk, app.network);
  assert.equal(app.backup.pendingMessageCount("mailbox"), 0);
  await app.backup.flushOutbox();
  assert.equal(app.network.delivered.size, 0);
});

test("delivery metadata and outbox acknowledgement commit or roll back together", async () => {
  let app = await harness();
  await app.send();
  app.setApp({
    nicknames: {},
    circles: [],
    timeline: [
      {
        id: "t0",
        circleId: "circle",
        kind: "chat",
        text: "hello",
        at: 1,
        delivery: "waiting",
      },
    ],
  });
  await app.backup.stateTransaction(async () => {});
  const register = () =>
    app.onEnvelopeAcknowledged(() => {
      app.setApp({
        nicknames: {},
        circles: [],
        timeline: [
          {
            id: "t0",
            circleId: "circle",
            kind: "chat",
            text: "hello",
            at: 1,
            delivery: "sent",
          },
        ],
      });
    });
  register();
  app.network.loseReply = true;
  await app.backup.flushOutbox();
  assert.equal(app.decode(app.disk.state).metadata.timeline[0].delivery, "waiting");
  app.network.loseReply = false;
  app.failCommit();
  await assert.rejects(app.backup.flushOutbox(), /disk full/);
  assert.equal(app.decode(app.disk.state).metadata.timeline[0].delivery, "waiting");
  assert.equal(app.backup.pendingMessageCount("mailbox"), 1);
  app = await harness(app.disk, app.network);
  register();
  await app.backup.flushOutbox();
  assert.equal(app.decode(app.disk.state).metadata.timeline[0].delivery, "sent");
  assert.equal(app.backup.pendingMessageCount("mailbox"), 0);
});

// Metadata with binary-backed features should survive without leaking the chat log.

test("profile photos survive encrypted local and recovery metadata round trips", async () => {
  const app = await harness();
  const photo = "data:image/jpeg;base64,/9j/2Q==";
  await app.backup.stateTransaction(async () =>
    app.setApp({
      nicknames: { bob: "Bob" },
      profilePhotos: { bob: photo, alice: null },
      circles: [],
    }),
  );
  const resumed = await app.backup.tryResumeFromLocalCache("device");
  assert.equal(resumed.profilePhotos.bob, photo);
  assert.equal(resumed.profilePhotos.alice, null);
  app.disk.remote = app.disk.state;
  app.relay.requestBackupChallenge = async () => "AA==";
  const restored = await app.backup.restoreFromBackup("device", "test only");
  assert.equal(restored.profilePhotos.bob, photo);
  assert.equal(restored.profilePhotos.alice, null);
});
test("attachment metadata and chunks count as one pending message across restart", async () => {
  let h = await harness();
  await h.backup.stateTransaction(async () => {
    for (const [index, type] of [
      "chat",
      "attachment-chunk",
      "attachment-chunk",
    ].entries())
      h.backup.queueEnvelope("mailbox", {
        eventId: "part-" + index,
        epoch: 1,
        kind: "application",
        nonce: new Uint8Array([1]),
        ciphertext: new Uint8Array([2]),
        plaintext: JSON.stringify({ type, messageId: "file", index }),
        expectedSequenceId: 0,
      });
  });
  assert.equal(h.backup.pendingMessageCount("mailbox"), 1);
  h = await harness(h.disk, h.network);
  assert.equal(h.backup.pendingMessageCount("mailbox"), 1);
  await h.backup.flushOutbox();
  assert.equal(h.backup.pendingMessageCount("mailbox"), 0);
});

function backupClock() {
  let now = 1_000_000;
  return {
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

for (const failure of ["offline", "missing-challenge", "unauthorized", "not-found"]) {
  test(
    "recovery backup backs off " +
      failure +
      " without repeated export or losing newer state",
    async () => {
      const clock = backupClock();
      const h = await harness(undefined, undefined, clock.Date);
      let attempts = 0;
      let failing = true;
      h.relay.requestBackupChallenge = async () => {
        attempts++;
        if (failing && failure === "offline") throw Error("offline");
        return failing && failure === "missing-challenge" ? null : "AA==";
      };
      h.relay.updateBackup = async (_id, _nonce, _proof, bytes) => {
        if (failing) return failure;
        h.disk.remote = bytes;
        return "ok";
      };
      for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
        const before = attempts;
        await h.backup.syncBackupNow("device");
        assert.equal(attempts, before + 1);
        const exported = h.exports;
        clock.advance(delay - 1);
        await Promise.all(
          Array.from({ length: 20 }, () => h.backup.syncBackupNow("device")),
        );
        assert.equal(attempts, before + 1);
        assert.equal(h.exports, exported);
        clock.advance(1);
      }
      await h.backup.stateTransaction(async () =>
        h.setApp({
          nicknames: { alice: "Updated" },
          circles: [],
          timeline: [{ text: "local only" }],
        }),
      );
      failing = false;
      await h.backup.syncBackupNow("device");
      assert.equal(h.decode(h.disk.remote).metadata.nicknames.alice, "Updated");
      assert.equal(h.decode(h.disk.remote).metadata.timeline, undefined);
      // Success resets both the quiet period and the subsequent failure delay.
      const before = attempts;
      clock.advance(29_999);
      await h.backup.syncBackupNow("device");
      assert.equal(attempts, before);
      clock.advance(1);
      failing = true;
      await h.backup.syncBackupNow("device");
      clock.advance(30_000);
      await h.backup.syncBackupNow("device");
      assert.equal(attempts, before + 2);
    },
  );
}

// Backup scheduling and retry timing

test("recovery backup allows local commits during an upload and coalesces concurrent callers", async () => {
  const clock = backupClock();
  const h = await harness(undefined, undefined, clock.Date);
  let entered;
  const uploading = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const response = new Promise((resolve) => {
    release = resolve;
  });
  let writes = 0;
  h.relay.requestBackupChallenge = async () => "AA==";
  h.relay.updateBackup = async (_id, _nonce, _proof, bytes) => {
    writes++;
    entered();
    await response;
    h.disk.remote = bytes;
    return "ok";
  };
  const first = h.backup.syncBackupNow("device");
  await uploading;
  await h.backup.stateTransaction(async () =>
    h.setApp({ nicknames: { alice: "Newer" }, circles: [] }),
  );
  await h.backup.syncBackupNow("device");
  assert.equal(writes, 1);
  release();
  await first;
  clock.advance(30_000);
  await h.backup.syncBackupNow("device");
  assert.equal(writes, 2);
  assert.equal(h.decode(h.disk.remote).metadata.nicknames.alice, "Newer");
});

test("wall-clock rollback does not strand recovery backup attempts", async () => {
  const clock = backupClock();
  const h = await harness(undefined, undefined, clock.Date);
  let attempts = 0;
  h.relay.requestBackupChallenge = async () => {
    attempts++;
    throw Error("offline");
  };
  await h.backup.syncBackupNow("device");
  clock.advance(-3_600_000);
  await h.backup.syncBackupNow("device");
  assert.equal(attempts, 2);
  await h.backup.syncBackupNow("device");
  assert.equal(attempts, 2);
});
