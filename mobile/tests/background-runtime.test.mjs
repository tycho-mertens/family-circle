import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import ts from "typescript";

// This harness boots the real background runtime without React or a mounted
// screen. The fakes stop at the native/network boundary, so these tests still
// exercise the same coordination code that runs after Android wakes the app.
async function harness({
  allowCreation = false,
  missing = false,
  failResume = false,
  saved,
  payload = { type: "chat", text: "private message" },
  payloads,
  envelopeKind = "application",
  locationSender = null,
  leavingMember = "alice",
  members = ["alice", "bob"],
  sender = "alice",
} = {}) {
  const root = resolve("src");
  const modules = new Map();
  const tasks = new Map();
  const events = [];
  const notifications = [];
  let resumes = 0,
    loads = 0,
    fetches = 0,
    concurrent = 0,
    maximum = 0,
    active = true,
    failNetwork = false,
    snapshot,
    ticks = 0,
    acknowledged = () => {},
    nextId = 0,
    decryptions = 0;
  const incomingPayloads = payloads ?? [payload];
  const queued = [];
  const encrypted = [];
  const context = vm.createContext({
    __DEV__: false,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Date,
    Map,
    Set,
    Promise,
    console,
    process: { env: {} },
    setInterval: () => 0,
    setTimeout: (fn) => {
      ticks++;
      failNetwork = false;
      if (ticks >= 2) active = false;
      queueMicrotask(fn);
    },
  });
  const identity = {
    deviceId: "bob",
    nicknames: { alice: "Alice" },
    circles: [
      {
        circleId: "circle",
        mailboxId: "mailbox",
        role: "member",
        members: ["alice", "bob"],
        isCreator: false,
        lastSeenSequenceId: 7,
        membershipAuthority: "v1",
      },
    ],
  };
  const native = {
    createEventsChannel: () => {},
    completeSubscriberSync: (id, success) => events.push(`subscriber:${id}:${success}`),
    locationRuntimeReady: () => events.push("sampling-ready"),
    configureRelayConnection: () => {},
    relayConnectionStatus: () => ({ connected: false, dirty: false }),
  };
  const backup = {
    tryResumeFromLocalCache: async () => {
      resumes++;
      if (failResume) throw Error("locked");
      const value = missing ? null : saved ? { ...identity, ...saved } : identity;
      return (
        value && {
          ...value,
          circles: value.circles.map((circle) => ({
            ...circle,
            membershipAuthority: circle.membershipAuthority ?? "v1",
          })),
        }
      );
    },
    bindRuntime: (binding) => {
      snapshot = binding.snapshot;
      acknowledged = binding.acknowledged;
    },
    stateTransaction: async (fn) => fn(),
    afterStateCommit: (fn) => fn(),
    hasRejectedEnvelope: () => false,
    pendingMessageCount: () => 0,
    queueEnvelope: (mailbox, envelope) => {
      queued.push({ ...envelope, mailboxId: mailbox });
      events.push(`queued:${envelope.kind}`);
    },
    discardMailboxApplications: () => {},
    discardMailboxOutbox: (mailbox) => events.push(`discard:${mailbox}`),
    flushOutbox: async () => events.push("outbox"),
    syncBackupNow: async () => {},
    createNewIdentityWithBackup: async () => {
      if (allowCreation) return { ...identity, circles: [], seedPhrase: "test phrase" };
      throw Error("must not create identity");
    },
  };
  const relay = {
    randomId: () => `event-${nextId++}`,
    fetchEnvelopes: async (_mailbox, after) => {
      fetches++;
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      await Promise.resolve();
      concurrent--;
      if (failNetwork) throw Error("offline");
      return after < 7 + incomingPayloads.length
        ? [
            {
              sequenceId: after + 1,
              eventId: `event-${after + 1}`,
              kind: envelopeKind,
              epoch: 1,
              nonce: new Uint8Array([1]),
              ciphertext: new Uint8Array([2]),
            },
          ]
        : [];
    },
  };
  const location = {
    loadLocations: async () => {
      loads++;
      events.push("loaded");
    },
    command: async () => ({ shares: active ? [{ active: true }] : [] }),
    synchronizeLocations: async () => {
      events.push("locations");
      if (failNetwork) throw Error("offline");
    },
    receiveLocationControl: async () => locationSender,
  };
  const bridge = {
    forgetCircle: async (_slot, circle) => events.push(`forget:${circle}`),
    proposeLeave: async () => {
      events.push("propose-leave");
      return new Uint8Array([1]);
    },
    processLeave: async () => leavingMember,
    processCommit: async () => {},
    adoptMembershipAdmin: async (_slot, _circle, from, to) =>
      events.push(`admin:${from}->${to}`),
    circlePublicationState: async () => ({ epoch: 1, pendingCommit: false }),
    prepareMembershipChange: async (_slot, _circle, _kp, removals) => {
      events.push(`remove:${removals.join(",")}`);
      return { commitBytes: new Uint8Array([1]) };
    },
    listMembers: async () => members,
    createEventsChannel: () => {},
    encryptEvent: async (_slot, _circle, plaintext) => {
      encrypted.push(JSON.parse(new TextDecoder().decode(plaintext)));
      return {
        eventId: `sealed-${nextId++}`,
        epoch: 1,
        nonce: new Uint8Array([1]),
        ciphertext: new Uint8Array([2]),
      };
    },
    decryptEvent: async () => ({
      senderDeviceId: sender,
      plaintext: new TextEncoder().encode(
        JSON.stringify(incomingPayloads[decryptions++]),
      ),
    }),
    showNotification: (title, body) => notifications.push({ title, body }),
  };
  const mocks = {
    "react-native": {
      AppState: { currentState: "background", addEventListener: () => ({ remove() {} }) },
      AppRegistry: { registerHeadlessTask: (name, task) => tasks.set(name, task) },
    },
    [resolve(root, "../modules/family-circle-bridge")]: { default: native },
    [resolve(root, "backup")]: backup,
    [resolve(root, "bridge")]: bridge,
    [resolve(root, "relay")]: relay,
    [resolve(root, "location")]: location,
    [resolve(root, "relay-access")]: {
      installationToken: async () => null,
      enrollInstallation: async () => {},
    },
  };
  async function load(name, from = resolve(root, "runtime/background.ts")) {
    const id = name.startsWith(".") ? resolve(dirname(from), name) : name;
    if (modules.has(id)) return modules.get(id);
    const mock = mocks[id];
    const module = mock
      ? new vm.SyntheticModule(
          Object.keys(mock),
          function () {
            for (const [key, value] of Object.entries(mock)) this.setExport(key, value);
          },
          { context, identifier: id },
        )
      : new vm.SourceTextModule(
          ts.transpileModule(readFileSync(id + ".ts", "utf8"), {
            compilerOptions: {
              module: ts.ModuleKind.ESNext,
              target: ts.ScriptTarget.ES2022,
            },
          }).outputText,
          { context, identifier: id },
        );
    modules.set(id, module);
    return module;
  }
  const entry = await load("./background");
  await entry.link((child, parent) => load(child, parent.identifier));
  await entry.evaluate();
  const runtime = modules.get(resolve(root, "runtime/circles")).namespace.circlesRuntime;
  return {
    identity: modules.get(resolve(root, "runtime/identity")).namespace.identityRuntime
      .value,
    runtime,
    tasks,
    events,
    notifications,
    queued,
    encrypted,
    changeMembers: (value) => (members = value),
    ack: (entry) => acknowledged(entry),
    snapshot: () => snapshot(),
    counts: () => ({ resumes, loads, fetches, maximum }),
    offline: (value) => (failNetwork = value),
  };
}
// Startup and background scheduling

