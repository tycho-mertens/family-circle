import { circlesRuntime } from "../runtime/circles";
import { locationChanges } from "../runtime/location-events";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { AppState } from "react-native";
import Native from "../../modules/family-circle-bridge";
import { useIdentity } from "./identity";
import { useCircles } from "./circles";
import { command, emptyLocations, generation, type LocationState } from "../location";

interface Context {
  state: LocationState;
  error: string | null;
  nativeStatus: string | null;
  ready: boolean;
  busy: boolean;
  start: (
    circleId: string,
    interval: number,
    duration: number | null,
    reportBattery?: boolean,
  ) => Promise<boolean>;
  setBattery: (circleId: string, enabled: boolean) => Promise<boolean>;
  stop: (circleId: string) => Promise<void>;
}
const Locations = createContext<Context | null>(null);
export function useLocations() {
  const c = useContext(Locations);
  if (!c) throw new Error("Location provider is missing");
  return c;
}
async function syncWithDeadline(sync: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sync(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Circle synchronization timed out")), 30_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function LocationProvider({ children }: PropsWithChildren) {
  const { deviceId } = useIdentity();
  const circles = useCircles();
  const circlesRef = useRef(circles);
  circlesRef.current = circles;
  const [state, setState] = useState<LocationState>(emptyLocations);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nativeStatus, setNativeStatus] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    let refreshing = false;
    let loadError = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        await circlesRuntime.initialize();
        if (!deviceId) return;
        const next = await command<LocationState>({ op: "status" });
        const active = next.shares.some((share) => share.active);
        const resume =
          active && AppState.currentState === "active" && !Native.locationServiceRunning();
        if (resume) Native.startLocationService();
        if (mounted) {
          setState(next);
          setReady(true);
          if (loadError) {
            setError(null);
            loadError = false;
          }
          setNativeStatus(
            resume
              ? "Location sharing resumed after Android stopped its service."
              : Native.locationStatusMessage(),
          );
        }
      } catch (e) {
        // Status reads can overlap a short atomic Circle transaction.
        // Keep the last state and retry on the next event/tick.
        if (mounted && !String(e).includes("Circle sync is busy")) {
          loadError = true;
          setError("Location sharing could not load on this phone.");
        }
      } finally {
        refreshing = false;
      }
    };
    const unsubscribe = locationChanges.subscribe(() => {
      void refresh();
    });
    // Native foreground services outlive the React tree and can stop or
    // resume without a JS event. While the UI is visible, reconcile that
    // authoritative state so "You're sharing" can never remain stale.
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refresh();
    }, 5000);
    void refresh();
    return () => {
      mounted = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, [deviceId, circles.circlesReady]);
  const start = async (
    circleId: string,
    interval: number,
    duration: number | null,
    reportBattery = true,
  ) => {
    if (!ready || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const circle = circlesRef.current.circles[circleId];
      if (circle?.role !== "member" || circle.deleting)
        throw new Error("Join this Circle before sharing.");
      if (!(await Native.requestLocationPermission()))
        throw new Error(
          "Allow location access to start sharing. You can still view the map without it.",
        );
      await syncWithDeadline(circlesRef.current.pollNow);
      await command({
        op: "start",
        circleId,
        mailboxId: circle.mailboxId,
        generation: await generation(),
        interval,
        reportBattery,
        expiresAt: duration === null ? 0 : Date.now() + duration,
      });
      // Persisted consent and stop outbox precede service start.
      setState(await command<LocationState>({ op: "status" }));
      try {
        Native.startLocationService();
      } catch (e) {
        await command({ op: "stop", circleId });
        throw e;
      }
      // All relay/location synchronization must pass through the one shared
      // coordinator. Direct calls here could race a map/subscriber pass and
      // leave the button waiting on competing state transactions.
      try {
        await syncWithDeadline(circlesRef.current.pollNow);
      } catch {
        setError(
          "Sharing started on this phone. Its first upload is waiting for the Circle server.",
        );
      }
      setState(await command<LocationState>({ op: "status" }));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Location sharing couldn't start.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const setBattery = async (circleId: string, enabled: boolean) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await command({ op: "setBattery", circleId, enabled });
      setState(await command<LocationState>({ op: "status" }));
      await syncWithDeadline(circlesRef.current.pollNow);
      setState(await command<LocationState>({ op: "status" }));
      return true;
    } catch {
      setError(
        "Battery preference updates are waiting for a connection. Other devices may still show the previous report.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const stop = async (circleId: string) => {
    setBusy(true);
    let stopped = false;
    try {
      await command({ op: "stop", circleId });
      stopped = true;
      setState(await command<LocationState>({ op: "status" }));
      await syncWithDeadline(circlesRef.current.pollNow);
      setState(await command<LocationState>({ op: "status" }));
      setError(null);
    } catch {
      setError(
        stopped
          ? "Stopped on this phone. Removal from other devices is pending a connection."
          : "The stop could not be saved. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Locations.Provider
      value={{ state, error, nativeStatus, ready, busy, start, stop, setBattery }}
    >
      {children}
    </Locations.Provider>
  );
}
