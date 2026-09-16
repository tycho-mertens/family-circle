import { relayFetch } from "./relay-access";
/**
 * Relay HTTP client. Request and response shapes are defined in relay/Contracts/Dtos.cs.
 * EXPO_PUBLIC_RELAY_URL is embedded at bundle time; detect-lan-ip.js configures LAN builds.
 *
 * Mailbox kinds identify encrypted application messages, pairing requests, MLS
 * Welcomes and Commits, leave proposals, and location controls. The relay stores
 * the tag and uses commit/leave kinds for retention; clients interpret the payload.
 * Join and rejoin requests are sealed with the invite secret and have opaque IDs.
 * Legacy join-rejected messages are still accepted for compatibility.
 */

import * as bridge from "./bridge";
import { base64ToBytes, bytesToBase64 } from "./base64";

export type EnvelopeKind =
  | "application"
  | "location-control-v1"
  | "keypackage"
  | "welcome"
  | "commit"
  | "join-rejected"
  | "leave"
  | "rejoin-request";

/** What actually comes back from the relay for any kind of envelope. */
export interface MailboxEnvelope {
  sequenceId: number;
  eventId: string;
  epoch: number;
  kind: EnvelopeKind;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

const RELAY_URL = process.env.EXPO_PUBLIC_RELAY_URL;

function baseUrl(): string {
  if (!RELAY_URL) {
    throw new Error(
      "EXPO_PUBLIC_RELAY_URL is not set. Run `npm run detect-lan-ip` (or `npm start` / " +
        "`npm run android`, which do this automatically) and restart Metro.",
    );
  }
  return RELAY_URL;
}

interface EnvelopeWire {
  sequenceId: number;
  eventId: string;
  epoch: number;
  kind: string;
  nonce: string; // base64
  ciphertext: string; // base64
  createdAt: string;
}

function fromWireEnvelope(wire: EnvelopeWire): MailboxEnvelope {
  return {
    sequenceId: wire.sequenceId,
    eventId: wire.eventId,
    epoch: wire.epoch,
    kind: wire.kind as EnvelopeKind,
    nonce: base64ToBytes(wire.nonce),
    ciphertext: base64ToBytes(wire.ciphertext),
  };
}

async function checkOk(response: Response, action: string): Promise<Response> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`relay ${action} failed: ${response.status} ${body}`.trim());
  }
  return response;
}

/** Not a cryptographic id — just needs to be unique enough for one Circle's mailbox. */
export function randomId(): string {
  const bytes = new Uint8Array(12);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `${Date.now().toString(16)}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Generate a hex-encoded invitation secret with crypto-core's OS CSPRNG.
 * randomId() is only for identifiers and must not be used for admission secrets.
 */
export async function secureNonce(): Promise<string> {
  const bytes = await bridge.randomBytes(16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function healthCheck(): Promise<boolean> {
  try {
    const response = await relayFetch(`${baseUrl()}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

/** Registers a brand-new opaque mailbox on the relay. */
export async function registerMailbox(): Promise<string> {
  const response = await relayFetch(`${baseUrl()}/v1/devices`, { method: "POST" });
  await checkOk(response, "register mailbox");
  const body = (await response.json()) as { mailboxId: string };
  return body.mailboxId;
}

let capabilities:
  | Promise<{ membershipAdmission?: string; locationBatch?: boolean; syncHub?: string }>
  | undefined;
let capabilitiesAt = 0;
export function relayCapabilities() {
  if (Date.now() - capabilitiesAt > 60_000) {
    capabilities = undefined;
    capabilitiesAt = Date.now();
  }
  return (capabilities ??= relayFetch(`${baseUrl()}/v1/capabilities`, {
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (response) => {
      if (response.status === 404) return {};
      await checkOk(response, "capabilities");
      return response.json();
    })
    .catch((error) => {
      capabilities = undefined;
      throw error;
    }));
}

/** Idempotent on `eventId` — safe to retry. */
export async function uploadEnvelope(
  mailboxId: string,
  envelope: {
    eventId: string;
    epoch: number;
    kind: EnvelopeKind;
    nonce: Uint8Array;
    ciphertext: Uint8Array;
    expectedSequenceId?: number;
  },
  ttlSeconds?: number,
): Promise<number> {
  const admission =
    envelope.expectedSequenceId === undefined
      ? undefined
      : (await relayCapabilities()).membershipAdmission;
  const response = await relayFetch(`${baseUrl()}/v1/mailboxes/${mailboxId}/events`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventId: envelope.eventId,
      epoch: envelope.epoch,
      kind: envelope.kind,
      nonce: bytesToBase64(envelope.nonce),
      ciphertext: bytesToBase64(envelope.ciphertext),
      ttlSeconds: ttlSeconds ?? null,
      expectedSequenceId: envelope.expectedSequenceId ?? null,
      admission: admission === "membership-v1" ? admission : null,
    }),
  });
  if (response.status === 409 && (await response.json()).code === "mailbox-changed")
    throw new MailboxChangedError();
  await checkOk(response, "upload event");
  return ((await response.json()) as EnvelopeWire).sequenceId;
}

/**
 * Upload control traffic using sentinel epoch and nonce fields. The payload
 * carries its own protocol data. Use an opaque eventId for join requests.
 */
export async function uploadControlMessage(
  mailboxId: string,
  kind: Exclude<EnvelopeKind, "application">,
  payload: Uint8Array,
  eventId?: string,
): Promise<string> {
  const id = eventId ?? randomId();
  await uploadEnvelope(mailboxId, {
    eventId: id,
    epoch: 0,
    kind,
    nonce: new Uint8Array([0]),
    ciphertext: payload,
  });
  return id;
}

