/**
 * Typed API for the Android crypto-core module and runtime services.
 * MLS keys stay in Rust. Recovery phrases and derived backup credentials
 * cross this boundary for setup and encrypted backup storage.
 * The app uses the "device" identity slot. A native Android build is required.
 */

import NativeBridge from "../modules/family-circle-bridge";

export interface DeviceIdentity {
  deviceId: string;
}

export interface CircleBootstrap {
  circleId: string;
}

export interface MlsCommit {
  commitBytes: Uint8Array;
}

export interface EncryptedEnvelope {
  eventId: string;
  epoch: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/** senderDeviceId is the MLS-authenticated sender credential, not payload data. */
export interface DecryptedEvent {
  senderDeviceId: string;
  plaintext: Uint8Array;
}

export async function createIdentity(deviceSlot: string): Promise<DeviceIdentity> {
  return NativeBridge.createIdentity(deviceSlot);
}

export async function createCircle(deviceSlot: string): Promise<CircleBootstrap> {
  return NativeBridge.createCircle(deviceSlot);
}

export async function createKeyPackage(deviceSlot: string): Promise<Uint8Array> {
  return NativeBridge.createKeyPackage(deviceSlot);
}
export async function keyPackageIdentity(
  deviceSlot: string,
  keyPackage: Uint8Array,
): Promise<string> {
  return NativeBridge.keyPackageIdentity(deviceSlot, keyPackage);
}

/**
 * AEAD protection for the narrow pre-membership window.  Unlike MLS events,
 * a join request is not yet sent by a group member; this keeps the invite
 * secret and KeyPackage binding out of relay-visible metadata.
 */
export async function sealInviteRequest(
  inviteNonce: string,
  circleId: string,
  mailboxId: string,
  kind: string,
  payload: Uint8Array,
): Promise<Uint8Array> {
  return NativeBridge.sealInviteRequest(inviteNonce, circleId, mailboxId, kind, payload);
}
export async function openInviteRequest(
  inviteNonce: string,
  circleId: string,
  mailboxId: string,
  kind: string,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  return NativeBridge.openInviteRequest(inviteNonce, circleId, mailboxId, kind, sealed);
}

/** @deprecated Eager merge. Mobile publication must use prepareMembershipChange. */
export async function addMember(
  deviceSlot: string,
  circleId: string,
  memberKeyPackage: Uint8Array,
): Promise<MlsCommit> {
  return NativeBridge.addMember(deviceSlot, circleId, memberKeyPackage);
}

export async function processCommit(
  deviceSlot: string,
  circleId: string,
  commit: Uint8Array,
): Promise<void> {
  return NativeBridge.processCommit(deviceSlot, circleId, commit);
}

export async function createWelcome(
  deviceSlot: string,
  circleId: string,
  memberKeyPackage: Uint8Array,
): Promise<Uint8Array> {
  return NativeBridge.createWelcome(deviceSlot, circleId, memberKeyPackage);
}

export async function joinFromWelcome(deviceSlot: string, welcome: Uint8Array): Promise<string> {
  return NativeBridge.joinFromWelcome(deviceSlot, welcome);
}

/** Authority-v1 joins bind the invite's administrator to the MLS roster. */
export async function joinFromWelcomeWithAdmin(
  deviceSlot: string,
  welcome: Uint8Array,
  administrator: string,
): Promise<string> {
  return NativeBridge.joinFromWelcomeWithAdmin(deviceSlot, welcome, administrator);
}

/** Called only after a current-admin-authenticated transfer application event. */
export async function adoptMembershipAdmin(
  deviceSlot: string,
  circleId: string,
  currentAdmin: string,
  nextAdmin: string,
): Promise<void> {
  return NativeBridge.adoptMembershipAdmin(deviceSlot, circleId, currentAdmin, nextAdmin);
}

/** @deprecated Eager merge. Mobile publication must use prepareMembershipChange. */
export async function removeMember(
  deviceSlot: string,
  circleId: string,
  memberId: string,
): Promise<MlsCommit> {
  return NativeBridge.removeMember(deviceSlot, circleId, memberId);
}

/** Current member device_ids of `circleId`, per this device's local view. */
export async function listMembers(deviceSlot: string, circleId: string): Promise<string[]> {
  return NativeBridge.listMembers(deviceSlot, circleId);
}

/**
 * Remove local group state before accepting a rejoin Welcome. OpenMLS cannot
 * create a group while storage still contains the same GroupId.
 */
export async function forgetCircle(deviceSlot: string, circleId: string): Promise<void> {
  return NativeBridge.forgetCircle(deviceSlot, circleId);
}

/**
 * Create a leave proposal. OpenMLS does not allow a committer to remove itself.
 * For proposal-based commits, each recipient must process the proposal first.
 * The mobile runtime instead uses processLeave and stages an inline removal.
 */
export async function proposeLeave(deviceSlot: string, circleId: string): Promise<Uint8Array> {
  return NativeBridge.proposeLeave(deviceSlot, circleId);
}

/** Receive and locally queue a Proposal (e.g. from `proposeLeave`) — does not commit it. */
export async function processProposal(
  deviceSlot: string,
  circleId: string,
  proposal: Uint8Array,
): Promise<void> {
  return NativeBridge.processProposal(deviceSlot, circleId, proposal);
}

/** Commit whatever proposals are currently queued (via `processProposal`) for `circleId`. */
export async function commitPendingProposals(
  deviceSlot: string,
  circleId: string,
): Promise<MlsCommit> {
  return NativeBridge.commitPendingProposals(deviceSlot, circleId);
}

/**
 * Stage one membership change without moving the epoch. Empty `keyPackage`
 * and `removeIds` produce a plain key update; a rejoin removes and adds in a
 * single commit. The caller must checkpoint the returned bytes before
 * uploading them, then merge by processing its own commit at its relay
 * position. See `crypto-core/src/lib.rs`'s `prepare_membership_change`.
 */
export async function prepareMembershipChange(
  deviceSlot: string,
  circleId: string,
  keyPackage: Uint8Array,
  removeIds: string[],
): Promise<{ commitBytes: Uint8Array; welcomeBytes: Uint8Array | null }> {
  return NativeBridge.prepareMembershipChange(deviceSlot, circleId, keyPackage, removeIds);
}

/** Current epoch, and whether a staged commit is still waiting to publish. */
export async function circlePublicationState(
  deviceSlot: string,
  circleId: string,
): Promise<{ epoch: number; pendingCommit: boolean }> {
  return NativeBridge.circlePublicationState(deviceSlot, circleId);
}

/**
 * Verify a voluntary leave proposal and return the MLS-authenticated member
 * it removes, so the admin can queue the departure even while another commit
 * is pending.
 */
export async function processLeave(
  deviceSlot: string,
  circleId: string,
  proposal: Uint8Array,
): Promise<string> {
  return NativeBridge.processLeave(deviceSlot, circleId, proposal);
}

export async function encryptEvent(
  deviceSlot: string,
  circleId: string,
  payload: Uint8Array,
): Promise<EncryptedEnvelope> {
  return NativeBridge.encryptEvent(deviceSlot, circleId, payload);
}

export async function decryptEvent(
  deviceSlot: string,
  circleId: string,
  envelope: EncryptedEnvelope,
): Promise<DecryptedEvent> {
  // Destructured into top-level args, not passed as one object — see the
  // comment on this native function's declaration in index.ts for why.
  return NativeBridge.decryptEvent(
    deviceSlot,
    circleId,
    envelope.eventId,
    envelope.epoch,
    envelope.nonce,
    envelope.ciphertext,
  );
}

/**
 * Encrypt the identity and Circle state under the supplied backup key.
 * appMetadata is included unchanged so app and MLS state restore together.
 */
export async function exportEncryptedState(
  deviceSlot: string,
  encKey: Uint8Array,
  appMetadata: Uint8Array,
): Promise<Uint8Array> {
  return NativeBridge.exportEncryptedState(deviceSlot, encKey, appMetadata);
}

export interface ImportedBackup {
  deviceId: string;
  appMetadata: Uint8Array;
}

/** Restore an encrypted export, returning its identity and app metadata. */
export async function importEncryptedState(
  deviceSlot: string,
  encKey: Uint8Array,
  state: Uint8Array,
): Promise<ImportedBackup> {
  return NativeBridge.importEncryptedState(deviceSlot, encKey, state);
}

/** Generate a random 12-word BIP39 recovery phrase. No local identity is required. */
export async function generateSeedPhrase(): Promise<string> {
  return NativeBridge.generateSeedPhrase();
}

export interface BackupCredentials {
  backupId: string;
  authKey: Uint8Array;
  encKey: Uint8Array;
}

/**
 * Validate the BIP39 phrase and derive backup credentials without changing
 * local identity state. Invalid phrases are rejected before any network call.
 */
export async function deriveBackupCredentialsFromSeedPhrase(
  phrase: string,
): Promise<BackupCredentials> {
  return NativeBridge.deriveBackupCredentialsFromSeedPhrase(phrase);
}

export interface CreatedIdentity {
  deviceId: string;
  backupId: string;
  authKey: Uint8Array;
  encKey: Uint8Array;
}

/**
 * Derive a device identity from the phrase and store it under deviceSlot.
 * The same phrase produces the same signing keypair and device ID.
 */
export async function createIdentityFromSeedPhrase(
  deviceSlot: string,
  phrase: string,
): Promise<CreatedIdentity> {
  return NativeBridge.createIdentityFromSeedPhrase(deviceSlot, phrase);
}

export async function computeBackupProof(
  authKey: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  return NativeBridge.computeBackupProof(authKey, nonce);
}

/** Random bytes from the native OS CSPRNG, used for invitation secrets. */
export async function randomBytes(len: number): Promise<Uint8Array> {
  return NativeBridge.randomBytes(len);
}

/** Starts/stops bounded Android catch-up, independent of the push transport. */
export function startSyncService(): void {
  NativeBridge.startSyncService();
}

export function stopSyncService(): void {
  NativeBridge.stopSyncService();
}

/** Local notifications only. Content must already be decrypted and committed. */
export function createEventsChannel(): void {
  NativeBridge.createEventsChannel();
}

export async function requestNotificationPermission(): Promise<boolean> {
  return NativeBridge.requestNotificationPermission();
}

export function showNotification(title: string, body: string): void {
  NativeBridge.showNotification(title, body);
}

export async function refreshCircleKeys(deviceSlot: string, circleId: string): Promise<MlsCommit> {
  return NativeBridge.refreshCircleKeys(deviceSlot, circleId);
}
