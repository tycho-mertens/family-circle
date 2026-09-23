import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { nativeErrorCode, isExpectedMlsEcho } =
  await loadTypeScriptModule("src/native-errors.ts");

test("native codes classify errors independently of messages and wrapped causes", () => {
  assert.equal(
    nativeErrorCode({ code: "ERR_MLS_STALE_EPOCH", message: "changed text" }),
    "ERR_MLS_STALE_EPOCH",
  );
  assert.equal(
    nativeErrorCode({ cause: { code: "ERR_CIRCLE_SYNC_BUSY" } }),
    "ERR_CIRCLE_SYNC_BUSY",
  );
  assert.equal(isExpectedMlsEcho({ code: "ERR_MLS_OWN_MESSAGE" }), true);
  assert.equal(isExpectedMlsEcho({ code: "ERR_MLS_ALREADY_PROCESSED" }), true);
  assert.equal(isExpectedMlsEcho({ code: "ERR_MLS_STALE_EPOCH" }), false);
});

test("legacy native errors stay compatible without matching unrelated prose", () => {
  assert.equal(
    nativeErrorCode(new Error("uniffi.crypto_core.CryptoCoreException$StaleEpoch: old")),
    "ERR_MLS_STALE_EPOCH",
  );
  assert.equal(
    nativeErrorCode({
      code: "ERR_UNEXPECTED",
      message: "CryptoCoreException$OwnMessage: echo",
    }),
    "ERR_MLS_OWN_MESSAGE",
  );
  assert.equal(
    nativeErrorCode(new Error("Circle sync is busy; try again shortly")),
    "ERR_CIRCLE_SYNC_BUSY",
  );
  assert.equal(
    nativeErrorCode({
      code: "ERR_UNEXPECTED",
      message:
        "Call rejected.\n→ Caused by: java.lang.IllegalStateException: Circle sync is busy; try again shortly",
    }),
    "ERR_CIRCLE_SYNC_BUSY",
  );
  assert.equal(nativeErrorCode(new Error("Could not save StaleEpoch data")), undefined);
  assert.equal(
    nativeErrorCode({ code: "ENOSPC", message: "CryptoCoreException$OwnMessage: echo" }),
    undefined,
  );
  const cyclic = {};
  cyclic.cause = cyclic;
  assert.equal(nativeErrorCode(cyclic), undefined);
});
