import { createRuntimeDiagnostics } from "./diagnostics";
import { loadSession, saveSession } from "./persistence/session";
import {
  decodeAppMetadata,
  EMPTY_SNAPSHOT,
  encodeAppMetadata,
} from "./persistence/metadata";
import { createChatPersistence } from "./persistence/chat";
import { File, Paths } from "expo-file-system";

import Native from "../modules/family-circle-bridge";
import { base64ToBytes } from "./base64";
import * as bridge from "./bridge";
import type { ResumedIdentity } from "./persistence/types";
import * as relay from "./relay";

const CIPHERTEXT_FILE_NAME = "familycircle-backup.bin";

export type {
  BackedUpCircle,
  BackupSnapshot,
  CircleNotifications,
  MembershipChange,
  OutboxEntry,
  ResumedIdentity,
  SavedChatItem,
} from "./persistence/types";

const persistence = createChatPersistence(Native, relay);
const { configureLocal } = persistence;

export const {
  bindRuntime,
  afterStateCommit,
  stateTransaction,
  pendingMessageCount,
  queueEnvelope,
  discardMailboxApplications,
  discardMailboxOutbox,
  flushOutbox,
  resealRejected,
  hasRejectedEnvelope,
} = persistence;

function ciphertextFile(): File {
  return new File(Paths.document, CIPHERTEXT_FILE_NAME);
}

/**
 * Resume without a network request when SecureStore credentials and a local
 * encrypted checkpoint are available. Return null if either is missing.
 * `src/runtime/identity.ts` calls this during app initialization.
 */
export async function tryResumeFromLocalCache(
  deviceSlot: string,
): Promise<ResumedIdentity | null> {
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
    snapshot.circles = snapshot.circles.map((circle) => ({
      ...circle,
      recoveryRequired: true,
    }));
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
   * Setup persists the derived `authKey`/`encKey` via `saveSession`. The phrase
   * is written to a file only if the user chooses "Save as file".
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

  // A new identity has no Circles or nicknames to include in the first backup.
  const ciphertext = await bridge.exportEncryptedState(
    deviceSlot,
    created.encKey,
    new Uint8Array(0),
  );

  const registered = await relay.registerBackup(
    created.backupId,
    created.authKey,
    ciphertext,
  );
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

/** Fetch and restore the encrypted backup using its 12-word seed phrase. */
export async function restoreFromBackup(
  deviceSlot: string,
  seedPhrase: string,
): Promise<ResumedIdentity> {
  // Validate the phrase and checksum locally before contacting the relay.
  // InvalidSeedPhrase propagates through the bridge to the setup UI.
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
  const imported = await bridge.importEncryptedState(
    deviceSlot,
    keys.encKey,
    fetched.ciphertext,
  );
  await saveSession({
    backupId: keys.backupId,
    authKey: keys.authKey,
    encKey: keys.encKey,
  });
  const snapshot = decodeAppMetadata(imported.appMetadata);
  // A remote copy can be behind even when it was uploaded successfully. Never
  // resume its sending ratchet or replay its uncertain outgoing queue.
  // Prepared commits are the exception to dropping uncertain remote sends:
  // OpenMLS stays in the old epoch until the same commit is read from the relay.
  // Preserve their original IDs/bytes (and dependent Welcomes) for idempotent
  // publication; never generate a replacement for an ambiguous outcome.
  const pendingIds = new Set(
    snapshot.circles.map((circle) => circle.pendingCommitEventId).filter(Boolean),
  );
  snapshot.outbox = (snapshot.outbox ?? []).filter(
    (entry) =>
      (entry.kind === "commit" && pendingIds.has(entry.eventId)) ||
      (entry.kind === "welcome" &&
        !!entry.commitEventId &&
        pendingIds.has(entry.commitEventId)),
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
const reportFailure = createRuntimeDiagnostics();
let syncing = false;
const BACKUP_RETRY_MIN_MS = 30_000;
const BACKUP_RETRY_MAX_MS = 5 * 60_000;
let retryDelay = BACKUP_RETRY_MIN_MS;
let lastAttempt = 0;
let nextAttempt = 0;
export async function syncBackupNow(deviceSlot: string): Promise<void> {
  const now = Date.now();
  // A backwards clock adjustment must not strand recovery uploads behind a
  // deadline from the old clock. Concurrent callers still share one attempt.
  if (syncing || !persistence.ready || (now >= lastAttempt && now < nextAttempt)) return;
  syncing = true;
  let attempted = false;
  let success = false;
  try {
    const current = await loadSession();
    if (!current) return;
    attempted = true;
    // Export a separate recovery copy; never upload the local conversation archive.
    const ciphertext = await persistence.run(() => {
      const { timeline: _localHistory, ...recovery } = persistence.snapshot();
      return bridge.exportEncryptedState(
        deviceSlot,
        current.encKey,
        encodeAppMetadata(recovery),
      );
    });
    if (!ciphertext) return;
    const nonce = await relay.requestBackupChallenge(current.backupId);
    if (!nonce) return;
    const proof = await bridge.computeBackupProof(current.authKey, base64ToBytes(nonce));
    success =
      (await relay.updateBackup(current.backupId, nonce, proof, ciphertext)) === "ok";
  } catch (error) {
    reportFailure("Recovery backup", error);
    /* Local state remains durable while offline. */
  } finally {
    if (attempted) {
      lastAttempt = Date.now();
      nextAttempt = lastAttempt + (success ? BACKUP_RETRY_MIN_MS : retryDelay);
      retryDelay = success
        ? BACKUP_RETRY_MIN_MS
        : Math.min(BACKUP_RETRY_MAX_MS, retryDelay * 2);
    }
    syncing = false;
  }
}
