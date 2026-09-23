import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { canChangeMessage, applyMessageChange, MESSAGE_ACTION_WINDOW_MS: window } =
  await loadTypeScriptModule("src/message-actions.ts");
const item = {
  id: "1",
  kind: "chat",
  circleId: "circle",
  senderId: "alice",
  messageId: "a",
  text: "Original",
  at: 1000,
  sentAt: 1000,
};
test("15-minute deadline is exclusive and shared send time governs delayed receipts", () => {
  assert.equal(canChangeMessage(item, "alice", 1000 + window - 1), true);
  assert.equal(canChangeMessage(item, "alice", 1000 + window), false);
  assert.equal(canChangeMessage({ ...item, at: 1000 + window }, "alice", 1000 + window), false);
  assert.equal(canChangeMessage(item, "bob", 1001), false);
  for (const at of [999, 1000 + window, Infinity, NaN]) {
    for (const type of ["message-edit", "message-delete"])
      assert.equal(
        applyMessageChange(item, "alice", { type, messageId: "a", at, text: "Changed" }),
        item,
      );
  }
});
test("malformed, stale and unauthorized changes cannot overwrite history", () => {
  for (const text of ["", "  ", "x".repeat(10001), null])
    assert.equal(
      applyMessageChange(item, "alice", { type: "message-edit", messageId: "a", at: 2000, text }),
      item,
    );
  assert.equal(
    applyMessageChange(item, "bob", { type: "message-delete", messageId: "a", at: 2000 }),
    item,
  );
  const edited = applyMessageChange(item, "alice", {
    type: "message-edit",
    messageId: "a",
    at: 3000,
    text: "Changed",
  });
  assert.equal(
    applyMessageChange(edited, "alice", {
      type: "message-edit",
      messageId: "a",
      at: 2000,
      text: "Stale",
    }),
    edited,
  );
  assert.equal(
    applyMessageChange({ ...item, voice: {} }, "alice", {
      type: "message-edit",
      messageId: "a",
      at: 2000,
      text: "No",
    }).text,
    "Original",
  );
});