// Legacy event IDs use colons because randomId() can contain a dash.
const INVITE_NONCE_PREFIX = "kp-invite:";

/** Opaque ID for an encrypted normal join request. Never embed invite data here. */
export function buildInviteRequestEventId(): string {
  return `kp-request:${randomId()}`;
}

/** Legacy rejoin rejection helper. Normal joins use buildInviteRequestEventId instead. */
export function buildKeyPackageEventId(inviteNonce: string): string {
  return `${INVITE_NONCE_PREFIX}${inviteNonce}:${randomId()}`;
}

/** Recovers the invite nonce from a "keypackage" envelope's eventId, or null if absent/malformed. */
export function parseInviteNonce(eventId: string): string | null {
  if (!eventId.startsWith(INVITE_NONCE_PREFIX)) return null;
  const nonce = eventId.slice(INVITE_NONCE_PREFIX.length).split(":")[0];
  return nonce || null;
}

/** Opaque ID for an encrypted rejoin request. */
export function buildRejoinRequestEventId(): string {
  return `rejoin-request:${randomId()}`;
}

export async function fetchEnvelopes(
  mailboxId: string,
  afterSequenceId = 0,
): Promise<MailboxEnvelope[]> {
  // Catch-up buffers all pages before returning, so memory use grows with the backlog.
  const envelopes: MailboxEnvelope[] = [];
  let cursor = afterSequenceId;
  for (;;) {
    const response = await relayFetch(
      `${baseUrl()}/v1/mailboxes/${mailboxId}/events?after=${cursor}&limit=100`,
      { signal: AbortSignal.timeout(10_000) },
    );
    await checkOk(response, "fetch events");
    const page = ((await response.json()) as EnvelopeWire[]).map(fromWireEnvelope);
    envelopes.push(...page);
    if (page.length < 100) return envelopes;
    const next = Math.max(...page.map((event) => event.sequenceId));
    if (next <= cursor) throw new Error("The server returned a repeated mailbox page.");
    cursor = next;
  }
}

export async function ackEvents(mailboxId: string, sequenceId: number): Promise<void> {
  const response = await relayFetch(`${baseUrl()}/v1/mailboxes/${mailboxId}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sequenceId }),
  });
  await checkOk(response, "ack events");
}

// Backup endpoints return expected 401/404/409 outcomes as data for backup.ts.
// The relay receives a challenge-response verifier and ciphertext, never the
// recovery phrase or backup encryption key.

/** `null` means no backup is registered for this backupId yet. */
export async function requestBackupChallenge(backupId: string): Promise<string | null> {
  const response = await relayFetch(`${baseUrl()}/v1/backups/${backupId}/challenge`, {
    method: "POST",
  });
  if (response.status === 404) return null;
  await checkOk(response, "request backup challenge");
  const body = (await response.json()) as { nonce: string };
  return body.nonce;
}

/**
 * Register a backup without overwriting an existing one.
 * Returns false on HTTP 409 when the backup ID is already registered.
 */
export async function registerBackup(
  backupId: string,
  authVerifier: Uint8Array,
  ciphertext: Uint8Array,
): Promise<boolean> {
  const response = await relayFetch(`${baseUrl()}/v1/backups/${backupId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authVerifier: bytesToBase64(authVerifier),
      ciphertext: bytesToBase64(ciphertext),
    }),
  });
  if (response.status === 409) return false;
  await checkOk(response, "register backup");
  return true;
}

export type BackupWriteResult = "ok" | "unauthorized" | "not-found";

/**
 * `nonce` must be one this exact backupId issued via
 * `requestBackupChallenge`, and `proof` must be
 * `computeBackupProof(authKey, base64ToBytes(nonce))` — see
 * `src/backup.ts`. "unauthorized" covers both a wrong seed phrase and a
 * stale/already-used nonce; the relay doesn't distinguish them and
 * neither should the caller (both just mean "try a fresh challenge").
 */
export async function updateBackup(
  backupId: string,
  nonce: string,
  proof: Uint8Array,
  ciphertext: Uint8Array,
): Promise<BackupWriteResult> {
  const response = await relayFetch(`${baseUrl()}/v1/backups/${backupId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nonce,
      proof: bytesToBase64(proof),
      ciphertext: bytesToBase64(ciphertext),
    }),
  });
  if (response.status === 401) return "unauthorized";
  if (response.status === 404) return "not-found";
  await checkOk(response, "update backup");
  return "ok";
}

export type BackupFetchResult =
  | { status: "ok"; ciphertext: Uint8Array }
  | { status: "unauthorized" }
  | { status: "not-found" };

/** Same nonce/proof contract as `updateBackup`. */
export async function fetchBackup(
  backupId: string,
  nonce: string,
  proof: Uint8Array,
): Promise<BackupFetchResult> {
  const params = new URLSearchParams({ nonce, proof: bytesToBase64(proof) });
  const response = await relayFetch(`${baseUrl()}/v1/backups/${backupId}?${params.toString()}`);
  if (response.status === 401) return { status: "unauthorized" };
  if (response.status === 404) return { status: "not-found" };
  await checkOk(response, "fetch backup");
  const body = (await response.json()) as { ciphertext: string };
  return { status: "ok", ciphertext: base64ToBytes(body.ciphertext) };
}

export class MailboxChangedError extends Error {
  constructor() {
    super("Mailbox changed before upload");
  }
}
export const isMailboxChanged = (error: unknown): boolean => error instanceof MailboxChangedError;
