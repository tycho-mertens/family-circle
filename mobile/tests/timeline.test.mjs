import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";
const { createTimeline } = await loadTypeScriptModule("src/runtime/timeline.ts");
function setup() {
  let changes = 0;
  const circles = {
    c: { members: ["alice", "bob"], mailboxId: "mailbox" },
    other: { members: ["alice", "bob"], mailboxId: "other-mailbox" },
  };
  const timeline = createTimeline({
    getCircle: (id) => circles[id],
    onChange: () => changes++,
  });
  const chat = {
    circleId: "c",
    senderId: "alice",
    text: "Hello",
    messageId: "message",
    own: true,
  };
  return { timeline, chat, circles, changes: () => changes };
}

test("restoring a checkpoint rolls back edits and resumes IDs without collisions", () => {
  const { timeline, chat } = setup();
  timeline.restore([{ id: "t40", circleId: "c", kind: "system", at: 1, text: "Restored" }]);
  timeline.appendChat(chat);
  const checkpoint = timeline.snapshot();
  const original = checkpoint[1];
  timeline.changeMessage("c", "alice", {
    type: "message-edit",
    messageId: "message",
    text: "Edited",
    at: original.at,
  });
  timeline.appendSystem("c", "Uncommitted");
  assert.equal(checkpoint[1].text, "Hello");
  timeline.restore(checkpoint);
  timeline.appendSystem("c", "Committed");
  assert.equal(timeline.snapshot()[1].text, "Hello");
  assert.equal(timeline.snapshot()[2].id, "t42");
});

test("deduplication includes circle and author, and leaving rejects new entries", () => {
  const { timeline, chat, circles, changes } = setup();
  assert.equal(timeline.appendChat(chat), true);
  assert.equal(timeline.appendChat(chat), false);
  timeline.appendChat({ ...chat, senderId: "bob" });
  timeline.appendChat({ ...chat, circleId: "other" });
  assert.equal(changes(), 3);
  circles.c.deleting = true;
  timeline.appendChat({ ...chat, messageId: "later" });
  timeline.appendSystem("c", "Later");
  assert.equal(changes(), 3);
});

test("acknowledgements cannot downgrade delivery or affect another mailbox", () => {
  const { timeline, chat } = setup();
  timeline.appendChat(chat);
  timeline.appendChat({ ...chat, circleId: "other" });
  timeline.markDelivered("c", "message", "alice", "stranger");
  assert.equal(timeline.snapshot()[0].delivery, "waiting");
  timeline.markDelivered("c", "message", "alice", "bob");
  timeline.markDelivered("c", "message", "alice", "bob");
  timeline.markSent("mailbox", "alice", { type: "chat", messageId: "message", text: "Hello" });
  assert.equal(timeline.snapshot()[0].delivery, "delivered");
  assert.equal(timeline.snapshot()[0].deliveredTo.length, 1);
  assert.equal(timeline.snapshot()[1].delivery, "waiting");
});

test("reactions stay scoped to their author and deletion prevents resurrection", () => {
  const { timeline, chat } = setup();
  timeline.appendChat(chat);
  timeline.appendChat({ ...chat, senderId: "bob" });
  timeline.applyReaction("c", "message", "alice", "bob", "❤️");
  assert.equal(timeline.snapshot()[0].reactions.bob, "❤️");
  assert.equal(timeline.snapshot()[1].reactions, undefined);
  timeline.changeMessage("c", "alice", {
    type: "message-delete",
    messageId: "message",
    at: timeline.snapshot()[0].at,
  });
  timeline.applyReaction("c", "message", "alice", "bob", "👍");
  assert.equal(timeline.snapshot()[0].reactions, undefined);
  assert.ok(timeline.snapshot()[0].deletedAt);
});
