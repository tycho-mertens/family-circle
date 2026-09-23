import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { continuesMessageGroup, messageGroupDisplay, groupDeliveryStatus } =
  await loadTypeScriptModule("src/message-groups.ts");
const base = {
  id: "a",
  kind: "chat",
  circleId: "circle",
  senderId: "alice",
  text: "Hello",
  at: new Date(2026, 8, 10, 12, 0).getTime(),
  delivery: "delivered",
  recipients: ["bob"],
  deliveredTo: ["bob"],
};
const later = (ms, patch = {}) => ({ ...base, id: String(ms), at: base.at + ms, ...patch });
test("consecutive messages group below one minute, but not at the boundary", () => {
  assert.equal(continuesMessageGroup(base, later(59999)), true);
  assert.equal(continuesMessageGroup(base, later(60000)), false);
  assert.equal(continuesMessageGroup(base, later(-1)), false);
});
test("sender changes, system events, other circles and midnight break a group", () => {
  for (const patch of [
    { senderId: "bob" },
    { kind: "system" },
    { circleId: "other" },
    { senderId: undefined },
  ])
    assert.equal(continuesMessageGroup(base, later(1, patch)), false);
  const midnight = new Date(2026, 8, 11).getTime();
  assert.equal(
    continuesMessageGroup({ ...base, at: midnight - 1 }, { ...base, at: midnight }),
    false,
  );
});
test("one header and one delivery footer per group, including text, replies and voice", () => {
  const items = [
    base,
    later(30000, { voice: {} }),
    later(89000, { replyTo: {} }),
    later(149000),
    later(149001, { senderId: "bob" }),
    later(149002, { kind: "system" }),
    later(149003, { senderId: "bob" }),
  ];
  const groups = messageGroupDisplay(items);
  assert.deepEqual(
    Array.from(groups, (g) => g.startsGroup),
    [true, false, false, true, true, true, true],
  );
  assert.deepEqual(
    Array.from(groups, (g) => g.endsGroup),
    [false, false, true, true, true, true, true],
  );
  assert.equal(groups[0].time, undefined);
  assert.equal(groups[1].status, undefined);
  assert.ok(groups.every((group) => group.time === undefined));
  assert.equal(groups[2].status, undefined);
  assert.equal(groups[3].status, "Delivered");
  assert.equal(groups[5].time, undefined);
});
test("group status never hides waiting or sent messages behind a later delivery", () => {
  assert.equal(
    groupDeliveryStatus([{ ...base, delivery: "waiting" }, base]),
    "Waiting for connection",
  );
  assert.equal(groupDeliveryStatus([base, { ...base, delivery: "sent" }]), "Sent");
  assert.equal(groupDeliveryStatus([base, { ...base, delivery: undefined }]), undefined);
});
test("partial group delivery counts recipients who received every addressed message", () => {
  const first = { ...base, recipients: ["bob", "carol"], deliveredTo: ["bob"] };
  const second = { ...base, recipients: ["bob", "carol"], deliveredTo: ["carol"] };
  assert.equal(groupDeliveryStatus([first, second]), "Delivered to 0/2");
  assert.equal(
    groupDeliveryStatus([first, { ...second, deliveredTo: ["bob", "carol"] }]),
    "Delivered to 1/2",
  );
  assert.equal(
    groupDeliveryStatus([
      { ...first, deliveredTo: ["bob", "carol"] },
      { ...second, deliveredTo: ["bob", "carol"] },
    ]),
    "Delivered to 2/2",
  );
});
test("empty history has no invented status", () => {
  assert.equal(messageGroupDisplay([]).length, 0);
  assert.equal(groupDeliveryStatus([]), undefined);
});

test("delivered footers span minute and day gaps without changing bubble grouping", () => {
  const groups = messageGroupDisplay([base, later(60000), later(86400000)]);
  assert.deepEqual(
    Array.from(groups, (g) => g.status),
    [undefined, undefined, "Delivered"],
  );
  assert.ok(groups.every((g) => g.startsGroup && g.endsGroup));
});
test("waiting, sent and partial deliveries retain individual footers even inside a bubble group", () => {
  const groups = messageGroupDisplay([
    base,
    later(1, { delivery: "waiting" }),
    later(2, { delivery: "waiting" }),
    later(3, { delivery: "sent" }),
    later(4, { recipients: ["bob", "carol"] }),
    later(5),
    later(6),
  ]);
  assert.deepEqual(
    Array.from(groups, (g) => g.status),
    [
      "Delivered",
      "Waiting for connection",
      "Waiting for connection",
      "Sent",
      "Delivered to 1/2",
      undefined,
      "Delivered",
    ],
  );
  assert.equal(groups[1].endsGroup, false);
});
test("receipt groups stop at sender, circle, system or unknown delivery boundaries", () => {
  for (const patch of [
    { senderId: "bob" },
    { circleId: "other" },
    { kind: "system" },
    { delivery: undefined },
  ]) {
    const groups = messageGroupDisplay([base, later(1, patch), later(2)]);
    assert.equal(groups[0].status, "Delivered");
    assert.equal(groups[2].status, "Delivered");
  }
});
