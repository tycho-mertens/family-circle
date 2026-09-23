import { createCircleStore } from "./circle-store";
import { connectionEnvironment } from "./connection-environment";
import { createCircleNotifications } from "./circle-notifications";
import { createMembershipPublication } from "./membership-publication";
import { createProfileActions } from "./profile-actions";
import { createConnectionMonitor } from "./connection-monitor";
import { createRuntimeDiagnostics } from "../diagnostics";
import { createTimeline } from "./timeline";
import { AppState } from "react-native";
import { attachmentLabel, validAttachment, type ChatAttachment } from "../attachment";
import { defaultNotifications } from "../notification-preferences";
import { SyncCoordinator } from "../sync-coordinator";
import { validVoiceMessage, voiceLabel, type VoiceMessage } from "../voice-message";
import { createApplicationHandler } from "./application-handler";
import { bucket, createCircleCheckpoints } from "./circle-checkpoints";
import { createCircleSync } from "./circle-sync";
import { createControlHandler } from "./control-handler";
import { createInvitationActions } from "./invitation-actions";
import { locationChanges } from "./location-events";
import { createMembershipActions } from "./membership-actions";
import { createMessageActions } from "./message-actions";
import { ref, RuntimeChanges } from "./observable";

import * as backup from "../backup";
import * as bridge from "../bridge";
import { loadLocations, synchronizeLocations } from "../location";
import * as relay from "../relay";
import { describeError, identityRuntime } from "./identity";

import { DEVICE_SLOT, INVITE_TTL_MS } from "./circle-constants";

import {
  type AppPayload,
  type CircleInfo,
  type CirclesContextValue,
  type Invite,
} from "./circle-types";
export {
  circleLabel,
  displayMember,
  shortId,
  type CircleInfo,
  type CirclesContextValue,
  type Role,
  type TimelineItem,
} from "./circle-types";

