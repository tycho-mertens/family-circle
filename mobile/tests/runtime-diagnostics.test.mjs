import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { createRuntimeDiagnostics } = await loadTypeScriptModule("src/diagnostics.ts", {
  globals: { Error },
});

test("retry diagnostics are throttled per operation and omit error messages", () => {
  const warnings = [];
  let now = 100_000;
  const report = createRuntimeDiagnostics(
    (message) => warnings.push(message),
    () => now,
  );
  const error = new Error("private payload and credentials");
  report("Synchronization", error);
  report("Synchronization", error);
  report("Location restart", error);
  assert.equal(warnings.length, 2);
  now += 60_000;
  report("Synchronization", error);
  assert.equal(warnings.length, 3);
  now = 0;
  report("Synchronization", error);
  assert.equal(warnings.length, 4);
  assert.ok(warnings.every((message) => !message.includes(error.message)));
});

test("diagnostics report safe HTTP details, changed causes, and repeat counts", () => {
  const warnings = [];
  let now = 0;
  const report = createRuntimeDiagnostics(
    (message) => warnings.push(message),
    () => now,
  );
  const failure = Object.assign(new Error("secret server body"), {
    code: "RELAY_HTTP",
    status: 503,
    retryable: true,
    cause: Object.assign(new Error("private endpoint"), { name: "TimeoutError" }),
  });
  report("Relay publication", failure);
  report("Relay publication", failure);
  now = 60_000;
  report("Relay publication", failure);
  assert.match(warnings[1], /status=503 retryable=true/);
  assert.match(warnings[1], /cause=\[TimeoutError\]/);
  assert.match(warnings[1], /1 repeated failures suppressed/);
  failure.status = 401;
  failure.retryable = false;
  report("Relay publication", failure);
  assert.equal(warnings.length, 3);
  assert.match(warnings[2], /status=401 retryable=false/);
  const unsafe = { name: "secret name", code: "secret code", message: "secret message" };
  unsafe.cause = unsafe;
  report("Unclassified failure", unsafe);
  assert.ok(warnings.every((line) => !/secret|private/.test(line)));
});
