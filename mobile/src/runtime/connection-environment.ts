import { AppState } from "react-native";
import Native from "../../modules/family-circle-bridge";
import { createEventsChannel } from "../bridge";
import * as relay from "../relay";
import { installationToken } from "../relay-access";
import { command, type LocationState } from "../location";
import type { ConnectionEnvironment } from "./connection-monitor";

// Platform bindings are assembled here; the monitor itself has no native imports.
export const connectionEnvironment: ConnectionEnvironment = {
  appState: AppState,
  native: Native,
  relay,
  installationToken,
  locationStatus: () => command<LocationState>({ op: "status" }),
  createEventsChannel,
  relayUrl: process.env.EXPO_PUBLIC_RELAY_URL ?? "",
  now: Date.now,
  repeat: (tick, interval) => {
    const timer = setInterval(tick, interval);
    return () => clearInterval(timer);
  },
};
