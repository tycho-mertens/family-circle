import { relayFetch } from "./relay-access";
import Native from "../modules/family-circle-bridge";
import * as relay from "./relay";
import { syncBackupNow } from "./backup";
import type { MailboxEnvelope } from "./relay";

export interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number;
  observedAt: number;
  batteryPercent?: number;
  updateInterval?: number;
  updatedAt?: number;
}
export interface LocationShare {
  circleId: string;
  sessionId: string;
  epoch: number;
  interval: number;
  expiresAt: number;
  active: boolean;
  lastUploaded: number;
  reportBattery: boolean;
}
export interface LocationPin {
  circleId: string;
  sessionId: string;
  senderId: string;
  fix: Fix | null;
}
interface Snapshot {
  sessionId: string;
  revision: number;
  stopped: boolean;
  generation: string;
  [key: string]: unknown;
}
interface Control {
  circleId: string;
  mailboxId: string;
  envelope: { event_id: string; epoch: number; nonce: number[]; ciphertext: number[] };
}
export interface LocationState {
  shares: LocationShare[];
  pins: LocationPin[];
  pending: Snapshot[];
  controls: Control[];
}
export const emptyLocations: LocationState = { shares: [], pins: [], pending: [], controls: [] };
let ready = false;
// Per session: the revision Rust accepted and the fix that came with it.
// Sending the revision back lets the relay answer "unchanged" instead of a
// whole snapshot, but only while our copy of the fix still matches Rust's.
// A generation reroll invalidates every session, so both are cleared with it.
const verifiedRevisions = new Map<string, number>();
const verifiedFixes = new Map<string, string>();
let verifiedGeneration = "";