/** One process-wide engine. UI subscriptions never own its lifetime. */
function createCirclesRuntime() {
  const identity = identityRuntime.value;
  const changes = new RuntimeChanges();
  const reportFailure = createRuntimeDiagnostics();
  let notice: string | null = null;
  const setNotice = (value: string | null) => {
    notice = value;
    changes.emit();
  };
  let circlesReady = false;
  const setCirclesReady = (value: boolean) => {
    circlesReady = value;
    changes.emit();
  };
  let relayStatus: "checking" | "connected" | "unreachable" = "checking";
  const setRelayStatus = (value: typeof relayStatus) => {
    relayStatus = value;
    changes.emit();
  };

  const circleStore = createCircleStore(() => backup.afterStateCommit(changes.emit));
  const {
    get: getCircle,
    list: listCircles,
    put: putCircle,
    patch: patchCircle,
  } = circleStore;
  const appStateRef = ref(AppState.currentState);
  const checkpoints = createCircleCheckpoints({
    getCircles: circleStore.snapshot,
    replaceCircles: circleStore.replace,
  });
  const {
    lastSeenSequenceId,
    myOwnEventIds,
    awaitingRejoinWelcome,
    toBackedUpCircles,
    restoreCircles,
  } = checkpoints;
  const timeline = createTimeline({
    getCircle,
    onChange: () => backup.afterStateCommit(changes.emit),
  });
  const { appendSystem } = timeline;

  const forgetCircle = (circleId: string) => {
    circleStore.remove(circleId);
    checkpoints.forget(circleId);
  };

  // Invite secrets grant admission, so generate them with the native CSPRNG.
  const freshInvite = async (): Promise<Invite> => {
    const adminId = identity.deviceIdRef.current;
    if (!adminId) throw new Error("Identity is unavailable.");
    const [nonce, qrNonce] = await Promise.all([
      relay.secureNonce(),
      relay.secureNonce(),
    ]);
    return {
      nonce,
      qrNonce,
      expiresAt: Date.now() + INVITE_TTL_MS,
      used: false,
      adminId,
    };
  };

  const queueEnvelope = (
    mailboxId: string,
    envelope: Parameters<typeof backup.queueEnvelope>[1],
  ) => {
    backup.queueEnvelope(mailboxId, envelope);
  };
  const queueControl = (
    mailboxId: string,
    kind: Exclude<relay.EnvelopeKind, "application">,
    ciphertext: Uint8Array,
    eventId = relay.randomId(),
  ) => {
    queueEnvelope(mailboxId, {
      eventId,
      kind,
      ciphertext,
      epoch: 0,
      nonce: new Uint8Array([0]),
    });
    const circle = listCircles().find((item) => item.mailboxId === mailboxId);
    if (circle) bucket(myOwnEventIds.current, circle.circleId).add(eventId);
    return eventId;
  };

  const { notifyIfBackgrounded, shouldNotifyReaction } = createCircleNotifications({
    getCircle,
    getAppState: () => appStateRef.current,
    afterStateCommit: backup.afterStateCommit,
    showNotification: bridge.showNotification,
    reportFailure,
  });
  const {
    refreshMembers,
    enqueueMembershipChange,
    stageNextMembershipChange,
    refreshConnection,
  } = createMembershipPublication({
    getCircle,
    getDeviceId: () => identity.deviceIdRef.current,
    patchCircle,
    listMembers: (id) => bridge.listMembers(DEVICE_SLOT, id),
    prepareMembershipChange: (id, keyPackage, removals) =>
      bridge.prepareMembershipChange(DEVICE_SLOT, id, keyPackage, removals),
    queueControl,
    queueEnvelope,
    randomId: relay.randomId,
    appendSystem,
    reportFailure,
  });
  const {
    broadcastToCircle,
    notifyNewMembers,
    setNickname,
    setProfilePhoto,
    setCircleName,
  } = createProfileActions({
    getCircle,
    listCircles,
    patchCircle,
    refreshMembers,
    getIdentity: () => identity,
    updateNicknames: identity.updateNicknames,
    updateProfilePhotos: identity.updateProfilePhotos,
    notifyIfBackgrounded,
    appendSystem,
    scheduleBackup: () => {
      void backup.syncBackupNow(DEVICE_SLOT);
    },
  });

  backup.bindRuntime({
    snapshot: () => ({
      timeline: timeline.snapshot(),
      nicknames: identity.nicknamesRef.current,
      profilePhotos: identity.profilePhotosRef.current,
      circles: toBackedUpCircles(circleStore.snapshot()),
    }),
    restore: (snapshot) => {
      timeline.restore(snapshot.timeline);
      restoreCircles(snapshot.circles);
      identity.updateNicknames(() => snapshot.nicknames);
      identity.updateProfilePhotos(() => snapshot.profilePhotos ?? {});
    },
    committed: changes.emit,
    acknowledged: (entry) => {
      if (entry.kind !== "application" || !entry.plaintext) return;
      let payload: AppPayload;
      try {
        payload = JSON.parse(entry.plaintext);
      } catch {
        return;
      }
      timeline.markSent(entry.mailboxId, identity.deviceIdRef.current, payload);
    },
  });

  let initialization: Promise<void> | null = null;
  let loadedDevice: string | null = null;
  const initialize = (): Promise<void> => {
    if (initialization) return initialization;
    initialization = (async () => {
      await identityRuntime.initialize();
      const seed = identity.pendingCircleSeed;
      if (seed !== null || loadedDevice !== identity.deviceId) {
        setCirclesReady(false);
        timeline.restore(identity.pendingTimeline);
        restoreCircles(seed ?? []);
        if (identity.deviceId) {
          await loadLocations(identity.deviceId);
          await Promise.all(
            listCircles()
              .filter((c) => c.role === "member")
              .map((c) => refreshMembers(c.circleId)),
          );
        }
        // Persist the optional setup profile even before the first Circle exists.
        if (identity.deviceId && seed !== null)
          await backup.stateTransaction(async () => {});
        loadedDevice = identity.deviceId;
        identity.clearPendingCircleSeed();
      }
      setCirclesReady(true);
      connectionMonitor.start();
    })().finally(() => {
      initialization = null;
    });
    return initialization;
  };

  // Every trigger reads current refs; mailbox cursors remain durable and
  // each Circle's membership controls are applied in relay sequence order.
  const coordinator = new SyncCoordinator(async () => {
    await initialize();
    if (!identity.deviceId)
      throw new Error("Open Family Circle to restore your identity before syncing.");
    await pollAll();
    try {
      await connectionMonitor.configureBackgroundConnection();
    } catch (error) {
      reportFailure("Background subscription", error);
    }
    try {
      await synchronizeLocations();
      locationChanges.emit();
    } catch {
      locationChanges.emit();
      throw new Error("Location sync is waiting for a connection.");
    }
  });

  const connectionMonitor = createConnectionMonitor(
    {
      getDeviceId: () => identity.deviceId,
      listCircles,
      initialize,
      synchronize: () => coordinator.request(),
      setRelayStatus,
      setNotice,
      onAppStateChange: (state) => {
        appStateRef.current = state;
      },
    },
    connectionEnvironment,
  );

  const { removeMember, eraseCircle, deleteCircle, leaveCircle, transferAdmin } =
    createMembershipActions({
      getCircle,
      patchCircle,
      enqueueMembershipChange,
      appendSystem,
      identity,
      timeline,
      forgetCircle,
      changes,
      setNotice,
      broadcastToCircle,
    });

  const {
    createCircle,
    regenerateInvite,
    joinCircle,
    requestRejoin,
    approveRejoinRequest,
    approveJoinRequest,
  } = createInvitationActions({
    checkpoints,
    identity,
    freshInvite,
    putCircle,
    refreshMembers,
    appendSystem,
    setNotice,
    getCircle,
    patchCircle,
    eraseCircle,
    queueControl,
    forgetCircle,
    enqueueMembershipChange,
  });

  const { sendMessage, changeMessage, reactToMessage } = createMessageActions({
    getCircle,
    timeline,
    patchCircle,
    identity,
    appendSystem,
    broadcastToCircle,
  });

  const { handleApplication } = createApplicationHandler({
    timeline,
    identity,
    broadcastToCircle,
    appendSystem,
    patchCircle,
    shouldNotifyReaction,
    notifyIfBackgrounded,
    getCircle,
  });

  const { handleControl } = createControlHandler({
    checkpoints,
    appendSystem,
    identity,
    patchCircle,
    enqueueMembershipChange,
    refreshMembers,
    broadcastToCircle,
    setNotice,
    forgetCircle,
    notifyIfBackgrounded,
    notifyNewMembers,
  });

  const { pollAll } = createCircleSync({
    lastSeenSequenceId,
    myOwnEventIds,
    listCircles,
    getCircle,
    patchCircle,
    identity,
    appendSystem,
    handleControl,
    handleApplication,
    awaitingRejoinWelcome,
    eraseCircle,
    putCircle,
    getNotice: () => notice,
    setNotice,
    queueControl,
    enqueueMembershipChange,
    stageNextMembershipChange,
    queueEnvelope,
  });

  const setNotifications = async (
    circleId: string,
    preferences: backup.CircleNotifications,
  ) => {
    if (!getCircle(circleId)) return;
    if (
      ![preferences.quietStart, preferences.quietEnd].every((time) =>
        /^([01]\d|2[0-3]):[0-5]\d$/.test(time),
      ) ||
      preferences.quietStart === preferences.quietEnd
    ) {
      throw new Error(
        "Use different start and end times in 24-hour format, such as 22:00 and 08:00.",
      );
    }
    patchCircle(circleId, { notifications: { ...defaultNotifications, ...preferences } });
  };
  const dismissDeparture = async (circleId: string) => {
    if (getCircle(circleId)?.departureConfirmedAt) forgetCircle(circleId);
  };

  const durableAction =
    <A extends unknown[], R>(action: (...args: A) => Promise<R>, fallback: R) =>
    async (...args: A): Promise<R> => {
      try {
        await initialize();
        const result = await backup.stateTransaction(() => action(...args));
        void pollAll().catch(() =>
          setNotice("Your message is saved on this phone and is waiting to send."),
        );

        return result;
      } catch (error) {
        setNotice(
          `The change could not be saved. Please try again. ${describeError(error)}`,
        );
        return fallback;
      }
    };

  // Map focus effects depend on this callback. A new function after every
  // checkpoint restarts those effects and perpetually queues another sync.
  const pollNow = () => coordinator.request();
  const getValue = (): CirclesContextValue => ({
    pollNow,
    circlesReady: circlesReady && identity.pendingCircleSeed === null,
    circles: Object.fromEntries(
      Object.entries(circleStore.snapshot()).map(([id, circle]) => [
        id,
        {
          ...circle,
          pendingSends:
            backup.pendingMessageCount(circle.mailboxId) +
            (circle.pendingChats?.length ?? 0),
        },
      ]),
    ),
    timeline: timeline.snapshot(),
    notice,
    relayStatus,
    clearNotice: () => setNotice(null),
    createCircle: durableAction(createCircle, null),
    joinCircle: durableAction(joinCircle, false),
    refreshConnection: async (id) => {
      await pollAll();
      await durableAction(refreshConnection, undefined)(id);
    },
    regenerateInvite: durableAction(regenerateInvite, undefined),
    sendAttachment: durableAction(
      async (id: string, attachment: ChatAttachment, replyToItemId?: string) =>
        validAttachment(attachment)
          ? sendMessage(
              id,
              attachmentLabel(attachment),
              undefined,
              replyToItemId,
              attachment,
            )
          : false,
      false,
    ),
    sendVoiceMessage: durableAction(
      async (id: string, voice: VoiceMessage, replyToItemId?: string) =>
        validVoiceMessage(voice)
          ? sendMessage(id, voiceLabel(voice), voice, replyToItemId)
          : false,
      false,
    ),
    sendMessage: durableAction(
      (id: string, text: string, replyToItemId?: string) =>
        sendMessage(id, text, undefined, replyToItemId),
      false,
    ),
    editMessage: durableAction(
      (circleId: string, itemId: string, text: string) =>
        changeMessage(circleId, itemId, text),
      false,
    ),
    deleteMessage: durableAction(
      (circleId: string, itemId: string) => changeMessage(circleId, itemId),
      false,
    ),
    reactToMessage: durableAction(reactToMessage, false),
    removeMember: durableAction(removeMember, undefined),
    leaveCircle: durableAction(leaveCircle, false),
    deleteCircle: durableAction(deleteCircle, false),
    requestRejoin: durableAction(requestRejoin, undefined),
    approveRejoinRequest: durableAction(approveRejoinRequest, undefined),
    approveJoinRequest: durableAction(approveJoinRequest, undefined),
    setProfilePhoto: durableAction(setProfilePhoto, false),
    setNickname: durableAction(setNickname, undefined),
    setCircleName: durableAction(setCircleName, undefined),
    setNotifications: durableAction(setNotifications, undefined),
    transferAdmin: durableAction(transferAdmin, undefined),
    dismissDeparture: durableAction(dismissDeparture, undefined),
  });
  return { changes, initialize, getValue, synchronize: () => coordinator.request() };
}
export const circlesRuntime = createCirclesRuntime();
