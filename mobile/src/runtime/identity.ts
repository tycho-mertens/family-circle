import { cleanProfilePhotos } from "../profile-photo";
import { RuntimeChanges, ref } from "./observable";
import * as backup from "../backup";

const DEVICE_SLOT = "device";
import { MAX_NICKNAME_LEN } from "./identity-constants";
export { MAX_NICKNAME_LEN } from "./identity-constants";

export interface IdentityContextValue {
  resuming: boolean;
  deviceId: string | null;
  deviceIdRef: { current: string | null };
  nicknames: Record<string, string>;
  nicknamesRef: { current: Record<string, string> };
  updateNicknames: (
    updater: (prev: Record<string, string>) => Record<string, string>,
  ) => void;

  profilePhotos: Record<string, string | null>;
  profilePhotosRef: { current: Record<string, string | null> };
  updateProfilePhotos: (
    updater: (prev: Record<string, string | null>) => Record<string, string | null>,
  ) => void;

  // Shared across onboarding screens. Form inputs stay local to each screen.
  createdIdentity: backup.CreatedIdentityResult | null;
  seedPhraseSaved: boolean;
  nicknameComplete: boolean;
  finishNickname: (nickname?: string, photo?: string | null) => void;
  setupBusy: boolean;
  setupError: string | null;

  createNewIdentity: () => Promise<void>;
  saveSeedPhraseToFile: () => Promise<boolean>;
  confirmSeedPhraseSaved: () => void;
  finishSetup: () => void;
  restoreFromSeedPhrase: (phrase: string) => Promise<boolean>;

