import { requireNativeModule } from "expo-modules-core";

/**
 * Raw Android module bindings. App code should use src/bridge.ts.
 * Identity operations take a deviceSlot; runtime services are process-wide.
 * Loading this module requires a build that includes the native implementation.
 */
interface NativeFamilyCircleBridge {
  backgroundNotificationStatus(): {
    allowed: boolean;
    enabled: boolean;
    configured: boolean;
    running: boolean;
    connected: boolean;
    batteryUnrestricted: boolean;
  };
  configureBackgroundNotifications(url: string, mailboxes: string[], token: string): void;
  setBackgroundNotificationsEnabled(enabled: boolean): void;
  requestNotificationBatteryAccess(): void;
  setAppForeground(foreground: boolean): void;
  completeSubscriberSync(requestId: string, success: boolean): void;
  configureRelayConnection(url: string, mailboxes: string[], token: string): void;
  relayConnectionStatus(): { connected: boolean; dirty: boolean };
  saveSeedPhraseToDownloads(phrase: string): Promise<void>;
  readChatState(): Promise<Uint8Array | null>;
  configureChatState(
    encKey: Uint8Array,
    metadata: Uint8Array,
    preserveLocations: boolean,
  ): Promise<void>;
  beginChatTransaction(): Promise<void>;
  commitChatTransaction(metadata: Uint8Array): Promise<Uint8Array>;
  abortChatTransaction(): Promise<void>;
  loadLocations(identity: string): Promise<void>;
  locationCommand(command: string): Promise<string>;
  locationStatusMessage(): string | null;
  locationServiceRunning(): boolean;
  startLocationService(): void;
  locationRuntimeReady(): void;
  requestLocationPermission(): Promise<boolean>;
  createIdentity(deviceSlot: string): Promise<{ deviceId: string }>;
  createCircle(deviceSlot: string): Promise<{ circleId: string }>;
  createKeyPackage(deviceSlot: string): Promise<Uint8Array>;
  keyPackageIdentity(deviceSlot: string, keyPackage: Uint8Array): Promise<string>;
  sealInviteRequest(
    inviteNonce: string,
    circleId: string,
    mailboxId: string,
    kind: string,
    payload: Uint8Array,
  ): Promise<Uint8Array>;
  openInviteRequest(
    inviteNonce: string,
    circleId: string,
    mailboxId: string,
    kind: string,
    sealed: Uint8Array,
  ): Promise<Uint8Array>;
  addMember(
    deviceSlot: string,
    circleId: string,
    memberKeyPackage: Uint8Array,
  ): Promise<{ commitBytes: Uint8Array }>;
  refreshCircleKeys(deviceSlot: string, circleId: string): Promise<{ commitBytes: Uint8Array }>;
  prepareMembershipChange(
    deviceSlot: string,
    circleId: string,
    keyPackage: Uint8Array,
    removeIds: string[],
  ): Promise<{ commitBytes: Uint8Array; welcomeBytes: Uint8Array | null }>;
  circlePublicationState(
    deviceSlot: string,
    circleId: string,
  ): Promise<{ epoch: number; pendingCommit: boolean }>;
  processLeave(deviceSlot: string, circleId: string, proposal: Uint8Array): Promise<string>;
  processCommit(deviceSlot: string, circleId: string, commit: Uint8Array): Promise<void>;
  createWelcome(
    deviceSlot: string,
    circleId: string,
    memberKeyPackage: Uint8Array,
  ): Promise<Uint8Array>;
  joinFromWelcome(deviceSlot: string, welcome: Uint8Array): Promise<string>;
  joinFromWelcomeWithAdmin(
    deviceSlot: string,
    welcome: Uint8Array,
    administrator: string,
  ): Promise<string>;
  adoptMembershipAdmin(
    deviceSlot: string,
    circleId: string,
    currentAdmin: string,
    nextAdmin: string,
  ): Promise<void>;
  removeMember(
    deviceSlot: string,
    circleId: string,
    memberId: string,
  ): Promise<{ commitBytes: Uint8Array }>;
  encryptEvent(
    deviceSlot: string,
    circleId: string,
    payload: Uint8Array,
  ): Promise<{ eventId: string; epoch: number; nonce: Uint8Array; ciphertext: Uint8Array }>;
  // Keep byte arrays as top-level arguments: Expo/JSI conversion of nested
  // Uint8Arrays fails on repeated calls. See FamilyCircleBridgeModule.kt.
  decryptEvent(
    deviceSlot: string,
    circleId: string,
    eventId: string,
    epoch: number,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<{ senderDeviceId: string; plaintext: Uint8Array }>;
  listMembers(deviceSlot: string, circleId: string): Promise<string[]>;
  // Clear stale group state before accepting a rejoin Welcome.
  forgetCircle(deviceSlot: string, circleId: string): Promise<void>;
  // A leave proposal needs another member to commit it; OpenMLS forbids self-removal.
  proposeLeave(deviceSlot: string, circleId: string): Promise<Uint8Array>;
  processProposal(deviceSlot: string, circleId: string, proposal: Uint8Array): Promise<void>;
  commitPendingProposals(
    deviceSlot: string,
    circleId: string,
  ): Promise<{ commitBytes: Uint8Array }>;
  exportEncryptedState(
    deviceSlot: string,
    encKey: Uint8Array,
    appMetadata: Uint8Array,
  ): Promise<Uint8Array>;
  importEncryptedState(
    deviceSlot: string,
    encKey: Uint8Array,
    state: Uint8Array,
  ): Promise<{ deviceId: string; appMetadata: Uint8Array }>;
  // Phrase generation and credential derivation work before an identity exists.
  // Creating the identity registers it under deviceSlot.
  generateSeedPhrase(): Promise<string>;
  deriveBackupCredentialsFromSeedPhrase(
    phrase: string,
  ): Promise<{ backupId: string; authKey: Uint8Array; encKey: Uint8Array }>;
  createIdentityFromSeedPhrase(
    deviceSlot: string,
    phrase: string,
  ): Promise<{ deviceId: string; backupId: string; authKey: Uint8Array; encKey: Uint8Array }>;
  computeBackupProof(authKey: Uint8Array, nonce: Uint8Array): Promise<Uint8Array>;
  // OS CSPRNG bytes; independent of identity state.
  randomBytes(len: number): Promise<Uint8Array>;
  // Direct background relay subscription and locally decrypted notifications.
  startSyncService(): void;
  stopSyncService(): void;
  createEventsChannel(): void;
  getThemePreference(): "system" | "light" | "dark";
  setThemePreference(theme: "system" | "light" | "dark"): void;
  getDistanceUnit(): "km" | "mi";
  setDistanceUnit(unit: "km" | "mi"): void;
  getDistanceLocation(): Promise<{
    latitude: number;
    longitude: number;
    accuracy: number;
    observedAt: number;
  } | null>;
  cancelDistanceLocation(): void;
  locationSettingsStatus(): {
    precise: boolean;
    approximate: boolean;
    locationEnabled: boolean;
    notifications: boolean;
    batteryUnrestricted: boolean;
  };
  openLocationSettings(target: "location" | "battery" | "notifications" | "app"): void;
  requestNotificationPermission(): Promise<boolean>;
  showNotification(title: string, body: string): void;
}

export default requireNativeModule<NativeFamilyCircleBridge>("FamilyCircleBridge");
