import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { encodeAppMetadata, decodeAppMetadata } = await loadTypeScriptModule(
  "src/persistence/metadata.ts",
);
const plain = (value) => JSON.parse(JSON.stringify(value));

test("local metadata retains conversation history and unacknowledged ciphertext", () => {
  const saved = {
    nicknames: { alice: "Alice" },
    profilePhotos: { alice: null },
    circles: [{ circleId: "family", mailboxId: "mailbox", isCreator: true }],
    timeline: [{ id: "t4", circleId: "family", kind: "chat", text: "private", at: 123 }],
    outbox: [
      {
        eventId: "event",
        mailboxId: "mailbox",
        kind: "application",
        nonce: "AA==",
        ciphertext: "AQ==",
        epoch: 1,
      },
    ],
  };
  assert.deepEqual(plain(decodeAppMetadata(encodeAppMetadata(saved))), saved);
});

test("missing optional fields in older metadata receive safe defaults", () => {
  const restored = decodeAppMetadata(encodeAppMetadata({ circles: [] }));
  assert.deepEqual(plain(restored), {
    circles: [],
    nicknames: {},
    profilePhotos: {},
    timeline: [],
    outbox: [],
  });
});

test("malformed metadata permits identity-only recovery", () => {
  for (const raw of ["", "not json", "null", "[]", '{"circles":{}}']) {
    const restored = decodeAppMetadata(new TextEncoder().encode(raw));
    assert.deepEqual(plain(restored), { nicknames: {}, circles: [] });
  }
});

test("malformed photos and non-array history do not enter restored UI state", () => {
  const restored = decodeAppMetadata(
    encodeAppMetadata({
      circles: [],
      nicknames: null,
      timeline: {},
      outbox: "invalid",
      profilePhotos: { alice: "https://external.invalid/photo", bob: null },
    }),
  );
  assert.deepEqual(plain(restored), {
    circles: [],
    nicknames: {},
    timeline: [],
    outbox: [],
    profilePhotos: { bob: null },
  });
});