/** One JSON call per operation. Rust keeps no clock, so `now` rides along. */
export async function command<T = unknown>(args: Record<string, unknown>): Promise<T> {
  return JSON.parse(await Native.locationCommand(JSON.stringify({ now: Date.now(), ...args })));
}
export async function loadLocations(identity: string) {
  verifiedRevisions.clear();
  verifiedFixes.clear();
  for (;;) {
    try {
      await Native.loadLocations(identity);
      ready = true;
      break;
    } catch (error) {
      // Location and chat work take turns. Brief and normal, so wait.
      if (!String(error).includes("Circle sync is busy")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
export async function receiveLocationControl(
  circleId: string,
  e: MailboxEnvelope,
): Promise<string | null> {
  if (!ready) throw new Error("Location state is still loading");
  try {
    const result = await command<{ senderId?: string; sharingStarted?: boolean }>({
      op: "control",
      circleId,
      envelope: {
        event_id: e.eventId,
        epoch: e.epoch,
        nonce: Array.from(e.nonce),
        ciphertext: Array.from(e.ciphertext),
      },
    });
    void syncBackupNow("device");
    return result.sharingStarted === true && typeof result.senderId === "string"
      ? result.senderId
      : null;
  } catch (error) {
    // Replay, own echo and superseded epoch are ordinary traffic. Anything
    // else must reach the caller, so the cursor holds and this is retried.
    if (!/CryptoCoreException\$(AlreadyProcessed|OwnMessage|StaleEpoch):/.test(String(error)))
      throw error;
    return null;
  }
}
const base = () => {
  const url = process.env.EXPO_PUBLIC_RELAY_URL?.replace(/\/$/, "");
  if (!url) throw new Error("Your Circle server is not configured.");
  return url;
};
async function request(path: string, init?: RequestInit) {
  try {
    return await relayFetch(base() + "/v1/locations/" + path, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Waiting for a connection. Showing last known locations.");
  }
}
export async function generation(): Promise<string> {
  const response = await request("generation");
  if (!response.ok) throw new Error("Location sharing needs an updated, reachable Circle server.");
  return (await response.json()).generation;
}
export async function synchronizeLocations(): Promise<LocationState> {
  const currentGeneration = await generation();
  if (verifiedGeneration !== currentGeneration) {
    verifiedRevisions.clear();
    verifiedFixes.clear();
    verifiedGeneration = currentGeneration;
  }
  // Reconcile first: it stops or rotates sessions whose epoch or generation moved.
  await command({ op: "reconcile", generation: currentGeneration });
  let state = await command<LocationState>({ op: "status" });
  let uploaded = 0;
  let received = 0;
  // Terminal commands always go first. No position update can revive them.
  for (const update of [...state.pending].sort((a, b) => Number(b.stopped) - Number(a.stopped))) {
    // Queued against a store that no longer exists: drop it, do not upload.
    if (update.generation !== currentGeneration) {
      await command({ op: "ack", sessionId: update.sessionId, revision: update.revision });
      continue;
    }
    const response = await request(update.sessionId, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    if (response.ok || response.status === 410) {
      await command({ op: "ack", sessionId: update.sessionId, revision: update.revision });
      uploaded++;
    } else
      throw new Error(
        "Location updates are waiting for your server. Your last pin remains available.",
      );
  }
  for (const control of state.controls) {
    const e = control.envelope;
    await relay.uploadEnvelope(control.mailboxId, {
      eventId: e.event_id,
      epoch: e.epoch,
      nonce: new Uint8Array(e.nonce),
      ciphertext: new Uint8Array(e.ciphertext),
      kind: "location-control-v1",
    });
    await command({ op: "ackControl", eventId: e.event_id });
    void syncBackupNow("device");
  }
  // Re-read: the acks above consumed snapshots and dequeued controls.
  state = await command<LocationState>({ op: "status" });
  const accepted = new Set<string>();
  const activePins = new Set(state.pins.map((pin) => pin.sessionId));
  for (const id of verifiedRevisions.keys())
    if (!activePins.has(id)) {
      verifiedRevisions.delete(id);
      verifiedFixes.delete(id);
    }
  if ((await relay.relayCapabilities()).locationBatch) {
    for (let offset = 0; offset < state.pins.length; offset += 100) {
      const pins = state.pins.slice(offset, offset + 100);
      const response = await request("batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generation: currentGeneration,
          sessions: pins.map((pin) => ({
            sessionId: pin.sessionId,
            revision:
              verifiedFixes.get(pin.sessionId) === JSON.stringify(pin.fix)
                ? verifiedRevisions.get(pin.sessionId)
                : undefined,
          })),
        }),
      });
      if (!response.ok) throw new Error("Location catch-up is waiting for your server.");
      const batch = (await response.json()) as {
        generation: string;
        results: { sessionId: string; status: string; snapshot?: Snapshot }[];
      };
      // Results are positional, so a relay that reorders, pads or truncates
      // them could misattribute one member's position to another. Check the
      // shape here and the session id per row below.
      if (
        batch.generation !== currentGeneration ||
        !Array.isArray(batch.results) ||
        batch.results.length !== pins.length
      )
        throw new Error("Invalid location batch");
      for (let i = 0; i < pins.length; i++) {
        const item = batch.results[i];
        if (item.sessionId !== pins[i].sessionId) throw new Error("Invalid location batch order");
        if (item.status === "changed" && item.snapshot?.sessionId === item.sessionId) {
          try {
            await command({ op: "receive", snapshot: item.snapshot });
            verifiedRevisions.set(item.sessionId, item.snapshot.revision);
            accepted.add(item.sessionId);
            received++;
          } catch {
            console.warn(
              "CircleLocation: received snapshot was rejected",
            ); /* Keep last verified fix. */
          }
        } else if (item.status === "unchanged" && verifiedRevisions.has(item.sessionId)) {
          /* Already verified locally. */
        } else if (item.status === "missing" || item.status === "terminal") {
          verifiedRevisions.delete(item.sessionId);
          verifiedFixes.delete(item.sessionId);
          await command({ op: item.status, sessionId: item.sessionId });
        } else throw new Error("Invalid location batch result");
      }
    }
  } else
    for (const pin of state.pins) {
      const response = await request(pin.sessionId);
      if (response.ok) {
        try {
          await command({ op: "receive", snapshot: await response.json() });
          received++;
        } catch {
          console.warn(
            "CircleLocation: received snapshot was rejected",
          ); /* Keep last verified fix. */
        }
      } else if (response.status === 404 || response.status === 410)
        await command({
          op: response.status === 410 ? "terminal" : "missing",
          sessionId: pin.sessionId,
        });
      else throw new Error("Your server is unreachable. Showing last known locations.");
    }
  const result = await command<LocationState>({ op: "status" });
  // Only cache what Rust accepted, so a later "unchanged" can be trusted.
  for (const pin of result.pins)
    if (accepted.has(pin.sessionId)) verifiedFixes.set(pin.sessionId, JSON.stringify(pin.fix));
  if (uploaded || received)
    console.info(`CircleLocation: sync uploaded=${uploaded} received=${received}`);
  return result;
}