test("map polling callback stays stable across synchronization and state commits", async () => {
  const h = await harness();
  const poll = h.runtime.getValue().pollNow;
  await poll();
  assert.equal(h.runtime.getValue().pollNow, poll);
  await h.runtime.getValue().setCircleName("circle", "Stable map");
  assert.equal(h.runtime.getValue().pollNow, poll);
});
test("cold headless startup restores one engine; detached UI still receives once after durable cursor", async () => {
  const h = await harness();
  assert.equal(h.tasks.size, 4);
  await Promise.all([h.runtime.initialize(), h.runtime.initialize()]);
  const unsubscribe = h.runtime.changes.subscribe(() => {});
  unsubscribe();
  await Promise.all(Array.from({ length: 20 }, () => h.runtime.synchronize()));
  assert.equal(h.counts().resumes, 1);
  assert.equal(h.counts().loads, 1);
  assert.equal(h.counts().maximum, 1);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].body, "Alice: private message");
  assert.equal(h.snapshot().circles[0].lastSeenSequenceId, 8);
  await h.runtime.synchronize();
  assert.equal(h.notifications.length, 1);
});
test("location task initializes before sampling and ends after one failed reconciliation", async () => {
  const h = await harness();
  h.offline(true);
  await h.tasks.get("FamilyCircleLocationSync")()();
  assert.ok(h.events.indexOf("loaded") < h.events.indexOf("sampling-ready"));
  assert.equal(h.counts().resumes, 1);
  assert.equal(h.events.filter((e) => e === "locations").length, 1);
});
test("location upload works without a notification subscriber or mounted screen", async () => {
  const h = await harness();
  await h.tasks.get("FamilyCircleLocationUpload")()();
  assert.equal(h.counts().resumes, 1);
  assert.ok(h.events.includes("locations"));
  assert.equal(
    h.events.some((event) => event.startsWith("subscriber:")),
    false,
  );
});
test("each native location service start gets readiness while JS work coalesces", async () => {
  const h = await harness();
  const run = h.tasks.get("FamilyCircleLocationSync")();
  await Promise.all([run(), run()]);
  assert.equal(h.events.filter((event) => event === "sampling-ready").length, 2);
  assert.equal(h.counts().loads, 1);
  assert.equal(h.counts().maximum, 1);
});
for (const condition of [{ missing: true }, { failResume: true }])
  test(
    "unavailable cold identity never starts GPS or creates a new identity " +
      JSON.stringify(condition),
    async () => {
      const h = await harness(condition);
      await assert.rejects(
        h.tasks.get("FamilyCircleLocationSync")()(),
        /identity unavailable/,
      );
      assert.equal(h.events.includes("sampling-ready"), false);
      assert.equal(h.counts().loads, 0);
    },
  );

// Names, history, and Circle lifecycle

test("history survives a fresh runtime without replay or ID collisions", async () => {
  const first = await harness();
  await first.runtime.synchronize();
  const saved = structuredClone(first.snapshot());
  assert.equal(saved.timeline.filter((i) => i.kind === "chat").length, 1);
  const second = await harness({ saved });
  await second.runtime.synchronize();
  assert.deepEqual(
    JSON.parse(JSON.stringify(second.snapshot().timeline)),
    saved.timeline,
  );
  assert.equal(second.notifications.length, 0);
  await second.runtime.getValue().sendMessage("circle", "outgoing after restart");
  const timeline = second.snapshot().timeline;
  assert.equal(timeline.at(-1).text, "outgoing after restart");
  assert.equal(new Set(timeline.map((i) => i.id)).size, timeline.length);
});

for (const name of ["Family", "  Family  "])
  test(`saving unchanged Circle name ${JSON.stringify(name)} has no rename side effects`, async () => {
    const h = await harness({
      saved: {
        circles: [
          {
            circleId: "circle",
            mailboxId: "mailbox",
            role: "member",
            members: ["alice", "bob"],
            isCreator: true,
            circleName: "Family",
            lastSeenSequenceId: 8,
          },
        ],
      },
    });
    await h.runtime.initialize();
    await h.runtime.getValue().setCircleName("circle", name);
    const saved = h.snapshot();
    assert.equal(saved.circles[0].circleName, "Family");
    assert.equal(saved.circles[0].pendingBroadcasts?.length ?? 0, 0);
    assert.equal(
      saved.timeline.filter((item) => item.text.startsWith("Circle renamed")).length,
      0,
    );
  });

test("a changed Circle name is saved and announced once, repeated saves are ignored", async () => {
  const h = await harness({
    saved: {
      circles: [
        {
          circleId: "circle",
          mailboxId: "mailbox",
          role: "member",
          members: ["alice", "bob"],
          isCreator: true,
          circleName: "Family",
          lastSeenSequenceId: 8,
        },
      ],
    },
  });
  await h.runtime.initialize();
  await h.runtime.getValue().setCircleName("circle", "  Weekend crew  ");
  await h.runtime.getValue().setCircleName("circle", "Weekend crew");
  const saved = h.snapshot();
  assert.equal(saved.circles[0].circleName, "Weekend crew");
  assert.equal(
    saved.timeline.filter((item) => item.text === 'Circle renamed to "Weekend crew"')
      .length,
    1,
  );
});

for (const name of ["Family", "New name"])
  test(`received Circle name ${name} only announces an actual change`, async () => {
    const h = await harness({
      payload: { type: "circle-rename", name },
      saved: {
        circles: [
          {
            circleId: "circle",
            mailboxId: "mailbox",
            role: "member",
            members: ["alice", "bob"],
            isCreator: false,
            circleName: "Family",
            lastSeenSequenceId: 7,
          },
        ],
      },
    });
    await h.runtime.synchronize();
    const saved = h.snapshot();
    assert.equal(saved.circles[0].circleName, name);
    assert.equal(
      saved.timeline.filter((item) => item.text.startsWith("Circle renamed")).length,
      name === "Family" ? 0 : 1,
    );
    assert.equal(saved.circles[0].lastSeenSequenceId, 8);
  });

for (const name of ["Bob", "  Bob  "])
  test(`saving unchanged profile name ${JSON.stringify(name)} does not broadcast`, async () => {
    const h = await harness({ saved: { nicknames: { alice: "Alice", bob: "Bob" } } });
    await h.runtime.initialize();
    await h.runtime.getValue().setNickname(name);
    assert.equal(h.snapshot().nicknames.bob, "Bob");
    assert.equal(h.snapshot().circles[0].pendingBroadcasts?.length ?? 0, 0);
  });

test("changed profile name is saved and repeated saves do not queue extra broadcasts", async () => {
  const h = await harness({ saved: { nicknames: { alice: "Alice", bob: "Bob" } } });
  await h.runtime.initialize();
  await h.runtime.getValue().setNickname("  Robert  ");
  const broadcasts = h.snapshot().circles[0].pendingBroadcasts?.length ?? 0;
  assert.equal(h.snapshot().nicknames.bob, "Robert");
  assert.equal(broadcasts, 1);
  await h.runtime.getValue().setNickname("Robert");
  assert.equal(h.snapshot().circles[0].pendingBroadcasts?.length ?? 0, broadcasts);
});

