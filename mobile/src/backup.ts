import type { ChatAttachment } from "./attachment";
import type { MessageReply } from "./message-reply";
import type { VoiceMessage } from "./voice-message";
import { cleanProfilePhotos } from "./profile-photo";
/** Local MLS/app state is committed atomically before network publication.
 * Seed backups exclude local chat history and are a coalesced best-effort copy; the durable outbox contains only not-yet-acknowledged envelopes.
 */

import * as SecureStore from "expo-secure-store";
import { File, Paths } from "expo-file-system";

import * as bridge from "./bridge";
import Native from "../modules/family-circle-bridge";
import { StateJournal } from "./state-journal";
import * as relay from "./relay";
import { base64ToBytes, bytesToBase64 } from "./base64";

const SESSION_KEY = "familycircle.backupSession";
const CIPHERTEXT_FILE_NAME = "familycircle-backup.bin";

/**
 * The non-MLS half of one Circle's state: what `CircleInfo` in
 * `src/runtime/circles.ts` needs and crypto-core does not track. `lastSeenSequenceId`
 * is committed with the MLS state so a restart resumes from the matching
 * position in the mailbox.
 */
export interface BackedUpCircle {
  circleId: string;
  mailboxId: string;
  isCreator: boolean;
  invite?: { nonce: string; qrNonce?: string; expiresAt: number; used: boolean; adminId?: string };
  lastSeenSequenceId?: number;
  // Set by the admin and broadcast as a "circle-rename" AppPayload (see
  // src/runtime/circles.ts). Absent until someone names the Circle.
  circleName?: string;
  role?: "joining" | "member" | "removed";
  joinNonce?: string;
  joinRequestedAt?: number;
  ownEventIds?: string[];
  processedKeyPackageIds?: string[];
  triedWelcomeIds?: string[];
  processedLeaveIds?: string[];
  processedRejoinRequestIds?: string[];
  pendingRejoinKeyPackages?: [string, string][];
  pendingJoinKeyPackages?: [string, string][];
  pendingJoinRequestNames?: [string, string][];
  pendingJoinRequestMemberIds?: [string, string][];
  blockedAutoJoinIds?: string[];
  awaitingRejoinNonce?: string;
  recoveryRequired?: boolean;
  syncError?: string;
  pendingChats?: (
    | string
    | {
        messageId: string;
        text: string;
        voice?: VoiceMessage;
        attachment?: ChatAttachment;
        replyTo?: MessageReply;
        sentAt?: number;
      }
  )[];
  pendingBroadcasts?: string[];
  membershipChanges?: MembershipChange[];
  pendingCommitEventId?: string;
  adminId?: string;
  authorityAdminId?: string;
  membershipAuthority?: "v1";
  deleting?: boolean;
  leaveEpoch?: number;
  departingMembers?: string[];
  members?: string[];
  notifications?: CircleNotifications;
  lastSuccessfulSync?: number;
  departureConfirmedAt?: number;
  awaitingAdminAnnouncement?: boolean;
  handover?: { id: string; adminId: string; eventId?: string; confirmed?: boolean };
}

export interface CircleNotifications {
  chat: boolean;
  location: boolean;
  quietHours: boolean;
  quietStart: string;
  quietEnd: string;
}

export type MembershipChange =
  | { type: "refresh" }
  | { type: "remove"; memberId: string }
  | { type: "add"; keyPackage: string }
  | { type: "rejoin"; memberId: string; keyPackage: string };

/** Local timeline entry. Recovery uploads exclude this history. */
export interface SavedChatItem {
  id: string;
  circleId: string;
  kind: "chat" | "system";
  text: string;
  voice?: VoiceMessage;
  attachment?: ChatAttachment;
  attachmentParts?: Record<string, string>;
  replyTo?: MessageReply;
  senderId?: string;
  at: number;
  sentAt?: number;
  editedAt?: number;
  originalText?: string;
  deletedAt?: number;
  messageId?: string;
  delivery?: "waiting" | "sent" | "delivered";
  recipients?: string[];
  deliveredTo?: string[];
  reactions?: Record<string, string>; // Authenticated member ID -> one emoji.
}

export interface BackupSnapshot {
  timeline?: SavedChatItem[];
  nicknames: Record<string, string>;
  profilePhotos?: Record<string, string | null>;
  circles: BackedUpCircle[];
  outbox?: OutboxEntry[];
}

export interface ResumedIdentity {
  timeline?: SavedChatItem[];
  deviceId: string;
  circles: BackedUpCircle[];
  nicknames: Record<string, string>;
  profilePhotos?: Record<string, string | null>;
}

