import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

async function client(fetch) {
  const context = vm.createContext({
    fetch,
    Headers,
    AbortSignal,
    Uint8Array,
    process: { env: { EXPO_PUBLIC_RELAY_URL: "http://relay.test" } },
  });
  const modules = new Map();
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const module =
      name === "expo-secure-store"
        ? new vm.SyntheticModule(
            ["getItemAsync"],
            function () {
              this.setExport("getItemAsync", async () => null);
            },
            { context },
          )
        : name === "./bridge"
          ? new vm.SyntheticModule([], () => {}, { context })
          : new vm.SourceTextModule(
              ts.transpileModule(
                readFileSync(
                  new URL(`../src/${name.slice(2)}.ts`, import.meta.url),
                  "utf8",
                ),
                {
                  compilerOptions: {
                    module: ts.ModuleKind.ESNext,
                    target: ts.ScriptTarget.ES2022,
                  },
                },
              ).outputText,
              { context },
            );
    modules.set(name, module);
    await module.link(load);
    return module;
  }
  const module = await load("./relay");
  await module.evaluate();
  return module.namespace;
}

const wire = (sequenceId) => ({
  sequenceId,
  eventId: `event-${sequenceId}`,
  epoch: 2,
  kind: "application",
  nonce: "AQ==",
  ciphertext: "Ag==",
  createdAt: "",
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("catch-up fetches every mailbox page before returning messages", async () => {
  const after = [];
  const relay = await client(async (url) => {
    const cursor = Number(new URL(url).searchParams.get("after"));
    after.push(cursor);
    return json(
      Array.from({ length: cursor < 200 ? 100 : 1 }, (_, i) => wire(cursor + i + 1)),
    );
  });
  const messages = await relay.fetchEnvelopes("mailbox");
  assert.deepEqual(after, [0, 100, 200]);
  assert.equal(messages.length, 201);
  assert.equal(messages[200].sequenceId, 201);
});

test("a failed catch-up page does not return a partial success", async () => {
  const relay = await client(async (url) =>
    new URL(url).searchParams.get("after") === "0"
      ? json(Array.from({ length: 100 }, (_, i) => wire(i + 1)))
      : json({}, 503),
  );
  await assert.rejects(relay.fetchEnvelopes("mailbox"), (error) => {
    assert.match(error.message, /503/);
    assert.equal(error.code, "RELAY_HTTP");
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    return true;
  });
});

test("upload sends the conditional cursor but never the local retry plaintext", async () => {
  let body;
  const relay = await client(async (_url, request) => {
    if (_url.endsWith("/capabilities"))
      return json({ membershipAdmission: "membership-v1" });
    body = JSON.parse(request.body);
    return json(wire(42), 201);
  });
  const result = await relay.uploadEnvelope("mailbox", {
    eventId: "id",
    epoch: 2,
    kind: "application",
    nonce: new Uint8Array([1]),
    ciphertext: new Uint8Array([2]),
    expectedSequenceId: 41,
    plaintext: "private draft",
    needsSync: true,
  });
  assert.equal(result, 42);
  assert.equal(body.expectedSequenceId, 41);
  assert.equal(body.admission, "membership-v1");
  assert.deepEqual(Object.keys(body).sort(), [
    "admission",
    "ciphertext",
    "epoch",
    "eventId",
    "expectedSequenceId",
    "kind",
    "nonce",
    "ttlSeconds",
  ]);
});

test("only the explicit mailbox conflict permits resealing a queued message", async () => {
  let response = json({ code: "mailbox-changed" }, 409);
  const relay = await client(async () => response);
  const envelope = {
    eventId: "id",
    epoch: 2,
    kind: "application",
    nonce: new Uint8Array([1]),
    ciphertext: new Uint8Array([2]),
  };
  await assert.rejects(relay.uploadEnvelope("mailbox", envelope), (error) =>
    relay.isMailboxChanged(error),
  );
  response = json({}, 503);
  await assert.rejects(
    relay.uploadEnvelope("mailbox", envelope),
    (error) => !relay.isMailboxChanged(error),
  );
});

test("normal join request IDs never disclose the invitation secret", async () => {
  const relay = await client(async () => json({}, 200));
  const inviteNonce = "0123456789abcdef0123456789abcdef";
  const id = relay.buildInviteRequestEventId();
  assert.match(id, /^kp-request:/);
  assert.ok(!id.includes(inviteNonce));
  assert.ok(!id.includes("circle-id"));
});
