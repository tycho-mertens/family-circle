import { AppRegistry } from "react-native";
import Native from "../../modules/family-circle-bridge";
import { circlesRuntime } from "./circles";
import { identityRuntime } from "./identity";
import { command, type LocationState } from "../location";

// Evaluated by the bundle entry, including a cold launch with no mounted views.
AppRegistry.registerHeadlessTask("FamilyCircleBackgroundSync", () => async () => {
  await circlesRuntime.synchronize();
});
// Native owns service lifetime and sleep-capable deadlines. Every invocation
// initializes/acknowledges this service instance, reconciles once, then ends.
AppRegistry.registerHeadlessTask("FamilyCircleLocationSync", () => async () => {
  await circlesRuntime.initialize();
  if (!identityRuntime.value.deviceId) throw new Error("Background identity unavailable");
  Native.locationRuntimeReady();
  try {
    await circlesRuntime.synchronize();
  } catch {
    console.info("CircleLocation: sync pending; native work will retry");
  }
});

// Location consent is independent of the optional notification subscriber.
// Native invokes this bounded task after checkpointing a fresh snapshot.
AppRegistry.registerHeadlessTask("FamilyCircleLocationUpload", () => async () => {
  try {
    await circlesRuntime.synchronize();
  } catch {
    console.info("CircleLocation: upload pending; will retry after the next fix or reconciliation");
  }
});

AppRegistry.registerHeadlessTask(
  "FamilyCircleSubscriberSync",
  () =>
    async ({ requestId }: { requestId: string }) => {
      let success = false;
      try {
        Native.createEventsChannel();
        await circlesRuntime.synchronize();
        success = true;
      } catch {
        // The persistent subscriber owns retries; finish the JS task cleanly after reporting failure.
      } finally {
        Native.completeSubscriberSync(requestId, success);
      }
    },
);