interface Session {
  backupId: string;
  authKey: Uint8Array;
  encKey: Uint8Array;
}

// Cache credentials for this process; SecureStore holds the persisted copy.
let session: Session | null = null;

// The provider reads current refs, not React render state. Every transaction
// checkpoints them together with the native MLS state; rollback restores both.
let snapshotRestorer: (snapshot: BackupSnapshot) => void = () => {};
let outbox: OutboxEntry[] = [];
const journal = new StateJournal();
let initialized = false;
let committedListener = () => {};
let envelopeAcknowledged: (entry: OutboxEntry) => void = () => {};
/** Runs inside the acknowledgement transaction, so delivery metadata and outbox commit together. */
export function onEnvelopeAcknowledged(listener: (entry: OutboxEntry) => void) {
  envelopeAcknowledged = listener;
}

export function onStateCommitted(listener: () => void) {
  committedListener = listener;
  return () => {
    committedListener = () => {};
  };
}
export function pendingMessageCount(mailboxId: string) {
  const messages = new Set<string>();
  for (const entry of outbox) {
    if (entry.mailboxId !== mailboxId || entry.kind !== "application") continue;
    try {
      const payload = entry.plaintext ? JSON.parse(entry.plaintext) : null;
      if (!payload || payload.type === "chat" || payload.type === "attachment-chunk")
        messages.add(payload?.messageId ?? entry.eventId);
    } catch {
      messages.add(entry.eventId);
    } // Legacy plain-text drafts.
  }
  return messages.size;
}

let effects: (() => void)[] | null = null;
export function afterStateCommit(effect: () => void): void {
  if (effects) effects.push(effect);
  else effect();
}

let snapshotProvider: () => BackupSnapshot = () => ({ nicknames: {}, circles: [] });

export function registerSnapshotProvider(
  provider: () => BackupSnapshot,
  restore: (snapshot: BackupSnapshot) => void,
): void {
  snapshotProvider = provider;
  snapshotRestorer = restore;
}

export interface OutboxEntry {
  mailboxId: string;
  eventId: string;
  epoch: number;
  kind: relay.EnvelopeKind;
  nonce: string;
  ciphertext: string;
  expectedSequenceId?: number;
  plaintext?: string; // Only inside the encrypted local checkpoint, never sent to the relay.
  needsSync?: boolean;
  commitEventId?: string; // The prepared commit associated with a Welcome.
}

export function queueEnvelope(
  mailboxId: string,
  envelope: {
    eventId: string;
    epoch: number;
    kind: relay.EnvelopeKind;
    nonce: Uint8Array;
    ciphertext: Uint8Array;
    expectedSequenceId?: number;
    plaintext?: string;
    commitEventId?: string;
  },
): void {
  if (!outbox.some((entry) => entry.eventId === envelope.eventId)) {
    outbox.push({
      ...envelope,
      mailboxId,
      nonce: bytesToBase64(envelope.nonce),
      ciphertext: bytesToBase64(envelope.ciphertext),
    });
  }
}

/** Keep membership protocol envelopes until a leave has been confirmed. */
export function discardMailboxApplications(mailboxId: string): void {
  outbox = outbox.filter((entry) => entry.mailboxId !== mailboxId || entry.kind !== "application");
}

/** Call inside stateTransaction when deleting a local Circle. */
export function discardMailboxOutbox(mailboxId: string): void {
  outbox = outbox.filter((entry) => entry.mailboxId !== mailboxId);
}

const snapshot = (): BackupSnapshot => ({
  ...snapshotProvider(),
  outbox: outbox.map((entry) => ({ ...entry })),
});

export async function stateTransaction<T>(operation: () => Promise<T>): Promise<T> {
  if (!initialized) throw new Error("Your identity is still loading. Try again shortly.");
  return journal.transaction(
    {
      snapshot,
      begin: async () => {
        await Native.beginChatTransaction();
        effects = [];
      },
      commit: async () => {
        await Native.commitChatTransaction(encodeAppMetadata(snapshot()));
        const committed = effects ?? [];
        effects = null;
        try {
          committedListener();
        } catch {
          /* A UI listener cannot undo a committed write. */
        }
        for (const effect of committed) {
          try {
            effect();
          } catch {
            /* UI effects cannot roll back a committed checkpoint. */
          }
        }
      },
      rollback: async (before) => {
        effects = null;
        await Native.abortChatTransaction();
        outbox = before.outbox ?? [];
        snapshotRestorer(before);
      },
    },
    operation,
  );
}