for (const nickname of ["Alice", "Alicia"])
  test(`received profile name ${nickname} announces only actual changes`, async () => {
    const h = await harness({ payload: { type: "nickname", nickname } });
    await h.runtime.synchronize();
    assert.equal(h.snapshot().nicknames.alice, nickname);
    assert.equal(
      h.snapshot().timeline.filter((item) => item.text.endsWith("updated their name"))
        .length,
      nickname === "Alice" ? 0 : 1,
    );
  });

for (const sender of ["alice", "bob", null, "nonmember"])
  test(`location start notification recipient filtering: ${sender}`, async () => {
    const h = await harness({
      envelopeKind: "location-control-v1",
      locationSender: sender,
    });
    await h.runtime.synchronize();
    assert.equal(h.notifications.length, sender === "alice" ? 1 : 0);
    if (sender === "alice") {
      assert.equal(h.notifications[0].body, "Alice started sharing their location");
      assert.ok(h.notifications[0].title.startsWith("Location sharing"));
      assert.equal(
        h.snapshot().timeline.filter((i) => i.text === h.notifications[0].body).length,
        1,
      );
    }
    await h.runtime.synchronize();
    assert.equal(h.notifications.length, sender === "alice" ? 1 : 0);
    const resumed = await harness({
      saved: structuredClone(h.snapshot()),
      envelopeKind: "location-control-v1",
      locationSender: sender,
    });
    await resumed.runtime.synchronize();
    assert.equal(resumed.notifications.length, 0);
  });

for (const role of ["joining", "member", "removed"])
  test(`deleting ${role} retains only the state needed to finish leaving`, async () => {
    const saved = {
      circles: [
        {
          circleId: "circle",
          mailboxId: "mailbox",
          role,
          isCreator: false,
          members: ["alice", "bob"],
          lastSeenSequenceId: 8,
        },
      ],
      timeline: [
        { id: "t0", circleId: "circle", kind: "chat", text: "old history", at: 1 },
      ],
    };
    const h = await harness({ saved });
    await h.runtime.initialize();
    assert.equal(await h.runtime.getValue().deleteCircle("circle"), true);
    await h.runtime.synchronize();
    assert.equal(h.snapshot().timeline.length, 0);
    // Only a member has something to leave. A pending join was never admitted
    // and a removed device is already out, so both are erased outright.
    assert.equal(h.snapshot().circles.length, role === "member" ? 1 : 0);
    if (role === "member") {
      assert.equal(h.snapshot().circles[0].deleting, true);
      assert.ok(h.events.includes("queued:leave"));
    }
    const resumed = await harness({ saved: structuredClone(h.snapshot()) });
    await resumed.runtime.initialize();
    assert.equal(resumed.snapshot().circles.length, role === "member" ? 1 : 0);
    if (role === "member") assert.equal(resumed.snapshot().circles[0].deleting, true);
  });

test("remaining member becomes admin and commits the departing admin removal", async () => {
  const h = await harness({ envelopeKind: "leave", leavingMember: "alice" });
  await h.runtime.synchronize();
  assert.equal(h.runtime.getValue().circles.circle.isAdmin, true);
  assert.ok(h.events.includes("remove:alice"));
  assert.ok(h.events.includes("queued:commit"));
});

test("non-successor does not compete to publish the leave commit", async () => {
  const h = await harness({
    envelopeKind: "leave",
    leavingMember: "alice",
    members: ["alice", "carol", "bob"],
    saved: {
      circles: [
        {
          circleId: "circle",
          mailboxId: "mailbox",
          role: "member",
          members: ["alice", "carol", "bob"],
          isCreator: false,
          lastSeenSequenceId: 7,
        },
      ],
    },
  });
  await h.runtime.synchronize();
  assert.equal(h.runtime.getValue().circles.circle.isAdmin, false);
  assert.equal(h.events.includes("queued:commit"), false);
});

test("confirmed departure erases MLS and retains a dismissible confirmation", async () => {
  const h = await harness({
    envelopeKind: "commit",
    members: ["alice"],
    saved: {
      circles: [
        {
          circleId: "circle",
          mailboxId: "mailbox",
          role: "member",
          members: ["alice", "bob"],
          isCreator: false,
          deleting: true,
          leaveEpoch: 1,
          lastSeenSequenceId: 7,
        },
      ],
    },
  });
  await h.runtime.synchronize();
  assert.ok(h.snapshot().circles[0].departureConfirmedAt);
  assert.equal(h.snapshot().circles[0].role, "removed");
  assert.ok(h.events.includes("forget:circle"));
  await h.runtime.getValue().dismissDeparture("circle");
  assert.equal(h.snapshot().circles.length, 0);
});

test("last member deletion completes without a remote committer", async () => {
  const h = await harness({
    members: ["bob"],
    saved: {
      circles: [
        {
          circleId: "circle",
          mailboxId: "mailbox",
          role: "member",
          members: ["bob"],
          isCreator: true,
          lastSeenSequenceId: 8,
        },
      ],
    },
  });
  await h.runtime.initialize();
  await h.runtime.getValue().deleteCircle("circle");
  assert.equal(h.snapshot().circles.length, 0);
});

test("new members do not displace the persisted successor admin", async () => {
  const h = await harness({
    envelopeKind: "commit",
    members: ["newcomer", "bob"],
    saved: {
      circles: [
        {
          circleId: "circle",
          mailboxId: "mailbox",
          role: "member",
          members: ["bob"],
          adminId: "bob",
          isCreator: true,
          lastSeenSequenceId: 7,
        },
      ],
    },
  });
  await h.runtime.synchronize();
  assert.equal(h.runtime.getValue().circles.circle.adminId, "bob");
  assert.equal(h.runtime.getValue().circles.circle.isAdmin, true);
});

test("simultaneous departures elect one last member to commit remaining removals", async () => {
  const h = await harness({
    envelopeKind: "leave",
    leavingMember: "alice",
    saved: {
      circles: [
        {
          circleId: "circle",
          mailboxId: "mailbox",
          role: "member",
          members: ["alice", "bob"],
          adminId: "alice",
          isCreator: false,
          deleting: true,
          departingMembers: ["bob"],
          lastSeenSequenceId: 7,
        },
      ],
    },
  });
  await h.runtime.synchronize();
  assert.ok(h.events.includes("remove:alice"));
  assert.equal(h.events.includes("remove:bob"), false);
});

// Relay delivery and receipts

test("subscriber task cold-starts without a screen, decrypts once and reports completion", async () => {
  const h = await harness();
  await h.tasks.get("FamilyCircleSubscriberSync")()({ requestId: "first" });
  await h.tasks.get("FamilyCircleSubscriberSync")()({ requestId: "duplicate" });
  assert.equal(h.notifications.length, 1);
  assert.ok(h.events.includes("subscriber:first:true"));
  assert.ok(h.events.includes("subscriber:duplicate:true"));
});
test("subscriber task reports failure so the service can retry after an outage", async () => {
  const h = await harness();
  h.offline(true);
  await h.tasks.get("FamilyCircleSubscriberSync")()({ requestId: "offline" });
  assert.ok(h.events.includes("subscriber:offline:false"));
  h.offline(false);
  await h.tasks.get("FamilyCircleSubscriberSync")()({ requestId: "retry" });
  assert.ok(h.events.includes("subscriber:retry:true"));
  assert.equal(h.notifications.length, 1);
});

