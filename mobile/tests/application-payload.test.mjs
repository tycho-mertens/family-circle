import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";
const { decodeApplicationPayload } = await loadTypeScriptModule(
  "src/runtime/application-payload.ts",
);
const decode = (value) =>
  decodeApplicationPayload(new TextEncoder().encode(JSON.stringify(value)));

test("malformed JSON, unknown kinds, and malformed required fields are ignored", () => {
  assert.equal(decodeApplicationPayload(new TextEncoder().encode("{")), null);
  for (const value of [
    null,
    [],
    4,
    {},
    { type: "future" },
    { type: "nickname", nickname: {} },
    { type: "circle-rename", name: null },
    { type: "admin-transfer", id: "i", adminId: 4 },
    { type: "reaction", messageId: "i", authorId: "alice", emoji: "bad" },
    { type: "attachment-chunk", messageId: "i", index: -1, data: "YQ==" },
  ]) {
    assert.equal(decode(value), null, JSON.stringify(value));
  }
});

test("legacy chats survive invalid optional metadata", () => {
  const payload = decode({
    type: "chat",
    text: "Hello",
    messageId: 3,
    sentAt: "yesterday",
    replyTo: { messageId: 5 },
  });
  assert.equal(payload.text, "Hello");
  assert.equal(payload.messageId, undefined);
  assert.equal(payload.sentAt, undefined);
  assert.equal(payload.replyTo, undefined);
});

test("invalid media cannot enter the timeline as a valid chat", () => {
  assert.equal(decode({ type: "chat", text: "voice", voice: {} }), null);
  assert.equal(decode({ type: "chat", text: "file", attachment: { name: "../bad" } }), null);
});

test("valid control and message payloads retain their fields", () => {
  for (const value of [
    { type: "message-edit", messageId: "id", at: 10, text: "new" },
    { type: "message-delete", messageId: "id", at: 10 },
    { type: "receipt", messageId: "id", recipientId: "alice" },
    { type: "reaction", messageId: "id", authorId: "alice", emoji: null },
    { type: "admin-transfer", id: "id", adminId: "bob" },
    { type: "admin-ack", id: "id" },
    { type: "circle-admin", adminId: "bob" },
    { type: "nickname", nickname: "Bob" },
    { type: "circle-rename", name: "Family" },
    { type: "profile-photo", photo: null },
    { type: "attachment-chunk", messageId: "id", index: 0, data: "YQ==" },
  ])
    assert.deepEqual(JSON.parse(JSON.stringify(decode(value))), value);
});