let flushing: Promise<void> | null = null;
export function flushOutbox(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    while (outbox.length) {
      // Take only committed data: an ongoing transaction may still roll back.
      const entry = await journal.run(async () => {
        const blocked = new Set(
          snapshotProvider()
            .circles.filter((circle) => circle.syncError)
            .map((circle) => circle.mailboxId),
        );
        for (const pending of outbox) {
          if (blocked.has(pending.mailboxId)) continue;
          if (pending.needsSync) {
            blocked.add(pending.mailboxId);
            continue;
          }
          return pending;
        }
        return undefined;
      });
      if (!entry) break;
      let acceptedSequence: number;
      try {
        acceptedSequence = await relay.uploadEnvelope(entry.mailboxId, {
          ...entry,
          nonce: base64ToBytes(entry.nonce),
          ciphertext: base64ToBytes(entry.ciphertext),
        });
      } catch (error) {
        if (relay.isMailboxChanged(error)) {
          // The server positively confirmed this id was NOT stored. Catch up
          // before resealing; unknown outcomes always retry the original bytes.
          await stateTransaction(async () => {
            const pending = outbox.find((item) => item.eventId === entry.eventId);
            if (pending) pending.needsSync = true;
          });
        }
        break;
      }
      await stateTransaction(async () => {
        envelopeAcknowledged(entry);
        outbox = outbox.filter((item) => item.eventId !== entry.eventId);
        // A successful conditional append proves there was no intervening
        // envelope. Advance sibling queued messages over this known own echo.
        if (entry.expectedSequenceId !== undefined && Number.isFinite(acceptedSequence)) {
          for (const pending of outbox)
            if (
              pending.mailboxId === entry.mailboxId &&
              pending.expectedSequenceId === entry.expectedSequenceId
            )
              pending.expectedSequenceId = acceptedSequence;
        }
      });
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Called inside a transaction after fetching and processing all mailbox pages. */
export async function resealRejected(
  mailboxId: string,
  cursor: number,
  currentEpoch: number,
  encrypt: (plaintext: string) => Promise<bridge.EncryptedEnvelope>,
): Promise<void> {
  for (const entry of outbox.filter((item) => item.mailboxId === mailboxId && item.needsSync)) {
    // A pending local commit leaves the current epoch active. A same-epoch
    // rejection needs only a fresh cursor, not a new ratchet generation.
    if (entry.epoch === currentEpoch) {
      entry.expectedSequenceId = cursor;
      entry.needsSync = false;
      continue;
    }
    if (entry.plaintext === undefined)
      throw new Error("A queued message from an older app cannot be retried automatically.");
    const sealed = await encrypt(entry.plaintext);
    Object.assign(entry, {
      epoch: sealed.epoch,
      nonce: bytesToBase64(sealed.nonce),
      ciphertext: bytesToBase64(sealed.ciphertext),
      expectedSequenceId: cursor,
      needsSync: false,
    });
  }
}
export function hasRejectedEnvelope(mailboxId: string): boolean {
  return outbox.some((entry) => entry.mailboxId === mailboxId && entry.needsSync);
}

async function configureLocal(
  encKey: Uint8Array,
  initial: BackupSnapshot,
  preserveLocations = false,
): Promise<void> {
  outbox = initial.outbox ?? [];
  await Native.configureChatState(encKey, encodeAppMetadata(initial), preserveLocations);
  await Native.beginChatTransaction();
  await Native.commitChatTransaction(encodeAppMetadata(initial));
  initialized = true;
}

function ciphertextFile(): File {
  return new File(Paths.document, CIPHERTEXT_FILE_NAME);
}

interface StoredSession {
  backupId: string;
  authKey: string; // base64
  encKey: string; // base64
}

async function saveSession(next: Session): Promise<void> {
  session = next;
  const stored: StoredSession = {
    backupId: next.backupId,
    authKey: bytesToBase64(next.authKey),
    encKey: bytesToBase64(next.encKey),
  };
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(stored));
}

async function loadSession(): Promise<Session | null> {
  if (session) return session;
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredSession;
    session = {
      backupId: stored.backupId,
      authKey: base64ToBytes(stored.authKey),
      encKey: base64ToBytes(stored.encKey),
    };
    return session;
  } catch {
    return null; // corrupt/unreadable cache — treat as "no local session"
  }
}

function encodeAppMetadata(snapshot: BackupSnapshot): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(snapshot));
}