const joined = (patch = {}) => ({
  circleId: "circle",
  mailboxId: "mailbox",
  role: "member",
  members: ["alice", "bob"],
  isCreator: false,
  adminId: "alice",
  lastSeenSequenceId: 7,
  ...patch,
});

test("outgoing messages stay waiting until relay acknowledgement and survive restart with their ID", async () => {
  const h = await harness({ saved: { circles: [joined({ lastSeenSequenceId: 8 })] } });
  await h.runtime.initialize();
  h.offline(true);
  assert.equal(await h.runtime.getValue().sendMessage("circle", "On my way"), true);
  const outgoing = h.snapshot().timeline.at(-1);
  assert.equal(outgoing.delivery, "waiting");
  assert.ok(outgoing.messageId);
  const saved = structuredClone(h.snapshot());
  const restarted = await harness({ saved });
  await restarted.runtime.initialize();
  assert.equal(restarted.snapshot().timeline.at(-1).messageId, outgoing.messageId);
  assert.equal(restarted.snapshot().timeline.at(-1).delivery, "waiting");
  await restarted.runtime.synchronize();
  const envelope = restarted.queued.find((e) => JSON.parse(e.plaintext).type === "chat");
  assert.equal(JSON.parse(envelope.plaintext).messageId, outgoing.messageId);
  restarted.ack(envelope);
  assert.equal(restarted.snapshot().timeline.at(-1).delivery, "sent");
});

test("receiving a chat queues a receipt, duplicate logical messages do not duplicate history or alerts", async () => {
  const h = await harness({
    payload: { type: "chat", text: "Hello", messageId: "logical-id" },
  });
  await h.runtime.synchronize();
  const receipt = h.queued
    .map((e) => e.plaintext && JSON.parse(e.plaintext))
    .find((p) => p?.type === "receipt");
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), {
    type: "receipt",
    messageId: "logical-id",
    recipientId: "alice",
  });
  const saved = structuredClone(h.snapshot());
  saved.circles[0].lastSeenSequenceId = 7;
  const duplicate = await harness({
    saved,
    payload: { type: "chat", text: "Hello", messageId: "logical-id" },
  });
  await duplicate.runtime.synchronize();
  assert.equal(duplicate.snapshot().timeline.filter((i) => i.kind === "chat").length, 1);
  assert.equal(duplicate.notifications.length, 0);
  assert.ok(
    duplicate.queued.some(
      (e) => e.plaintext && JSON.parse(e.plaintext).type === "receipt",
    ),
  );
});

for (const sender of ["alice", "mallory"])
  test(`delivery receipt is bound to the authenticated original recipient: ${sender}`, async () => {
    const h = await harness({
      sender,
      payload: { type: "receipt", messageId: "m", recipientId: "bob" },
      saved: {
        circles: [joined()],
        timeline: [
          {
            id: "t0",
            circleId: "circle",
            kind: "chat",
            senderId: "bob",
            text: "Hello",
            at: 1,
            messageId: "m",
            delivery: "sent",
            recipients: ["alice"],
            deliveredTo: [],
          },
        ],
      },
    });
    await h.runtime.synchronize();
    assert.equal(
      h.snapshot().timeline[0].delivery,
      sender === "alice" ? "delivered" : "sent",
    );
    assert.equal(h.notifications.length, 0);
  });

test("muting chat keeps location alerts enabled and persists across restart", async () => {
  const h = await harness({ saved: { circles: [joined()] } });
  await h.runtime.initialize();
  await h.runtime.getValue().setNotifications("circle", {
    chat: false,
    location: true,
    quietHours: false,
    quietStart: "22:00",
    quietEnd: "08:00",
  });
  await h.runtime.synchronize();
  assert.equal(h.notifications.length, 0);
  const saved = structuredClone(h.snapshot());
  saved.circles[0].lastSeenSequenceId = 7;
  const restarted = await harness({
    saved,
    envelopeKind: "location-control-v1",
    locationSender: "alice",
  });
  await restarted.runtime.synchronize();
  assert.equal(restarted.notifications.length, 1);
  assert.equal(restarted.snapshot().circles[0].notifications.chat, false);
});

test("offline polling does not advance the last successful sync", async () => {
  const h = await harness({ saved: { circles: [joined({ lastSuccessfulSync: 123 })] } });
  await h.runtime.initialize();
  h.offline(true);
  await assert.rejects(h.runtime.synchronize());
  assert.equal(h.snapshot().circles[0].lastSuccessfulSync, 123);
});

test("admin cannot bypass explicit handover by deleting a Circle", async () => {
  const h = await harness({
    saved: {
      circles: [joined({ adminId: "bob", isCreator: true, lastSeenSequenceId: 8 })],
    },
  });
  await h.runtime.initialize();
  assert.equal(await h.runtime.getValue().deleteCircle("circle"), false);
  assert.ok(!h.snapshot().circles[0].deleting);
  await h.runtime.getValue().transferAdmin("circle", "alice");
  await h.runtime.synchronize();
  const c = h.snapshot().circles[0];
  assert.equal(c.handover.adminId, "alice");
  assert.ok(c.handover.eventId);
  assert.equal(await h.runtime.getValue().deleteCircle("circle"), false);
});

for (const sender of ["alice", "mallory"])
  test(`only the current admin can transfer to a different member: ${sender}`, async () => {
    const h = await harness({
      sender,
      payload: { type: "admin-transfer", id: "transfer", adminId: "bob" },
      saved: { circles: [joined()] },
    });
    await h.runtime.synchronize();
    assert.equal(h.snapshot().circles[0].adminId, sender === "alice" ? "bob" : "alice");
    assert.equal(
      h.queued.some((e) => e.plaintext && JSON.parse(e.plaintext).type === "admin-ack"),
      sender === "alice",
    );
  });

test("handover acknowledgement from the selected admin unlocks departure", async () => {
  const h = await harness({
    payload: { type: "admin-ack", id: "transfer" },
    saved: {
      circles: [
        joined({ handover: { id: "transfer", adminId: "alice", eventId: "original" } }),
      ],
    },
  });
  await h.runtime.synchronize();
  assert.equal(h.snapshot().circles[0].handover.confirmed, true);
  assert.equal(await h.runtime.getValue().leaveCircle("circle"), true);
  assert.equal(h.snapshot().circles[0].deleting, true);
});

test("an established member cannot claim admin by sending a legacy announcement", async () => {
  const h = await harness({
    sender: "alice",
    payload: { type: "circle-admin", adminId: "alice" },
    saved: { circles: [joined({ adminId: "bob", isCreator: true })] },
  });
  await h.runtime.synchronize();
  assert.equal(h.snapshot().circles[0].adminId, "bob");
});

const reactionMessage = {
  id: "t0",
  circleId: "circle",
  kind: "chat",
  senderId: "alice",
  text: "Reaction test",
  at: 1,
  messageId: "react-message",
};

// Reactions and notification throttling

