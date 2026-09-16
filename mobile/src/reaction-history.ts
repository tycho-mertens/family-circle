import { useEffect, useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { recordEmojiUsage, validReaction, type EmojiUsage } from "./reactions";

const EMPTY: EmojiUsage[] = [];
const stores = new Map<
  string,
  { value: EmojiUsage[]; listeners: Set<() => void>; ready: Promise<void>; writes: Promise<void> }
>();
function historyStore(deviceId: string) {
  const existing = stores.get(deviceId);
  if (existing) return existing;
  const key = "reaction-history." + deviceId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const state = {
    value: EMPTY,
    listeners: new Set<() => void>(),
    ready: Promise.resolve(),
    writes: Promise.resolve(),
  };
  stores.set(deviceId, state);
  state.ready = SecureStore.getItemAsync(key)
    .then((raw) => {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed))
        state.value = parsed
          .filter(
            (item) =>
              item &&
              typeof item.emoji === "string" &&
              validReaction(item.emoji) &&
              Number.isFinite(item.count) &&
              item.count > 0 &&
              Number.isFinite(item.lastUsed),
          )
          .slice(0, 48);
    })
    .catch(() => {})
    .then(() => {
      state.listeners.forEach((listener) => listener());
    });
  return state;
}
export function useReactionHistory(deviceId?: string) {
  const state = deviceId ? historyStore(deviceId) : undefined;
  const history = useSyncExternalStore(
    (listener) => {
      state?.listeners.add(listener);
      return () => {
        state?.listeners.delete(listener);
      };
    },
    () => state?.value ?? EMPTY,
  );
  // Loading is shared across all visible messages.
  useEffect(() => {
    void state?.ready;
  }, [state]);
  return history;
}
export async function rememberReaction(deviceId: string, emoji: string) {
  const state = historyStore(deviceId);
  await state.ready;
  state.value = recordEmojiUsage(state.value, emoji);
  state.listeners.forEach((listener) => listener());
  const serialized = JSON.stringify(state.value);
  const key = "reaction-history." + deviceId.replace(/[^a-zA-Z0-9._-]/g, "_");
  state.writes = state.writes.then(() => SecureStore.setItemAsync(key, serialized)).catch(() => {});
  await state.writes;
}
