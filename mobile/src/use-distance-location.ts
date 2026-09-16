import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import Native from "../modules/family-circle-bridge";
import type { Fix } from "./location";

/** Local map reference only: no vault, sharing consent, or relay writes. */
export function useDistanceLocation(shared: Fix | null) {
  const [local, setLocal] = useState<Fix | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const requestId = useRef(0);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      const cancel = () => {
        requestId.current++;
        Native.cancelDistanceLocation?.();
        setBusy(false);
      };
      // One private acquisition per map opening; never prompt automatically or poll.
      const id = ++requestId.current;
      const acquireOnOpen = async () => {
        try {
          const status = Native.locationSettingsStatus();
          if (
            !(status.precise || status.approximate) ||
            !status.locationEnabled ||
            AppState.currentState !== "active"
          )
            return;
          setError(null);
          setBusy(true);
          const fix = await Native.getDistanceLocation();
          if (!focused.current || requestId.current !== id) return;
          if (fix) setLocal(fix);
          else setError("Couldn't get your position. Tap locate to try again.");
        } catch {
          if (focused.current && requestId.current === id)
            setError("Couldn't get your position. Tap locate to try again.");
        } finally {
          if (requestId.current === id) setBusy(false);
        }
      };
      void acquireOnOpen();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state !== "active") cancel();
      });
      return () => {
        focused.current = false;
        cancel();
        subscription.remove();
        setLocal(null);
      };
    }, []),
  );
  const refresh = async () => {
    if (busy || !focused.current || AppState.currentState !== "active") return;
    setError(null);
    setBusy(true);
    try {
      if (!(await Native.requestLocationPermission())) {
        setError(
          "Allow location access to calculate distances. Your position won't be shared by this action.",
        );
        return;
      }
      if (!focused.current || AppState.currentState !== "active") return;
      setBusy(true);
      const id = ++requestId.current;
      const fix = await Native.getDistanceLocation();
      if (!focused.current || requestId.current !== id) return;
      if (fix) setLocal(fix);
      else setError("Couldn't get your position. Check location services and try again.");
    } catch {
      setError("Couldn't get your position. Check location permissions and try again.");
    } finally {
      setBusy(false);
    }
  };
  const origin = local && (!shared || local.observedAt > shared.observedAt) ? local : shared;
  return { origin, busy, error, refresh };
}