test("reactions are encrypted, durable, replaceable and removable; repeated heart is idempotent", async () => {
  const h = await harness({
    saved: { circles: [joined({ lastSeenSequenceId: 8 })], timeline: [reactionMessage] },
  });
  await h.runtime.initialize();
  h.offline(true);
  assert.equal(await h.runtime.getValue().reactToMessage("circle", "t0", "❤️"), true);
  assert.equal(await h.runtime.getValue().reactToMessage("circle", "t0", "❤️"), true);
  assert.equal(h.snapshot().circles[0].pendingBroadcasts.length, 1);
  const restored = await harness({ saved: structuredClone(h.snapshot()) });
  await restored.runtime.initialize();
  assert.equal(restored.snapshot().timeline[0].reactions.bob, "❤️");
  await restored.runtime.synchronize();
  assert.ok(
    restored.queued.some(
      (e) => e.kind === "application" && JSON.parse(e.plaintext).type === "reaction",
    ),
  );
  await restored.runtime.getValue().reactToMessage("circle", "t0", "👍");
  assert.equal(restored.snapshot().timeline[0].reactions.bob, "👍");
  await restored.runtime.getValue().reactToMessage("circle", "t0", null);
  assert.equal(restored.snapshot().timeline[0].reactions.bob, undefined);
});

for (const [sender, emoji, author, expected] of [
  ["bob", "🎉", "alice", true],
  ["outsider", "❤️", "alice", false],
  ["bob", "invalid", "alice", false],
  ["bob", "❤️", "someone-else", false],
])
  test(`received reactions bind member and target: ${sender}/${emoji}/${author}`, async () => {
    const h = await harness({
      sender,
      payload: { type: "reaction", messageId: "react-message", authorId: author, emoji },
      saved: { circles: [joined()], timeline: [reactionMessage] },
    });
    await h.runtime.synchronize();
    assert.equal(
      h.snapshot().timeline[0].reactions?.[sender],
      expected ? emoji : undefined,
    );
    assert.equal(h.snapshot().timeline.length, 1);
    assert.equal(h.notifications.length, 0);
  });

test("removing a reaction only affects the authenticated sender", async () => {
  const h = await harness({
    sender: "bob",
    payload: {
      type: "reaction",
      messageId: "react-message",
      authorId: "alice",
      emoji: null,
    },
    saved: {
      circles: [joined()],
      timeline: [{ ...reactionMessage, reactions: { alice: "❤️", bob: "👍" } }],
    },
  });
  await h.runtime.synchronize();
  assert.equal(h.snapshot().timeline[0].reactions.bob, undefined);
  assert.equal(h.snapshot().timeline[0].reactions.alice, "❤️");
});

test("a reaction to an offline outgoing message is encrypted after its target chat", async () => {
  const h = await harness({ saved: { circles: [joined({ lastSeenSequenceId: 8 })] } });
  await h.runtime.initialize();
  h.offline(true);
  await h.runtime.getValue().sendMessage("circle", "Offline draft");
  const item = h.snapshot().timeline.at(-1);
  await h.runtime.getValue().reactToMessage("circle", item.id, "❤️");
  h.offline(false);
  await h.runtime.synchronize();
  const types = h.queued
    .filter((e) => e.plaintext)
    .map((e) => JSON.parse(e.plaintext).type);
  assert.deepEqual(types, ["chat", "reaction"]);
});

test("unknown or legacy targets and removed memberships cannot queue reactions", async () => {
  const h = await harness({
    saved: {
      circles: [joined({ role: "removed", lastSeenSequenceId: 8 })],
      timeline: [reactionMessage],
    },
  });
  await h.runtime.initialize();
  assert.equal(await h.runtime.getValue().reactToMessage("circle", "t0", "❤️"), false);
  assert.equal(
    await h.runtime.getValue().reactToMessage("circle", "missing", "❤️"),
    false,
  );
});

for (const [emoji, previous, muted, expected] of [
  ["❤️", undefined, false, 1],
  ["👍", "❤️", false, 1],
  ["❤️", "❤️", false, 0],
  [null, "❤️", false, 0],
  ["❤️", undefined, true, 0],
])
  test(`reaction notifications only for new reactions to your messages: ${emoji}/${previous}/${muted}`, async () => {
    const h = await harness({
      sender: "alice",
      payload: { type: "reaction", messageId: "react-message", authorId: "bob", emoji },
      saved: {
        circles: [
          joined({
            notifications: {
              chat: !muted,
              location: true,
              quietHours: false,
              quietStart: "22:00",
              quietEnd: "08:00",
            },
          }),
        ],
        timeline: [
          {
            ...reactionMessage,
            senderId: "bob",
            reactions: previous ? { alice: previous } : {},
          },
        ],
      },
    });
    await h.runtime.synchronize();
    assert.equal(h.notifications.length, expected);
    if (expected)
      assert.equal(
        h.notifications[0].body,
        `Alice reacted ${emoji} to your message: Reaction test`,
      );
    await h.runtime.synchronize();
    assert.equal(h.notifications.length, expected);
  });

test("reacting to your own message never notifies yourself", async () => {
  const h = await harness({
    sender: "bob",
    payload: {
      type: "reaction",
      messageId: "react-message",
      authorId: "bob",
      emoji: "❤️",
    },
    saved: { circles: [joined()], timeline: [{ ...reactionMessage, senderId: "bob" }] },
  });
  await h.runtime.synchronize();
  assert.equal(h.notifications.length, 0);
});

test("alternating reactions from one member are notification-throttled per message", async () => {
  const h = await harness({
    sender: "alice",
    payloads: [
      { type: "reaction", messageId: "react-message", authorId: "bob", emoji: "❤️" },
      { type: "reaction", messageId: "react-message", authorId: "bob", emoji: "👍" },
    ],
    saved: { circles: [joined()], timeline: [{ ...reactionMessage, senderId: "bob" }] },
  });
  await h.runtime.synchronize();
  await h.runtime.synchronize();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.snapshot().timeline[0].reactions.alice, "👍");
});

// Rich-message payloads live together below. They share the same delivery
// machinery, but each format has its own validation and cleanup rules.

const profilePhoto = "data:image/jpeg;base64,/9j/2Q==";
test("profile photo saves offline and survives cold resume with a pending encrypted broadcast", async () => {
  const first = await harness();
  first.offline(true);
  assert.equal(await first.runtime.getValue().setProfilePhoto(profilePhoto), true);
  const saved = structuredClone(first.snapshot());
  assert.equal(saved.profilePhotos.bob, profilePhoto);
  assert.ok(
    saved.circles[0].pendingBroadcasts.some(
      (value) => JSON.parse(value).type === "profile-photo",
    ),
  );
  const second = await harness({ saved });
  second.offline(true);
  await second.runtime.initialize();
  assert.equal(second.snapshot().profilePhotos.bob, profilePhoto);
  assert.equal(await second.runtime.getValue().setProfilePhoto(null), true);
  assert.equal(second.snapshot().profilePhotos.bob, null);
  assert.ok(
    second.snapshot().circles[0].pendingBroadcasts.some((value) => {
      const p = JSON.parse(value);
      return p.type === "profile-photo" && p.photo === null;
    }),
  );
});
test("authenticated photo updates only the sender and creates no chat or notification", async () => {
  const h = await harness({
    payload: { type: "profile-photo", photo: profilePhoto, deviceId: "bob" },
  });
  await h.runtime.synchronize();
  assert.equal(h.snapshot().profilePhotos.alice, profilePhoto);
  assert.equal(h.snapshot().profilePhotos.bob, undefined);
  assert.equal(h.snapshot().timeline.length, 0);
  assert.equal(h.notifications.length, 0);
});
test("photo removal received from a member persists across restart", async () => {
  const h = await harness({
    saved: { profilePhotos: { alice: profilePhoto } },
    payload: { type: "profile-photo", photo: null },
  });
  await h.runtime.synchronize();
  const next = await harness({ saved: structuredClone(h.snapshot()) });
  await next.runtime.initialize();
  assert.equal(next.snapshot().profilePhotos.alice, null);
});
for (const photo of [
  "https://example.com/photo.jpg",
  "file:///private/photo.jpg",
  "data:image/svg+xml;base64,PHN2Zz4=",
  "data:image/jpeg;base64,/9j/" + "A".repeat(32768),
  123,
]) {
  test("invalid profile photo is rejected: " + String(photo).slice(0, 45), async () => {
    const h = await harness({ payload: { type: "profile-photo", photo } });
    await h.runtime.synchronize();
    assert.equal(h.snapshot().profilePhotos.alice, undefined);
    assert.equal(await h.runtime.getValue().setProfilePhoto(photo), false);
  });
}
test("non-member cannot publish a profile photo", async () => {
  const h = await harness({
    sender: "outsider",
    payload: { type: "profile-photo", photo: profilePhoto },
  });
  await h.runtime.synchronize();
  assert.equal(h.snapshot().profilePhotos.outsider, undefined);
});

