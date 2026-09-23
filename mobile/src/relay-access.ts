import * as SecureStore from "expo-secure-store";
const slot = "family-circle-relay-installation";
let loaded: Promise<string | null> | undefined;
export function installationToken() {
  return (loaded ??= SecureStore.getItemAsync(slot));
}
let retryAt = 0;
export async function relayFetch(url: string, init?: RequestInit) {
  if (Date.now() < retryAt)
    throw Object.assign(new Error("Server is busy. Retrying shortly."), {
      code: "RELAY_THROTTLED",
      retryable: true,
    });
  const token = await installationToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("X-Installation-Token", token);
  const response = await fetch(url, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(10_000),
  });
  if (response.status === 429 || response.status === 503) {
    const hint = response.headers.get("Retry-After");
    const seconds =
      hint && /^\d+$/.test(hint)
        ? Number(hint)
        : hint
          ? Math.max(0, (Date.parse(hint) - Date.now()) / 1000)
          : 5;
    retryAt =
      Date.now() +
      Math.min(300, Number.isFinite(seconds) ? seconds : 5) * 1000 +
      Math.random() * 1000;
  }
  return response;
}
export async function enrollInstallation(code: string) {
  const response = await fetch(
    (process.env.EXPO_PUBLIC_RELAY_URL ?? "").replace(/\/$/, "") + "/v1/installations",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new Error(
      "Server access could not be enabled. Check the code with your server administrator.",
    );
  const { token } = await response.json();
  if (typeof token !== "string") throw new Error("Invalid server response");
  await SecureStore.setItemAsync(slot, token);
  loaded = Promise.resolve(token);
}