const EMPTY_SNAPSHOT: BackupSnapshot = { nicknames: {}, circles: [] };

function decodeAppMetadata(bytes: Uint8Array): BackupSnapshot {
  if (bytes.length === 0) return EMPTY_SNAPSHOT;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.circles)) {
      const nicknames =
        parsed.nicknames && typeof parsed.nicknames === "object" ? parsed.nicknames : {};
      return {
        nicknames,
        profilePhotos: cleanProfilePhotos(parsed.profilePhotos),
        timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
        circles: parsed.circles as BackedUpCircle[],
        outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
      };
    }
    return EMPTY_SNAPSHOT;
  } catch {
    return EMPTY_SNAPSHOT; // corrupt/unrecognized metadata — resume identity-only rather than fail entirely
  }
}

/**
 * Same-install, no-network resume: true only if both the small secrets
 * (SecureStore) and the ciphertext blob (the file) are present locally.
 * Called once on app launch, before any setup or restore UI, from the
 * initialization in `src/runtime/identity.ts`.
 */
export async function tryResumeFromLocalCache(deviceSlot: string): Promise<ResumedIdentity | null> {
  const loaded = await loadSession();
  if (!loaded) return null;

  const durable = await Native.readChatState();
  const legacy = ciphertextFile();
  if (!durable && !legacy.exists) return null;
  const imported = await bridge.importEncryptedState(
    deviceSlot,
    loaded.encKey,
    durable ?? legacy.bytesSync(),
  );
  const snapshot = decodeAppMetadata(imported.appMetadata);
  // Legacy checkpoints did not track chat sends. Treat their sending state as
  // uncertain; recovery rotates membership before any new application sends.
  if (!durable)
    snapshot.circles = snapshot.circles.map((circle) => ({ ...circle, recoveryRequired: true }));
  await configureLocal(loaded.encKey, snapshot, true);
  return {
    deviceId: imported.deviceId,
    circles: snapshot.circles,
    nicknames: snapshot.nicknames,
    profilePhotos: snapshot.profilePhotos,
    timeline: snapshot.timeline,
  };
}

export interface CreatedIdentityResult extends ResumedIdentity {
  /**
   * Shown once, right after creation, by `app/(onboarding)/seed-phrase.tsx`
   * ("Save as file" / "I've saved it").
   * Never stored by this file itself in plaintext anywhere; only its
   * HKDF-derived `authKey`/`encKey` (via `saveSession`) persist locally.
   */
  seedPhrase: string;
}

/**
 * Create an identity from a generated seed phrase and register its first backup.
 * An existing backup ID is an error; registration must never overwrite it.
 */
export async function createNewIdentityWithBackup(
  deviceSlot: string,
): Promise<CreatedIdentityResult> {
  const seedPhrase = await bridge.generateSeedPhrase();
  const created = await bridge.createIdentityFromSeedPhrase(deviceSlot, seedPhrase);

  const alreadyChallengeable = await relay.requestBackupChallenge(created.backupId);
  if (alreadyChallengeable) {
    // Reject a collision before attempting to register the backup.
    throw new Error(
      "A backup already exists for this generated seed phrase (extremely unlikely) — please try again.",
    );
  }

  // A brand-new identity has no Circles or nicknames yet — nothing for
  // snapshotProvider to contribute here.
  const ciphertext = await bridge.exportEncryptedState(
    deviceSlot,
    created.encKey,
    new Uint8Array(0),
  );

  const registered = await relay.registerBackup(created.backupId, created.authKey, ciphertext);
  if (!registered) {
    // Registration raced with another request. Do not report setup as complete
    // until this identity has a backup.
    throw new Error(
      "Could not register a backup for this identity — your Circle still works locally, " +
        "but try again to back it up.",
    );
  }

  await saveSession({
    backupId: created.backupId,
    authKey: created.authKey,
    encKey: created.encKey,
  });
  await configureLocal(created.encKey, EMPTY_SNAPSHOT);
  return { deviceId: created.deviceId, circles: [], nicknames: {}, seedPhrase };
}