test("setup photo is saved before joining any Circle", async () => {
  const h = await harness({ missing: true, allowCreation: true });
  await h.runtime.initialize();
  await h.identity.createNewIdentity();
  h.identity.confirmSeedPhraseSaved();
  h.identity.finishNickname("New person", profilePhoto);
  h.identity.finishSetup();
  await h.runtime.initialize();
  const saved = structuredClone(h.snapshot());
  assert.equal(saved.profilePhotos.bob, profilePhoto);
  assert.equal(saved.nicknames.bob, "New person");
  assert.equal(saved.circles.length, 0);
  const resumed = await harness({ saved });
  await resumed.runtime.initialize();
  assert.equal(resumed.snapshot().profilePhotos.bob, profilePhoto);
});

test("a newly joined member receives the current profile photo", async () => {
  const h = await harness({
    saved: { profilePhotos: { bob: profilePhoto } },
    envelopeKind: "commit",
  });
  await h.runtime.initialize();
  h.changeMembers(["alice", "bob", "charlie"]);
  await h.runtime.synchronize();
  assert.ok(
    h.encrypted.some((p) => p.type === "profile-photo" && p.photo === profilePhoto),
  );
});

const voiceClip = {
  mimeType: "audio/mp4",
  base64: "AAAAHGZ0eXBNNEEgAAAAAA==",
  durationMs: 2400,
};
test("voice messages queue offline, survive restart, and encrypt with their stable chat ID", async () => {
  const h = await harness();
  h.offline(true);
  assert.equal(await h.runtime.getValue().sendVoiceMessage("circle", voiceClip), true);
  const saved = structuredClone(h.snapshot());
  const item = saved.timeline.find((i) => i.voice);
  assert.equal(item.text, "Voice message · 0:02");
  assert.equal(item.delivery, "waiting");
  assert.equal(saved.circles[0].pendingChats[0].messageId, item.messageId);
  const resumed = await harness({ saved });
  await resumed.runtime.synchronize();
  const payload = resumed.encrypted.find((p) => p.voice);
  assert.equal(payload.messageId, item.messageId);
  assert.equal(payload.voice.base64, voiceClip.base64);
  assert.equal(
    resumed.snapshot().timeline.find((i) => i.voice).voice.base64,
    voiceClip.base64,
  );
});
test("received voice message gets a receipt, one notification and can be reacted to", async () => {
  const h = await harness({
    payload: {
      type: "chat",
      text: "ignored voice caption",
      messageId: "voice-id",
      voice: voiceClip,
    },
  });
  await h.runtime.synchronize();
  await h.runtime.synchronize();
  const item = h.snapshot().timeline.find((i) => i.voice);
  assert.equal(item.senderId, "alice");
  assert.equal(item.text, "Voice message · 0:02");
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].body, "Alice: Voice message · 0:02");
  assert.ok(h.encrypted.some((p) => p.type === "receipt" && p.messageId === "voice-id"));
  assert.equal(await h.runtime.getValue().reactToMessage("circle", item.id, "❤️"), true);
  assert.equal(h.snapshot().timeline.find((i) => i.voice).reactions.bob, "❤️");
});
for (const voice of [
  null,
  { ...voiceClip, durationMs: 60001 },
  { ...voiceClip, durationMs: NaN },
  { ...voiceClip, mimeType: "text/html" },
  { ...voiceClip, base64: "https://example.com/audio" },
  { ...voiceClip, base64: "A".repeat(192 * 1024 + 4) },
]) {
  test(
    "invalid voice payload is rejected: " + JSON.stringify(voice).slice(0, 80),
    async () => {
      const h = await harness({
        payload: { type: "chat", text: "Voice message", messageId: "bad", voice },
      });
      await h.runtime.synchronize();
      assert.equal(
        h.snapshot().timeline.some((i) => i.voice),
        false,
      );
      assert.equal(await h.runtime.getValue().sendVoiceMessage("circle", voice), false);
    },
  );
}
test("removed or recovering circles cannot send voice messages", async () => {
  for (const patch of [
    { role: "removed" },
    { recoveryRequired: true },
    { deleting: true },
  ]) {
    const h = await harness({
      saved: {
        circles: [
          {
            circleId: "circle",
            mailboxId: "mailbox",
            role: "member",
            members: ["alice", "bob"],
            ...patch,
          },
        ],
      },
    });
    assert.equal(await h.runtime.getValue().sendVoiceMessage("circle", voiceClip), false);
  }
});

