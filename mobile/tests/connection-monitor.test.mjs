import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const drain = () => new Promise((resolve) => setImmediate(resolve));

async function harness() {
  let listener;
  let nextTimer = 0;
  const timers = new Map();
  const events = [];
  const appState = {
    currentState: "active",
    addEventListener: (_name, callback) => {
      events.push("subscribe");
      listener = callback;
      return {
        remove: () => {
          listener = undefined;
          events.push("unsubscribe");
        },
      };
    },
  };
  let synchronize = async () => {};
  let token = async () => "token";
  let locationStatus = async () => ({ shares: [] });
  const { createConnectionMonitor } = await loadTypeScriptModule(
    "src/runtime/connection-monitor.ts",
  );
  const environment = {
    appState,
    native: {
      setAppForeground: () => {},
      configureRelayConnection: () => events.push("connect"),
      relayConnectionStatus: () => ({ connected: true, dirty: true }),
      startLocationService: () => events.push("location"),
    },
    relay: {
      healthCheck: async () => true,
      relayCapabilities: async () => ({ syncHub: "/sync" }),
    },
    installationToken: () => token(),
    locationStatus: () => locationStatus(),
    createEventsChannel: () => {},
    relayUrl: "https://relay.test",
    now: () => 100_000,
    repeat: (tick) => {
      const id = ++nextTimer;
      timers.set(id, tick);
      return () => timers.delete(id);
    },
  };
  const monitor = createConnectionMonitor(
    {
      getDeviceId: () => "alice",
      listCircles: () => [{ mailboxId: "mailbox", role: "member" }],
      initialize: async () => {},
      synchronize: () => {
        events.push("sync");
        return synchronize();
      },
      setRelayStatus: () => {},
      setNotice: () => {},
      onAppStateChange: () => {},
    },
    environment,
  );
  return {
    monitor,
    environment,
    events,
    timers,
    tick: () => {
      for (const tick of timers.values()) tick();
    },
    background: () => {
      appState.currentState = "background";
      listener?.("background");
    },
    setSynchronize: (fn) => {
      synchronize = fn;
    },
    foreground: () => {
      appState.currentState = "active";
      listener?.("active");
    },
    setLocationStatus: (fn) => {
      locationStatus = fn;
    },
    setToken: (fn) => {
      token = fn;
    },
  };
}

test("connection monitor starts once, coalesces slow polls, and stops its resources", async () => {
  const h = await harness();
  assert.equal(h.events.length, 0);
  let release;
  h.setSynchronize(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  h.monitor.start();
  h.monitor.start();
  await drain();
  assert.equal(h.timers.size, 1);
  assert.equal(h.events.filter((event) => event === "subscribe").length, 1);
  assert.equal(h.events.filter((event) => event === "sync").length, 1);
  h.tick();
  await drain();
  assert.equal(h.events.filter((event) => event === "sync").length, 1);
  release();
  await drain();
  h.background();
  h.tick();
  await drain();
  assert.equal(h.events.filter((event) => event === "sync").length, 1);
  h.monitor.stop();
  assert.equal(h.timers.size, 0);
  assert.ok(h.events.includes("unsubscribe"));
});

test("stopping a monitor prevents a pending connection refresh from resuming", async () => {
  const h = await harness();
  let release;
  h.setToken(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  h.monitor.start();
  await drain();
  h.monitor.stop();
  release("token");
  await drain();
  assert.equal(h.events.includes("connect"), false);
  assert.equal(h.events.includes("sync"), false);
});

test("backgrounding during location lookup prevents a late native service restart", async () => {
  const h = await harness();
  h.monitor.start();
  await drain();
  h.background();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  h.setLocationStatus(() => pending);
  h.foreground();
  await drain();
  h.background();
  release({ shares: [{ active: true }] });
  await drain();
  assert.equal(h.events.includes("location"), false);
  h.monitor.stop();
});

test("stopping during subscription credentials lookup prevents a late native subscription", async () => {
  const h = await harness();
  h.environment.native.configureBackgroundNotifications = () =>
    h.events.push("subscription-configured");
  h.environment.native.backgroundNotificationStatus = () => ({
    enabled: true,
    configured: true,
    running: true,
  });
  let release;
  h.setToken(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  h.monitor.start();
  await drain();
  h.monitor.stop();
  release("token");
  await drain();
  assert.equal(h.events.includes("subscription-configured"), false);
  assert.equal(h.events.includes("connect"), false);
});