/** Restores a previously backed-up identity from nothing but its 12-word seed phrase. */
export async function restoreFromBackup(
  deviceSlot: string,
  seedPhrase: string,
): Promise<ResumedIdentity> {
  // Throws (InvalidSeedPhrase, via bridge/native error propagation) on a
  // malformed phrase or bad checksum — rejected locally, before any
  // network call. Callers should let that surface to the UI as-is.
  const keys = await bridge.deriveBackupCredentialsFromSeedPhrase(seedPhrase);

  const nonce = await relay.requestBackupChallenge(keys.backupId);
  if (!nonce) {
    throw new Error("No backup found for this seed phrase.");
  }
  const proof = await bridge.computeBackupProof(keys.authKey, base64ToBytes(nonce));
  const fetched = await relay.fetchBackup(keys.backupId, nonce, proof);

  if (fetched.status === "unauthorized") {
    throw new Error("Wrong seed phrase.");
  }
  if (fetched.status === "not-found") {
    throw new Error("No backup found for this seed phrase.");
  }

  // The encrypted backup includes the signing keypair; importing it restores
  // the identity without a separate createIdentityFromSeedPhrase call.
  const imported = await bridge.importEncryptedState(deviceSlot, keys.encKey, fetched.ciphertext);
  await saveSession({ backupId: keys.backupId, authKey: keys.authKey, encKey: keys.encKey });
  const snapshot = decodeAppMetadata(imported.appMetadata);
  // A remote copy can be behind even when it was uploaded successfully. Never
  // resume its sending ratchet or replay its uncertain outgoing queue.
  // Prepared commits are the exception to dropping uncertain remote sends:
  // OpenMLS is still in the OLD epoch until their exact echo is processed.
  // Preserve their original IDs/bytes (and dependent Welcomes) for idempotent
  // publication; never generate a replacement for an ambiguous outcome.
  const pendingIds = new Set(
    snapshot.circles.map((circle) => circle.pendingCommitEventId).filter(Boolean),
  );
  snapshot.outbox = (snapshot.outbox ?? []).filter(
    (entry) =>
      (entry.kind === "commit" && pendingIds.has(entry.eventId)) ||
      (entry.kind === "welcome" && !!entry.commitEventId && pendingIds.has(entry.commitEventId)),
  );
  snapshot.circles = snapshot.circles.map((circle) => ({
    ...circle,
    recoveryRequired: true,
    pendingChats: [],
    pendingBroadcasts: [],
    membershipChanges: [],
  }));
  await configureLocal(keys.encKey, snapshot);
  return {
    deviceId: imported.deviceId,
    circles: snapshot.circles,
    nicknames: snapshot.nicknames,
    profilePhotos: snapshot.profilePhotos,
    timeline: snapshot.timeline,
  };
}

/**
 * Writes the seed phrase to a plain text file in Android's Downloads
 * collection. Only reachable from the one-time setup reveal; the app does not
 * keep the phrase afterwards.
 */
export async function saveSeedPhraseToFile(seedPhrase: string): Promise<void> {
  await Native.saveSeedPhraseToDownloads(seedPhrase);
}

// Serialize recovery exports with state transactions so MLS and metadata match.
// Network failures do not roll back the local checkpoint or hold its queue.
let syncing = false;
const BACKUP_RETRY_MIN_MS = 30_000;
const BACKUP_RETRY_MAX_MS = 5 * 60_000;
let retryDelay = BACKUP_RETRY_MIN_MS;
let lastAttempt = 0;
let nextAttempt = 0;
export async function syncBackupNow(_deviceSlot: string): Promise<void> {
  const now = Date.now();
  // A backwards clock adjustment must not strand recovery uploads behind a
  // deadline from the old clock. Concurrent callers still share one attempt.
  if (syncing || !initialized || (now >= lastAttempt && now < nextAttempt)) return;
  syncing = true;
  let attempted = false;
  let success = false;
  try {
    const current = await loadSession();
    if (!current) return;
    attempted = true;
    // Export a separate recovery copy; never upload the local conversation archive.
    const ciphertext = await journal.run(() => {
      const { timeline: _localHistory, ...recovery } = snapshot();
      return bridge.exportEncryptedState(_deviceSlot, current.encKey, encodeAppMetadata(recovery));
    });
    if (!ciphertext) return;
    const nonce = await relay.requestBackupChallenge(current.backupId);
    if (!nonce) return;
    const proof = await bridge.computeBackupProof(current.authKey, base64ToBytes(nonce));
    success = (await relay.updateBackup(current.backupId, nonce, proof, ciphertext)) === "ok";
  } catch {
    /* Local state remains durable while offline. */
  } finally {
    if (attempted) {
      lastAttempt = Date.now();
      nextAttempt = lastAttempt + (success ? BACKUP_RETRY_MIN_MS : retryDelay);
      retryDelay = success ? BACKUP_RETRY_MIN_MS : Math.min(BACKUP_RETRY_MAX_MS, retryDelay * 2);
    }
    syncing = false;
  }
}