// Replies, edits, and deletion all point at stable message IDs. Keeping one
// recognizable original makes those relationships easier to follow.
const replyOriginal = {
  id: "t40",
  circleId: "circle",
  kind: "chat",
  senderId: "alice",
  text: "Original message",
  at: 1,
  messageId: "original-id",
};
test("reply queues offline with authenticated target reference and survives restart", async () => {
  const h = await harness({ saved: { timeline: [replyOriginal] } });
  h.offline(true);
  assert.equal(await h.runtime.getValue().sendMessage("circle", "My reply", "t40"), true);
  const saved = structuredClone(h.snapshot());
  const reply = saved.timeline.find((i) => i.text === "My reply");
  assert.deepEqual(reply.replyTo, { messageId: "original-id", senderId: "alice" });
  assert.equal(saved.circles[0].pendingChats[0].replyTo.messageId, "original-id");
  const resumed = await harness({ saved });
  await resumed.runtime.synchronize();
  const outgoing = resumed.encrypted.find((p) => p.text === "My reply");
  assert.equal(outgoing.replyTo.senderId, "alice");
  assert.equal(outgoing.messageId, reply.messageId);
  assert.equal(
    resumed.snapshot().timeline.find((i) => i.text === "My reply").replyTo.messageId,
    "original-id",
  );
});
test("voice replies retain their target and may reply to a voice message", async () => {
  const h = await harness({
    saved: {
      timeline: [{ ...replyOriginal, voice: voiceClip, text: "Voice message · 0:02" }],
    },
  });
  h.offline(true);
  assert.equal(
    await h.runtime.getValue().sendVoiceMessage("circle", voiceClip, "t40"),
    true,
  );
  const reply = h.snapshot().timeline.find((i) => i.senderId === "bob");
  assert.equal(reply.replyTo.messageId, "original-id");
  assert.equal(reply.voice.base64, voiceClip.base64);
});
test("received replies preserve stable reference, get receipts, and do not duplicate", async () => {
  const h = await harness({
    saved: { timeline: [replyOriginal] },
    sender: "bob",
    payload: {
      type: "chat",
      text: "Reply",
      messageId: "reply-id",
      replyTo: { messageId: "original-id", senderId: "alice", text: "forged quote" },
    },
  });
  await h.runtime.synchronize();
  await h.runtime.synchronize();
  const replies = h.snapshot().timeline.filter((i) => i.messageId === "reply-id");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].replyTo.messageId, "original-id");
  assert.equal(replies[0].replyTo.text, undefined);
  assert.equal(
    h.snapshot().timeline.find((i) => i.messageId === "original-id").text,
    "Original message",
  );
});
test("a reply whose original is absent is retained without inventing quoted text", async () => {
  const h = await harness({
    payload: {
      type: "chat",
      text: "New reply",
      messageId: "reply-id",
      replyTo: { messageId: "not-on-this-phone", senderId: "bob" },
    },
  });
  await h.runtime.synchronize();
  const item = h.snapshot().timeline.find((i) => i.text === "New reply");
  assert.equal(item.replyTo.messageId, "not-on-this-phone");
  assert.equal(h.notifications.length, 1);
  assert.ok(h.encrypted.some((p) => p.type === "receipt" && p.messageId === "reply-id"));
});
for (const target of [
  { ...replyOriginal, circleId: "another-circle" },
  { ...replyOriginal, kind: "system" },
  { ...replyOriginal, messageId: undefined },
])
  test("invalid local reply target is not sent " + JSON.stringify(target), async () => {
    const h = await harness({ saved: { timeline: [target] } });
    h.offline(true);
    assert.equal(await h.runtime.getValue().sendMessage("circle", "Reply", "t40"), false);
    assert.equal(
      await h.runtime.getValue().sendVoiceMessage("circle", voiceClip, "missing"),
      false,
    );
  });
for (const replyTo of [
  null,
  {},
  { messageId: 123, senderId: "alice" },
  { messageId: "A".repeat(129), senderId: "alice" },
  { messageId: "valid", senderId: "" },
])
  test(
    "malformed reply reference cannot hide its chat message " + JSON.stringify(replyTo),
    async () => {
      const h = await harness({
        payload: {
          type: "chat",
          text: "Keep this message",
          messageId: "reply-id",
          replyTo,
        },
      });
      await h.runtime.synchronize();
      const item = h.snapshot().timeline.find((i) => i.messageId === "reply-id");
      assert.ok(item);
      assert.equal(item.replyTo, undefined);
    },
  );