  // Restored circles and history waiting for the circles runtime to consume them.
  pendingCircleSeed: backup.BackedUpCircle[] | null;
  pendingTimeline: backup.SavedChatItem[];
  clearPendingCircleSeed: () => void;
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function createIdentityRuntime() {
  const changes = new RuntimeChanges();
  let deviceId: string | null = null;
  const setDeviceId = (value: string | null) => {
    deviceId = value;
    changes.emit();
  };
  let nicknameComplete: boolean = false;
  const setNicknameComplete = (value: boolean) => {
    nicknameComplete = value;
    changes.emit();
  };
  let resuming: boolean = true;
  const setResuming = (value: boolean) => {
    resuming = value;
    changes.emit();
  };
  let createdIdentity: backup.CreatedIdentityResult | null = null;
  const setCreatedIdentity = (value: backup.CreatedIdentityResult | null) => {
    createdIdentity = value;
    changes.emit();
  };
  let setupBusy: boolean = false;
  const setSetupBusy = (value: boolean) => {
    setupBusy = value;
    changes.emit();
  };
  let pendingIdentity: backup.ResumedIdentity | null = null;
  const setPendingIdentity = (value: backup.ResumedIdentity | null) => {
    pendingIdentity = value;
    changes.emit();
  };
  let setupError: string | null = null;
  const setSetupError = (value: string | null) => {
    setupError = value;
    changes.emit();
  };
  let pendingTimeline: backup.SavedChatItem[] = [];
  let pendingCircleSeed: backup.BackedUpCircle[] | null = null;
  const setPendingCircleSeed = (value: backup.BackedUpCircle[] | null) => {
    pendingCircleSeed = value;
    changes.emit();
  };

  const deviceIdRef = ref<string | null>(null);

  // Update the ref synchronously so background work sees the latest nicknames.
  let nicknames: Record<string, string> = {};
  const setNicknames = (value: Record<string, string>) => {
    nicknames = value;
    changes.emit();
  };
  const nicknamesRef = ref<Record<string, string>>({});
  const updateNicknames = (
    updater: (prev: Record<string, string>) => Record<string, string>,
  ) => {
    const next = updater(nicknamesRef.current);
    nicknamesRef.current = next;
    setNicknames(next);
  };

  const profilePhotosRef = ref<Record<string, string | null>>({});
  const updateProfilePhotos = (
    updater: (prev: Record<string, string | null>) => Record<string, string | null>,
  ) => {
    profilePhotosRef.current = updater(profilePhotosRef.current);
    changes.emit();
  };

  // Apply identity state and leave circles/history for the circles runtime.
  const applyIdentity = (identity: backup.ResumedIdentity) => {
    deviceIdRef.current = identity.deviceId;
    setDeviceId(identity.deviceId);
    updateNicknames(() => identity.nicknames ?? {});
    updateProfilePhotos(() => cleanProfilePhotos(identity.profilePhotos));
    pendingTimeline = identity.timeline ?? [];
    setPendingCircleSeed(identity.circles);
  };

  let initialization: Promise<void> | null = null;
  const initialize = () =>
    (initialization ??= backup
      .tryResumeFromLocalCache(DEVICE_SLOT)
      .then((value) => {
        if (value) applyIdentity(value);
      })
      .catch((error) => {
        setSetupError("Local state could not be opened. " + describeError(error));
      })
      .finally(() => setResuming(false)));

  const createNewIdentity = async () => {
    setSetupBusy(true);
    setSetupError(null);
    try {
      const identity = await backup.createNewIdentityWithBackup(DEVICE_SLOT);
      setCreatedIdentity(identity);
    } catch (err) {
      setSetupError(describeError(err));
    } finally {
      setSetupBusy(false);
    }
  };

  const saveSeedPhraseToFile = async () => {
    if (!createdIdentity) return false;
    try {
      await backup.saveSeedPhraseToFile(createdIdentity.seedPhrase);
      return true;
    } catch (err) {
      setSetupError(describeError(err));
      return false;
    }
  };

  const confirmSeedPhraseSaved = () => {
    if (!createdIdentity) return;
    // Discard the phrase before the optional nickname step. Back navigation
    // must never re-open the one-time reveal or create another identity.
    const { seedPhrase: _, ...identity } = createdIdentity;
    setPendingIdentity(identity);
    setCreatedIdentity(null);
  };

  const finishNickname = (nickname?: string, photo?: string | null) => {
    if (!pendingIdentity) return;
    const name = nickname?.trim().slice(0, MAX_NICKNAME_LEN);
    setPendingIdentity({
      ...pendingIdentity,
      profilePhotos: cleanProfilePhotos({
        ...pendingIdentity.profilePhotos,
        [pendingIdentity.deviceId]: photo ?? null,
      }),
      nicknames: name
        ? { ...pendingIdentity.nicknames, [pendingIdentity.deviceId]: name }
        : pendingIdentity.nicknames,
    });
    setNicknameComplete(true);
  };

  const finishSetup = () => {
    if (!pendingIdentity) return;
    applyIdentity(pendingIdentity);
    setPendingIdentity(null);
  };

  // Returns whether it succeeded, so the caller (the restore screen) can
  // decide whether to navigate on; error text is already in setupError.
  const restoreFromSeedPhrase = async (phrase: string): Promise<boolean> => {
    if (!phrase.trim()) {
      setSetupError("Enter your recovery phrase.");
      return false;
    }
    setSetupBusy(true);
    setSetupError(null);
    try {
      const identity = await backup.restoreFromBackup(DEVICE_SLOT, phrase.trim());
      setPendingIdentity(identity);
      setNicknameComplete(true);
      return true;
    } catch (err) {
      setSetupError(describeError(err));
      return false;
    } finally {
      setSetupBusy(false);
    }
  };

  const value: IdentityContextValue = {
    get resuming() {
      return resuming;
    },
    get deviceId() {
      return deviceId;
    },
    deviceIdRef,
    get nicknames() {
      return nicknames;
    },
    nicknamesRef,
    updateNicknames,
    get profilePhotos() {
      return profilePhotosRef.current;
    },
    profilePhotosRef,
    updateProfilePhotos,
    get createdIdentity() {
      return createdIdentity;
    },
    get seedPhraseSaved() {
      return !!pendingIdentity;
    },
    get nicknameComplete() {
      return nicknameComplete;
    },
    finishNickname,
    get setupBusy() {
      return setupBusy;
    },
    get setupError() {
      return setupError;
    },
    createNewIdentity,
    saveSeedPhraseToFile,
    confirmSeedPhraseSaved,
    finishSetup,
    restoreFromSeedPhrase,
    get pendingTimeline() {
      return pendingTimeline;
    },
    get pendingCircleSeed() {
      return pendingCircleSeed;
    },
    clearPendingCircleSeed: () => {
      pendingTimeline = [];
      setPendingCircleSeed(null);
    },
  };
  return { changes, initialize, value };
}
export const identityRuntime = createIdentityRuntime();
