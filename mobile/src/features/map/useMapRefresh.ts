import { useCallback, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";

export function useMapRefresh(pollNow: () => Promise<void>) {
  const [now, setNow] = useState(Date.now());
  useFocusEffect(
    useCallback(() => {
      let timer: ReturnType<typeof setInterval> | undefined;
      let syncTimer: ReturnType<typeof setInterval> | undefined;
      let syncing = false;
      const syncNow = async () => {
        // pollNow queues another pass if a sync is running. Skip overlapping
        // timer ticks so slow syncs can finish and release waiting callers.
        if (syncing) return;
        syncing = true;
        try {
          await pollNow();
        } catch {
          /* The next visible-map pass retries. */
        } finally {
          syncing = false;
        }
      };
      const updateTimer = () => {
        if (timer) clearInterval(timer);
        if (syncTimer) clearInterval(syncTimer);
        if (AppState.currentState === "active") {
          setNow(Date.now());
          void syncNow();
          timer = setInterval(() => setNow(Date.now()), 5000);
          // Refresh visible pins even when local sharing is off or a socket
          // notification was missed.
          syncTimer = setInterval(() => {
            void syncNow();
          }, 5000);
        }
      };
      updateTimer();
      const subscription = AppState.addEventListener("change", updateTimer);
      return () => {
        if (timer) clearInterval(timer);
        if (syncTimer) clearInterval(syncTimer);
        subscription.remove();
      };
    }, [pollNow]),
  );
  return now;
}
