import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const { StateJournal } = await loadTypeScriptModule("src/state-journal.ts");

test("rollback and recovery checkpoint complete before another queued action can run", async () => {
  const journal = new StateJournal();
  const events = [];
  let state = 0;
  let saved = 0;
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const inRollback = new Promise((resolve) => { entered = resolve; });
  const adapter = {
    snapshot: () => state,
    begin: async () => { events.push("begin"); },
    commit: async () => { saved = state; events.push("commit"); },
    rollback: async (before) => {
      entered();
      await gate;
      state = before;
      events.push("rollback");
    },
  };
  const rejected = Error("input rejected");
  const task = journal.transaction(adapter, async () => {
    state = 99;
    throw rejected;
  }, (error) => {
    assert.equal(error, rejected);
    assert.equal(state, 0);
    return async () => { state = 1; events.push("disposition"); };
  });
  await inRollback;
  const queued = journal.run(async () => {
    assert.equal(state, 1);
    assert.equal(saved, 1);
    events.push("queued action");
  });
  release();
  await Promise.all([task, queued]);
  assert.deepEqual(events, ["begin", "rollback", "begin", "disposition", "commit", "queued action"]);
});

test("failed recovery checkpoint rolls back once and never invokes recovery again", async () => {
  const journal = new StateJournal();
  let state = 0;
  let recoveries = 0;
  let rollbacks = 0;
  const storage = Error("disk full");
  const adapter = {
    snapshot: () => state,
    begin: async () => {},
    commit: async () => { throw storage; },
    rollback: async (before) => { state = before; rollbacks++; },
  };
  await assert.rejects(journal.transaction(adapter, async () => {
    state = 99;
    throw Error("input rejected");
  }, () => {
    recoveries++;
    return async () => { state = 1; };
  }), (error) => error === storage);
  assert.equal(state, 0);
  assert.equal(recoveries, 1);
  assert.equal(rollbacks, 2);
  await journal.run(async () => assert.equal(state, 0));
});

test("commit and rollback failures cannot enter recovery", async () => {
  for (const failRollback of [false, true]) {
    const journal = new StateJournal();
    let recoveries = 0;
    const adapter = {
      snapshot: () => 0,
      begin: async () => {},
      commit: async () => { throw Error("save failure"); },
      rollback: async () => { if (failRollback) throw Error("abort failure"); },
    };
    await assert.rejects(journal.transaction(adapter, async () => {
      if (failRollback) throw Error("input rejected");
    }, () => { recoveries++; return async () => {}; }));
    assert.equal(recoveries, 0);
    if (failRollback) await assert.rejects(journal.run(async () => {}), /abort failure/);
  }
});