const editable = (patch = {}) => ({
  ...replyOriginal,
  senderId: "bob",
  at: Date.now() - 1000,
  sentAt: Date.now() - 1000,
  ...patch,
});
test("own edits preserve the first version across repeat edits and restart", async () => {
  const h = await harness({ saved: { timeline: [editable()] } });
  h.offline(true);
  assert.equal(
    await h.runtime.getValue().editMessage("circle", "t40", "First edit"),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(
    await h.runtime.getValue().editMessage("circle", "t40", "Second edit"),
    true,
  );
  const saved = structuredClone(h.snapshot());
  assert.equal(saved.timeline[0].originalText, "Original message");
  assert.equal(saved.timeline[0].text, "Second edit");
  const resumed = await harness({ saved });
  await resumed.runtime.synchronize();
  assert.equal(resumed.snapshot().timeline[0].originalText, "Original message");
  assert.equal(resumed.encrypted.filter((p) => p.type === "message-edit").length, 2);
});
for (const patch of [
  { senderId: "alice" },
  { at: 1, sentAt: 1 },
  { deletedAt: Date.now() },
  { kind: "system" },
  { messageId: undefined },
]) {
  test(
    "local edit/delete reject ineligible target " + JSON.stringify(patch),
    async () => {
      const h = await harness({ saved: { timeline: [editable(patch)] } });
      h.offline(true);
      assert.equal(
        await h.runtime.getValue().editMessage("circle", "t40", "Changed"),
        false,
      );
      assert.equal(await h.runtime.getValue().deleteMessage("circle", "t40"), false);
    },
  );
}
test("no-op edit does not mark or broadcast a change", async () => {
  const h = await harness({ saved: { timeline: [editable()] } });
  h.offline(true);
  assert.equal(
    await h.runtime.getValue().editMessage("circle", "t40", "Original message"),
    true,
  );
  assert.equal(h.snapshot().timeline[0].editedAt, undefined);
  assert.equal(h.snapshot().circles[0].pendingBroadcasts?.length ?? 0, 0);
});
test("incoming authenticated edit preserves original and rejects other authors", async () => {
  for (const sender of ["alice", "bob", "outsider"]) {
    const item = editable({ senderId: "alice" });
    const h = await harness({
      sender,
      saved: { timeline: [item] },
      payload: {
        type: "message-edit",
        messageId: item.messageId,
        text: "Updated",
        at: Date.now(),
      },
    });
    await h.runtime.synchronize();
    assert.equal(
      h.snapshot().timeline[0].text,
      sender === "alice" ? "Updated" : "Original message",
    );
  }
});
test("incoming delete erases audio, history and reactions and prevents resurrection", async () => {
  const item = editable({
    senderId: "alice",
    voice: voiceClip,
    originalText: "old",
    editedAt: Date.now() - 500,
    reactions: { bob: "❤️" },
  });
  const h = await harness({
    saved: { timeline: [item] },
    payload: { type: "message-delete", messageId: item.messageId, at: Date.now() },
  });
  await h.runtime.synchronize();
  const deleted = h.snapshot().timeline[0];
  assert.ok(deleted.deletedAt);
  assert.equal(deleted.text, "");
  for (const key of ["voice", "originalText", "editedAt", "reactions"])
    assert.equal(deleted[key], undefined);
  assert.equal(await h.runtime.getValue().reactToMessage("circle", "t40", "❤️"), false);
  assert.equal(await h.runtime.getValue().sendMessage("circle", "Reply", "t40"), false);
  const resumed = await harness({
    saved: structuredClone(h.snapshot()),
    payload: {
      type: "message-edit",
      messageId: item.messageId,
      text: "Resurrected",
      at: Date.now(),
    },
  });
  await resumed.runtime.synchronize();
  assert.equal(resumed.snapshot().timeline[0].text, "");
});
test("deleting an unsealed offline message cancels publication, including queued edits", async () => {
  const h = await harness();
  h.offline(true);
  await h.runtime.getValue().sendMessage("circle", "Never publish");
  const item = h.snapshot().timeline.find((i) => i.text === "Never publish");
  await h.runtime.getValue().editMessage("circle", item.id, "Still private");
  assert.equal(await h.runtime.getValue().deleteMessage("circle", item.id), true);
  const saved = structuredClone(h.snapshot());
  assert.equal(saved.circles[0].pendingChats.length, 0);
  assert.equal(saved.circles[0].pendingBroadcasts.length, 0);
  const resumed = await harness({ saved });
  await resumed.runtime.synchronize();
  assert.equal(
    resumed.encrypted.some((p) => p.messageId === item.messageId),
    false,
  );
});
test("offline original is published before its edit", async () => {
  const h = await harness();
  h.offline(true);
  await h.runtime.getValue().sendMessage("circle", "Original queued");
  const item = h.snapshot().timeline.find((i) => i.text === "Original queued");
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(
    await h.runtime.getValue().editMessage("circle", item.id, "Edited queued"),
    true,
  );
  const resumed = await harness({ saved: structuredClone(h.snapshot()) });
  await resumed.runtime.synchronize();
  const outgoing = resumed.encrypted.filter((p) => p.messageId === item.messageId);
  assert.deepEqual(
    outgoing.map((p) => p.type),
    ["chat", "message-edit"],
  );
});

test("library reactions survive offline sending and restart, and can be removed", async () => {
  const h = await harness({ saved: { timeline: [replyOriginal] } });
  h.offline(true);
  assert.equal(await h.runtime.getValue().reactToMessage("circle", "t40", "👍🏽"), true);
  const saved = structuredClone(h.snapshot());
  assert.equal(saved.timeline[0].reactions.bob, "👍🏽");
  const resumed = await harness({ saved });
  await resumed.runtime.synchronize();
  assert.ok(resumed.encrypted.some((p) => p.type === "reaction" && p.emoji === "👍🏽"));
  assert.equal(
    await resumed.runtime.getValue().reactToMessage("circle", "t40", null),
    true,
  );
  assert.equal(resumed.snapshot().timeline[0].reactions.bob, undefined);
});
test("incoming emoji outside the original hotbar is displayed and notifies the author", async () => {
  const h = await harness({
    saved: { timeline: [{ ...replyOriginal, senderId: "bob" }] },
    sender: "alice",
    payload: {
      type: "reaction",
      messageId: replyOriginal.messageId,
      authorId: "bob",
      emoji: "🔥",
    },
  });
  await h.runtime.synchronize();
  assert.equal(h.snapshot().timeline[0].reactions.alice, "🔥");
  assert.equal(h.notifications.length, 1);
});

// Attachment metadata travels before its chunks, so the tests intentionally
// model an ordinary text file that can be inspected without a media decoder.
const fileAttachment = {
  name: "test.txt",
  mimeType: "text/plain",
  kind: "file",
  size: 5,
  base64: "SGVsbG8=",
};
test("attachment queues offline with reply, survives restart, and sends metadata then encrypted chunks", async () => {
  const h = await harness({ saved: { timeline: [replyOriginal] } });
  h.offline(true);
  assert.equal(
    await h.runtime.getValue().sendAttachment("circle", fileAttachment, "t40"),
    true,
  );
  const saved = structuredClone(h.snapshot());
  const item = saved.timeline.find((i) => i.attachment);
  assert.equal(item.attachment.base64, fileAttachment.base64);
  assert.equal(item.replyTo.messageId, "original-id");
  const resumed = await harness({ saved });
  await resumed.runtime.synchronize();
  const payloads = resumed.encrypted.filter((p) => p.messageId === item.messageId);
  assert.deepEqual(
    payloads.map((p) => p.type),
    ["chat", "attachment-chunk"],
  );
  assert.equal(payloads[0].attachment.base64, undefined);
  assert.equal(payloads[1].data, fileAttachment.base64);
});
test("incoming attachment metadata shows receiving state and withholds receipt until bytes arrive", async () => {
  const { base64, ...info } = fileAttachment;
  const h = await harness({
    payload: { type: "chat", messageId: "file", text: "ignored", attachment: info },
  });
  await h.runtime.synchronize();
  const saved = structuredClone(h.snapshot());
  const item = saved.timeline.find((i) => i.messageId === "file");
  assert.equal(item.attachment.base64, "");
  assert.equal(item.text, "File · test.txt");
  assert.equal(
    h.encrypted.some((p) => p.type === "receipt" && p.messageId === "file"),
    false,
  );
  for (const sender of ["alice", "bob", "outsider"]) {
    const next = structuredClone(saved);
    next.circles[0].lastSeenSequenceId = 7;
    const received = await harness({
      saved: next,
      sender,
      payload: { type: "attachment-chunk", messageId: "file", index: 0, data: base64 },
    });
    await received.runtime.synchronize();
    const result = received.snapshot().timeline.find((i) => i.messageId === "file");
    assert.equal(result.attachment.base64, sender === "alice" ? base64 : "");
    assert.equal(
      received.encrypted.some((p) => p.type === "receipt" && p.messageId === "file"),
      sender === "alice",
    );
  }
});
test("attachments cannot be edited and deletion clears bytes and incomplete chunks", async () => {
  const item = editable({ attachment: fileAttachment, attachmentParts: { 0: "SGVs" } });
  const h = await harness({ saved: { timeline: [item] } });
  h.offline(true);
  assert.equal(
    await h.runtime.getValue().editMessage("circle", item.id, "Changed"),
    false,
  );
  assert.equal(await h.runtime.getValue().deleteMessage("circle", item.id), true);
  assert.equal(h.snapshot().timeline[0].attachment, undefined);
  assert.equal(h.snapshot().timeline[0].attachmentParts, undefined);
});
test("invalid attachment and removed memberships cannot queue bytes", async () => {
  const h = await harness();
  h.offline(true);
  assert.equal(
    await h.runtime
      .getValue()
      .sendAttachment("circle", { ...fileAttachment, size: 100000000 }),
    false,
  );
  const removed = await harness({
    saved: {
      circles: [
        {
          circleId: "circle",
          mailboxId: "mailbox",
          role: "removed",
          members: ["alice", "bob"],
        },
      ],
    },
  });
  assert.equal(
    await removed.runtime.getValue().sendAttachment("circle", fileAttachment),
    false,
  );
});
test("attachment remains waiting until its final chunk is acknowledged", async () => {
  const h = await harness();
  h.offline(true);
  await h.runtime.getValue().sendAttachment("circle", fileAttachment);
  const item = h.snapshot().timeline.find((i) => i.attachment);
  h.ack({
    mailboxId: "mailbox",
    kind: "application",
    plaintext: JSON.stringify({ type: "chat", messageId: item.messageId }),
  });
  assert.equal(h.snapshot().timeline.find((i) => i.attachment).delivery, "waiting");
  h.ack({
    mailboxId: "mailbox",
    kind: "application",
    plaintext: JSON.stringify({
      type: "attachment-chunk",
      messageId: item.messageId,
      index: 0,
    }),
  });
  assert.equal(h.snapshot().timeline.find((i) => i.attachment).delivery, "sent");
});

test("malformed application data cannot block a later valid message or advance twice", async () => {
  const payloads = [
    null,
    { type: "nickname", nickname: {} },
    { type: "future-payload" },
    { type: "chat", text: "Still arrives", messageId: "valid-after-malformed" },
  ];
  const h = await harness({ payloads });
  for (const _payload of payloads) await h.runtime.synchronize();
  assert.equal(
    h.runtime.getValue().timeline.filter((item) => item.kind === "chat").length,
    1,
  );
  assert.equal(
    h.runtime.getValue().timeline.find((item) => item.kind === "chat").text,
    "Still arrives",
  );
  assert.equal(h.snapshot().circles[0].lastSeenSequenceId, 7 + payloads.length);
  assert.equal(h.runtime.getValue().circles.circle.syncError, undefined);
  await h.runtime.synchronize();
  assert.equal(
    h.runtime.getValue().timeline.filter((item) => item.kind === "chat").length,
    1,
  );
});
