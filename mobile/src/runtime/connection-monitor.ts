import type { AppState, AppStateStatus } from "react-native";
import type Native from "../../modules/family-circle-bridge";
import type * as relay from "../relay";
import type { LocationState } from "../location";
import type { CircleInfo } from "./circle-types";
import { createRuntimeDiagnostics } from "../diagnostics";

export interface ConnectionEnvironment {
  appState: Pick<typeof AppState, "currentState" | "addEventListener">;
  native: Pick<
    typeof Native,
    | "configureBackgroundNotifications"
    | "backgroundNotificationStatus"
    | "configureRelayConnection"
    | "relayConnectionStatus"
    | "setAppForeground"
    | "startLocationService"
  >;
  relay: Pick<typeof relay, "relayCapabilities" | "healthCheck">;
  installationToken: () => Promise<string | null>;
  locationStatus: () => Promise<Pick<LocationState, "shares">>;
  createEventsChannel: () => void;
  relayUrl: string;
  now: () => number;
  repeat: (tick: () => void, interval: number) => () => void;
}

interface Dependencies {
  getDeviceId: () => string | null;
  listCircles: () => CircleInfo[];
  initialize: () => Promise<void>;
  synchronize: () => Promise<void>;
  setRelayStatus: (status: "checking" | "connected" | "unreachable") => void;
  setNotice: (notice: string) => void;
  onAppStateChange: (state: AppStateStatus) => void;
}

// Owns connection refresh and foreground polling for the process-wide runtime.
// Construction does not install listeners or start network work.
export function createConnectionMonitor(
  {
    getDeviceId,
    listCircles,
    initialize,
    synchronize,
    setRelayStatus,
    setNotice,
    onAppStateChange,
  }: Dependencies,
  environment: ConnectionEnvironment,
) {
  const {
    appState: AppState,
    native: Native,
    relay,
    installationToken,
    locationStatus,
    createEventsChannel,
    relayUrl,
    now,
    repeat,
  } = environment;
  let backgroundRestartNoticeShown = false;
  let generation = 0;
  let subscription: ReturnType<typeof AppState.addEventListener> | undefined;
  let stopTimer: (() => void) | undefined;
  const reportFailure = createRuntimeDiagnostics();
  const configureBackgroundConnection = async (isCurrent = () => true) => {
    if (!Native.configureBackgroundNotifications) return;
    const before = Native.backgroundNotificationStatus();
    const mailboxes = listCircles()
      .filter((c) => c.role !== "removed")
      .map((c) => c.mailboxId)
      .sort();
    // Clear stale subscriptions even if the server is temporarily unreachable.
    if (!mailboxes.length) {
      Native.configureBackgroundNotifications("", [], "");
      return;
    }
    const capabilities = await relay.relayCapabilities();
    if (!isCurrent()) return;
    const url = capabilities.syncHub
      ? relayUrl.replace(/\/$/, "") + capabilities.syncHub
      : "";
    const token = (await installationToken()) ?? "";
    if (!isCurrent()) return;
    Native.configureBackgroundNotifications(url, mailboxes, token);
    if (before.enabled && before.configured && !before.running) {
      if (!backgroundRestartNoticeShown)
        setNotice("Background connection resumed after Android stopped its service.");
      backgroundRestartNoticeShown = true;
    } else if (before.running) backgroundRestartNoticeShown = false;
  };

  let foregroundChecksStarted = false;
  const startForegroundChecks = () => {
    if (foregroundChecksStarted) return;
    foregroundChecksStarted = true;
    const startedGeneration = ++generation;
    const isActive = () =>
      generation === startedGeneration && AppState.currentState === "active";
    createEventsChannel();
    Native.setAppForeground?.(AppState.currentState === "active");
    let lastSync = 0,
      lastHealth = 0;
    let checking = false;
    const tick = async () => {
      if (checking || !isActive()) return;
      checking = true;
      let phase = "Relay health check";
      try {
        if (now() - lastHealth >= 60_000) {
          lastHealth = now();
          const healthy = await relay.healthCheck();
          if (!isActive()) return;
          setRelayStatus(healthy ? "connected" : "unreachable");
        }
        if (!isActive() || !getDeviceId()) return;
        phase = "Foreground identity initialization";
        await initialize();
        if (!isActive()) return;
        const mailboxes = listCircles()
          .filter((c) => c.role !== "removed")
          .map((c) => c.mailboxId)
          .sort();
        try {
          await configureBackgroundConnection(isActive);
        } catch (error) {
          reportFailure("Background subscription", error);
        }
        phase = "Relay capabilities lookup";
        const capabilities = await relay.relayCapabilities();
        if (!isActive()) return;
        const url = capabilities.syncHub
          ? relayUrl.replace(/\/$/, "") + capabilities.syncHub
          : "";
        phase = "Installation credential lookup";
        const token = (await installationToken()) ?? "";
        if (!isActive()) return;
        phase = "Foreground relay connection";
        Native.configureRelayConnection(url, mailboxes, token);
        const status = Native.relayConnectionStatus();
        phase = "Location status lookup";
        const sharing = (await locationStatus()).shares.some((s) => s.active);
        if (!isActive()) return;
        if (
          status.dirty ||
          now() - lastSync >= (status.connected && !sharing ? 60_000 : 5_000)
        ) {
          lastSync = now();
          phase = "Foreground synchronization";
          await synchronize();
        }
      } catch (error) {
        reportFailure(phase, error);
      } finally {
        checking = false;
      }
    };
    subscription = AppState.addEventListener("change", (state) => {
      onAppStateChange(state);
      Native.setAppForeground?.(state === "active");
      if (state === "active") {
        void tick();
        void initialize()
          .then(async () => {
            if (!getDeviceId() || !isActive()) return;
            const status = await locationStatus();
            if (isActive() && status.shares.some((share) => share.active))
              Native.startLocationService();
          })
          .catch((error) => reportFailure("Location service restart", error));
      }
    });
    stopTimer = repeat(() => {
      void tick();
    }, 1000);
    void tick();
  };

  return {
    start: startForegroundChecks,
    configureBackgroundConnection,
    stop() {
      generation++;
      foregroundChecksStarted = false;
      subscription?.remove();
      subscription = undefined;
      stopTimer?.();
      stopTimer = undefined;
    },
  };
}
