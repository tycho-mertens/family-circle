import {
  ATTACHMENT_CHUNK_LENGTH,
  validAttachment,
  validAttachmentInfo,
  attachmentLabel,
  attachmentPayloads,
  acceptAttachmentChunk,
  type AttachmentInfo,
  type ChatAttachment,
  type AttachmentChunk,
} from "../attachment";
import { applyMessageChange, canChangeMessage, type MessageChange } from "../message-actions";
import { validMessageReply, type MessageReply } from "../message-reply";
import { validVoiceMessage, voiceLabel, type VoiceMessage } from "../voice-message";
import { validProfilePhoto } from "../profile-photo";
import { validReaction } from "../reactions";
import { notificationAllowed, defaultNotifications } from "../notification-preferences";
import { RuntimeChanges, ref } from "./observable";
import { locationChanges } from "./location-events";
import { AppState } from "react-native";
import { installationToken } from "../relay-access";
import Native from "../../modules/family-circle-bridge";
import { SyncCoordinator } from "../sync-coordinator";

import { bytesToBase64, base64ToBytes } from "../base64";
import * as backup from "../backup";
import {
  receiveLocationControl,
  command,
  loadLocations,
  synchronizeLocations,
  type LocationState,
} from "../location";
import * as bridge from "../bridge";
import * as relay from "../relay";
import type { MailboxEnvelope } from "../relay";
import { describeError, identityRuntime, MAX_NICKNAME_LEN } from "./identity";

/** One process-wide engine. UI subscriptions never own its lifetime. */
const DEVICE_SLOT = "device";
const INVITE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REACTION_NOTIFICATION_COOLDOWN_MS = 30 * 1000;
const MAX_REACTION_NOTIFICATION_COOLDOWNS = 512;

const MAX_CIRCLE_NAME_LEN = 60;

export type Role = "joining" | "member" | "removed";

// Chat and profile updates share the encrypted application channel.
type AppPayload =
  | MessageChange
  | AttachmentChunk
  | {
      type: "chat";
      text: string;
      messageId?: string;
      voice?: VoiceMessage;
      attachment?: AttachmentInfo;
      replyTo?: MessageReply;
      sentAt?: number;
    }
  | { type: "reaction"; messageId: string; authorId: string; emoji: string | null }
  | { type: "receipt"; messageId: string; recipientId: string }
  | { type: "admin-transfer"; id: string; adminId: string }
  | { type: "admin-ack"; id: string }
  | { type: "profile-photo"; photo: string | null }
  | { type: "nickname"; nickname: string }
  | { type: "circle-rename"; name: string }
  | { type: "circle-admin"; adminId: string };

interface Invite {
  nonce: string;
  // A separate one-time bearer capability, included only in the QR form of
  // an invitation. It is validated inside the encrypted join request.
  qrNonce?: string;
  expiresAt: number;
  used: boolean;
  adminId?: string;
}

export interface CircleInfo {
  circleId: string;
  mailboxId: string;
  role: Role;
  isCreator: boolean;
  members: string[];
  invite?: Invite; // only meaningful when isCreator
  joinNonce?: string; // only meaningful when role === "joining" (this device's own request)
  joinRequestedAt?: number; // only meaningful when role === "joining"
  // device_ids of pending "Request to Rejoin" asks — only meaningful when
  // isCreator (only the creator can approve one).
  pendingRejoinRequests?: string[];
  // Opaque request IDs for encrypted new-member requests. Manual-code
  // requests need approval; QR-capability requests are admitted directly.
  // Associated KeyPackages stay in encrypted local state, not relay-visible
  // metadata.
  pendingJoinRequests?: string[];
  // The joining phone's self-reported name. Helps a human recognize the
  // request they are approving; it is not authenticated.
  pendingJoinRequestNames?: Record<string, string>;
  pendingJoinRequestMemberIds?: Record<string, string>;
  // Devices explicitly removed by the admin cannot use a later invite to
  // return automatically. Their next request is held for explicit approval.
  blockedAutoJoinIds?: string[];
  // Group display name, set by the creator. Absent until someone sets one.
  circleName?: string;
  recoveryRequired?: boolean;
  syncError?: string;
  pendingSends?: number;
  pendingChats?: backup.BackedUpCircle["pendingChats"];
  pendingBroadcasts?: string[];
  membershipChanges?: backup.MembershipChange[];
  pendingCommitEventId?: string;
  adminId?: string;
  authorityAdminId?: string;
  membershipAuthority?: "v1";
  deleting?: boolean;
  leaveEpoch?: number;
  departingMembers?: string[];
  notifications?: backup.CircleNotifications;
  lastSuccessfulSync?: number;
  departureConfirmedAt?: number;
  awaitingAdminAnnouncement?: boolean;
  handover?: backup.BackedUpCircle["handover"];
}

export type TimelineItem = backup.SavedChatItem;

export const shortId = (id: string) => id.slice(0, 6);

/** Display the Circle name, falling back to a short ID. */
export const circleLabel = (c: Pick<CircleInfo, "circleId" | "circleName">) =>
  c.circleName ?? shortId(c.circleId);

/**
 * Use the supplied nickname map so UI and background callers can pass current state.
 * Full device IDs remain available in member settings for verification.
 */
export const displayMember = (id: string, nicknameMap: Record<string, string>) =>
  nicknameMap[id] ?? `Member ${shortId(id.replace(/^device-/, ""))}`;

export interface CirclesContextValue {
  pollNow: () => Promise<void>;
  circlesReady: boolean;
  circles: Record<string, CircleInfo>;
  timeline: TimelineItem[];
  notice: string | null;
  relayStatus: "checking" | "connected" | "unreachable";
  clearNotice: () => void;

  createCircle: () => Promise<string | null>;
  joinCircle: (pairingCode: string) => Promise<boolean>;
  regenerateInvite: (circleId: string) => Promise<void>;
  sendAttachment: (
    circleId: string,
    attachment: ChatAttachment,
    replyToItemId?: string,
  ) => Promise<boolean>;
  sendVoiceMessage: (
    circleId: string,
    voice: VoiceMessage,
    replyToItemId?: string,
  ) => Promise<boolean>;
  sendMessage: (circleId: string, text: string, replyToItemId?: string) => Promise<boolean>;
  editMessage: (circleId: string, itemId: string, text: string) => Promise<boolean>;
  deleteMessage: (circleId: string, itemId: string) => Promise<boolean>;
  reactToMessage: (circleId: string, itemId: string, emoji: string | null) => Promise<boolean>;
  removeMember: (circleId: string, memberId: string) => Promise<void>;
  leaveCircle: (circleId: string) => Promise<boolean>;
  deleteCircle: (circleId: string) => Promise<boolean>;
  requestRejoin: (circleId: string, pairingCode: string) => Promise<void>;
  approveRejoinRequest: (circleId: string, requesterId: string) => Promise<void>;
  approveJoinRequest: (circleId: string, requestId: string) => Promise<void>;
  refreshConnection: (circleId: string) => Promise<void>;
  setNickname: (nickname: string) => Promise<void>;
  setProfilePhoto: (photo: string | null) => Promise<boolean>;
  setCircleName: (circleId: string, name: string) => Promise<void>;
  setNotifications: (circleId: string, preferences: backup.CircleNotifications) => Promise<void>;
  transferAdmin: (circleId: string, memberId: string) => Promise<void>;
  dismissDeparture: (circleId: string) => Promise<void>;
}

const isExpectedEcho = (error: string) =>
  /CryptoCoreException\$(AlreadyProcessed|OwnMessage):/.test(error);

function createCirclesRuntime() {
  const identity = identityRuntime.value;
  const changes = new RuntimeChanges();
  let circles: Record<string, CircleInfo> = {};
  const setCircles = (value: Record<string, CircleInfo>) => {
    circles = value;
    changes.emit();
  };
  let timeline: TimelineItem[] = [];
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

  const circlesRef = ref<Record<string, CircleInfo>>({});
  const updateCircles = (
    updater: (prev: Record<string, CircleInfo>) => Record<string, CircleInfo>,
  ) => {
    const next = updater(circlesRef.current);
    circlesRef.current = next;
    setCircles(next);
  };

  const appStateRef = ref(AppState.currentState);
  let backgroundRestartNoticeShown = false;

  // Per-circle polling bookkeeping that doesn't need to drive re-renders.
  const lastSeenSequenceId = ref<Map<string, number>>(new Map());
  const myOwnEventIds = ref<Map<string, Set<string>>>(new Map());
  const processedKeyPackageIds = ref<Map<string, Set<string>>>(new Map());
  const triedWelcomeIds = ref<Map<string, Set<string>>>(new Map());
  const processedLeaveIds = ref<Map<string, Set<string>>>(new Map());
  const processedRejoinRequestIds = ref<Map<string, Set<string>>>(new Map());
  const pendingRejoinKeyPackages = ref<Map<string, Map<string, Uint8Array>>>(new Map());
  const pendingJoinKeyPackages = ref<Map<string, Map<string, Uint8Array>>>(new Map());
  const awaitingRejoinWelcome = ref<Set<string>>(new Set());
  const awaitingRejoinNonce = ref<Map<string, string>>(new Map());
  // Cooldowns can reset on restart. Bound the map so unique message IDs
  // cannot cause unbounded memory growth.
  const reactionNotificationCooldowns = ref<Map<string, number>>(new Map());
  // Timeline IDs increase for the lifetime of this runtime.
  const timelineSeqRef = ref(0);
  const nextTimelineId = () => `t${timelineSeqRef.current++}`;

  function bucket(map: Map<string, Set<string>>, circleId: string): Set<string> {
    let set = map.get(circleId);
    if (!set) {
      set = new Set();
      map.set(circleId, set);
    }
    return set;
  }

  const appendSystem = (circleId: string, text: string) => {
    if (circlesRef.current[circleId]?.deleting) return;
    const item: TimelineItem = {
      id: nextTimelineId(),
      circleId,
      kind: "system",
      text,
      at: Date.now(),
    };
    timeline = [...timeline, item];
    backup.afterStateCommit(changes.emit);
  };
  const appendChat = (
    circleId: string,
    senderId: string,
    text: string,
    messageId?: string,
    own = false,
    voice?: VoiceMessage,
    replyTo?: MessageReply,
    sentAt?: number,
    attachment?: ChatAttachment,
  ) => {
    if (circlesRef.current[circleId]?.deleting) return;
    if (
      messageId &&
      timeline.some(
        (item) =>
          item.circleId === circleId && item.senderId === senderId && item.messageId === messageId,
      )
    )
      return false;
    const item: TimelineItem = {
      id: nextTimelineId(),
      circleId,
      kind: "chat",
      text,
      ...(attachment ? { attachment } : {}),
      ...(voice ? { voice } : {}),
      ...(replyTo ? { replyTo } : {}),
      senderId,
      at: Date.now(),
      ...(sentAt !== undefined ? { sentAt } : {}),
      ...(messageId ? { messageId } : {}),
      ...(own
        ? {
            delivery: "waiting" as const,
            recipients: circlesRef.current[circleId].members.filter((id) => id !== senderId),
            deliveredTo: [],
          }
        : {}),
    };
    timeline = [...timeline, item];
    backup.afterStateCommit(changes.emit);
    return true;
  };

  const patchCircle = (circleId: string, patch: Partial<CircleInfo>) =>
    updateCircles((prev) => ({ ...prev, [circleId]: { ...prev[circleId], ...patch } }));

  // Clear rejected or expired joins so a fresh invitation can be used.
  const forgetCircle = (circleId: string) => {
    updateCircles((prev) => {
      const next = { ...prev };
      delete next[circleId];
      return next;
    });
    lastSeenSequenceId.current.delete(circleId);
    myOwnEventIds.current.delete(circleId);
    processedKeyPackageIds.current.delete(circleId);
    triedWelcomeIds.current.delete(circleId);
    processedLeaveIds.current.delete(circleId);
    processedRejoinRequestIds.current.delete(circleId);
    pendingRejoinKeyPackages.current.delete(circleId);
    pendingJoinKeyPackages.current.delete(circleId);
    awaitingRejoinWelcome.current.delete(circleId);
    awaitingRejoinNonce.current.delete(circleId);
  };

  // Return the refreshed roster so callers can compare it with the previous one.
  const refreshMembers = async (circleId: string): Promise<string[] | null> => {
    try {
      const members = await bridge.listMembers(DEVICE_SLOT, circleId);
      const departingMembers = (circlesRef.current[circleId]?.departingMembers ?? []).filter((id) =>
        members.includes(id),
      );
      const current = circlesRef.current[circleId];
      const previousAdmin =
        current?.adminId ?? (current?.isCreator ? identity.deviceIdRef.current : members[0]);
      const adminId =
        previousAdmin &&
        members.includes(previousAdmin) &&
        !departingMembers.includes(previousAdmin)
          ? previousAdmin
          : (members.find((id) => !departingMembers.includes(id)) ?? members.at(-1));
      const patch: Partial<CircleInfo> = {
        members,
        departingMembers,
        adminId,
        isCreator: adminId === identity.deviceIdRef.current,
      };
      if (current?.handover && !members.includes(current.handover.adminId))
        patch.handover = undefined;
      const me = identity.deviceIdRef.current;
      if (me && !members.includes(me)) {
        patch.role = "removed";
      }
      patchCircle(circleId, patch);
      return members;
    } catch {
      return null; // not fatal — the member list just won't update this tick
    }
  };

  // Invite secrets grant admission, so generate them with the native CSPRNG.
  const freshInvite = async (): Promise<Invite> => {
    const adminId = identity.deviceIdRef.current;
    if (!adminId) throw new Error("Identity is unavailable.");
    const [nonce, qrNonce] = await Promise.all([relay.secureNonce(), relay.secureNonce()]);
    return { nonce, qrNonce, expiresAt: Date.now() + INVITE_TTL_MS, used: false, adminId };
  };

  const notifyIfBackgrounded = (
    circleId: string,
    title: string,
    body: string,
    category: "chat" | "location" | "system" = "system",
  ) => {
    if (category !== "location" && appStateRef.current === "active") return;
    if (!notificationAllowed(circlesRef.current[circleId]?.notifications, category)) return;
    try {
      backup.afterStateCommit(() => bridge.showNotification(title, body));
    } catch {
      // Best-effort — a missed notification isn't fatal, the timeline is
      // still correct next time the app is opened.
    }
  };

  const shouldNotifyReaction = (circleId: string, messageId: string, reactorId: string) => {
    const now = Date.now();
    const cooldowns = reactionNotificationCooldowns.current;
    for (const [key, at] of cooldowns) {
      if (now - at >= REACTION_NOTIFICATION_COOLDOWN_MS) cooldowns.delete(key);
    }
    const key = `${circleId}\u0000${messageId}\u0000${reactorId}`;
    const previous = cooldowns.get(key);
    if (previous !== undefined && now - previous < REACTION_NOTIFICATION_COOLDOWN_MS) return false;
    if (cooldowns.size >= MAX_REACTION_NOTIFICATION_COOLDOWNS)
      cooldowns.delete(cooldowns.keys().next().value!);
    cooldowns.set(key, now);
    return true;
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
    queueEnvelope(mailboxId, { eventId, kind, ciphertext, epoch: 0, nonce: new Uint8Array([0]) });
    const circle = Object.values(circlesRef.current).find((item) => item.mailboxId === mailboxId);
    if (circle) bucket(myOwnEventIds.current, circle.circleId).add(eventId);
    return eventId;
  };

  const enqueueMembershipChange = (circleId: string, change: backup.MembershipChange) => {
    const current = circlesRef.current[circleId];
    const changes = current.membershipChanges ?? [];
    if (!changes.some((item) => JSON.stringify(item) === JSON.stringify(change))) {
      patchCircle(circleId, { membershipChanges: [...changes, change] });
    }
  };

  const stageNextMembershipChange = async (circleId: string) => {
    const current = circlesRef.current[circleId];
    const changes = [...(current.membershipChanges ?? [])];
    // A second approved removal may already have been fulfilled by a leave.
    while (changes[0]?.type === "remove" && !current.members.includes(changes[0].memberId))
      changes.shift();
    const change = changes.shift();
    if (!change) {
      patchCircle(circleId, { membershipChanges: [] });
      return;
    }
    const keyPackage =
      change.type === "add" || change.type === "rejoin"
        ? base64ToBytes(change.keyPackage)
        : new Uint8Array();
    const removals =
      (change.type === "remove" || change.type === "rejoin") &&
      current.members.includes(change.memberId)
        ? [change.memberId]
        : [];
    const prepared = await bridge.prepareMembershipChange(
      DEVICE_SLOT,
      circleId,
      keyPackage,
      removals,
    );
    const eventId = queueControl(current.mailboxId, "commit", prepared.commitBytes);
    if (prepared.welcomeBytes) {
      queueEnvelope(current.mailboxId, {
        eventId: relay.randomId(),
        kind: "welcome",
        epoch: 0,
        nonce: new Uint8Array([0]),
        ciphertext: prepared.welcomeBytes,
        commitEventId: eventId,
      });
    }
    patchCircle(circleId, { membershipChanges: changes, pendingCommitEventId: eventId });
  };

  // Save profile broadcasts with other pending application payloads. They
  // wait for catch-up and any staged membership publication before encryption.
  const broadcastToCircle = async (circleId: string, payload: AppPayload) => {
    const circle = circlesRef.current[circleId];
    if (!circle || circle.deleting || circle.role !== "member") return;
    if (
      (circle.recoveryRequired || circle.syncError) &&
      payload.type !== "receipt" &&
      payload.type !== "admin-ack"
    )
      return;
    patchCircle(circleId, {
      pendingBroadcasts: [...(circle.pendingBroadcasts ?? []), JSON.stringify(payload)],
    });
  };

  const broadcastNicknameToAllCircles = async (nickname: string) => {
    for (const circle of Object.values(circlesRef.current)) {
      await broadcastToCircle(circle.circleId, { type: "nickname", nickname });
    }
  };

  // New members cannot decrypt earlier messages. Re-broadcast our profile
  // and, for the admin, Circle metadata before notifying about the join.
  const notifyNewMembers = async (circleId: string, previousMembers: string[]) => {
    const after = await refreshMembers(circleId);
    if (!after) return;
    const newcomers = after.filter((id) => !previousMembers.includes(id));
    if (newcomers.length === 0) return;

    const current = circlesRef.current[circleId];
    const me = identity.deviceIdRef.current;
    const myNickname = me ? identity.nicknamesRef.current[me] : undefined;
    if (myNickname) {
      await broadcastToCircle(circleId, { type: "nickname", nickname: myNickname });
    }
    if (me)
      await broadcastToCircle(circleId, {
        type: "profile-photo",
        photo: identity.profilePhotosRef.current[me] ?? null,
      });
    if (current?.isCreator)
      await broadcastToCircle(circleId, { type: "circle-admin", adminId: me! });
    if (current?.isCreator && current.circleName) {
      await broadcastToCircle(circleId, { type: "circle-rename", name: current.circleName });
    }

    notifyIfBackgrounded(
      circleId,
      `New member in ${current ? circleLabel(current) : shortId(circleId)}`,
      newcomers.length === 1
        ? `${displayMember(newcomers[0], identity.nicknamesRef.current)} joined`
        : `${newcomers.length} new members joined`,
    );
  };

  // Include app metadata and durable cursors alongside the MLS backup.
  const toBackedUpCircles = (all: Record<string, CircleInfo>): backup.BackedUpCircle[] =>
    Object.values(all).map((c) => ({
      circleId: c.circleId,
      mailboxId: c.mailboxId,
      isCreator: c.isCreator,
      invite: c.invite,
      circleName: c.circleName,
      lastSeenSequenceId: lastSeenSequenceId.current.get(c.circleId),
      pendingChats: c.pendingChats,
      members: c.members,
      notifications: c.notifications,
      lastSuccessfulSync: c.lastSuccessfulSync,
      departureConfirmedAt: c.departureConfirmedAt,
      handover: c.handover,
      awaitingAdminAnnouncement: c.awaitingAdminAnnouncement,
      pendingBroadcasts: c.pendingBroadcasts,
      membershipChanges: c.membershipChanges,
      pendingCommitEventId: c.pendingCommitEventId,
      adminId: c.adminId,
      authorityAdminId: c.authorityAdminId,
      membershipAuthority: c.membershipAuthority,
      deleting: c.deleting,
      leaveEpoch: c.leaveEpoch,
      departingMembers: c.departingMembers,
      role: c.role,
      joinNonce: c.joinNonce,
      joinRequestedAt: c.joinRequestedAt,
      recoveryRequired: c.recoveryRequired,
      syncError: c.syncError,
      ownEventIds: [...bucket(myOwnEventIds.current, c.circleId)],
      processedKeyPackageIds: [...bucket(processedKeyPackageIds.current, c.circleId)],
      triedWelcomeIds: [...bucket(triedWelcomeIds.current, c.circleId)],
      processedLeaveIds: [...bucket(processedLeaveIds.current, c.circleId)],
      processedRejoinRequestIds: [...bucket(processedRejoinRequestIds.current, c.circleId)],
      pendingRejoinKeyPackages: [...(pendingRejoinKeyPackages.current.get(c.circleId) ?? [])].map(
        ([id, bytes]): [string, string] => [id, bytesToBase64(bytes)],
      ),
      pendingJoinKeyPackages: [...(pendingJoinKeyPackages.current.get(c.circleId) ?? [])].map(
        ([id, bytes]): [string, string] => [id, bytesToBase64(bytes)],
      ),
      pendingJoinRequestNames: Object.entries(c.pendingJoinRequestNames ?? {}),
      pendingJoinRequestMemberIds: Object.entries(c.pendingJoinRequestMemberIds ?? {}),
      blockedAutoJoinIds: c.blockedAutoJoinIds,
      awaitingRejoinNonce: awaitingRejoinNonce.current.get(c.circleId),
    }));
  const restoreCircles = (seed: backup.BackedUpCircle[]) => {
    const restored: Record<string, CircleInfo> = {};
    for (const map of [
      lastSeenSequenceId,
      myOwnEventIds,
      processedKeyPackageIds,
      triedWelcomeIds,
      processedLeaveIds,
      processedRejoinRequestIds,
      pendingRejoinKeyPackages,
      pendingJoinKeyPackages,
      awaitingRejoinNonce,
    ])
      map.current.clear();
    awaitingRejoinWelcome.current.clear();
    for (const c of seed) {
      restored[c.circleId] = {
        ...c,
        role: c.role ?? "member",
        members: c.members ?? circlesRef.current[c.circleId]?.members ?? [],
        pendingRejoinRequests: (c.pendingRejoinKeyPackages ?? []).map(([id]) => id),
        pendingJoinRequests: (c.pendingJoinKeyPackages ?? []).map(([id]) => id),
        pendingJoinRequestNames: Object.fromEntries(c.pendingJoinRequestNames ?? []),
        pendingJoinRequestMemberIds: Object.fromEntries(c.pendingJoinRequestMemberIds ?? []),
      };
      lastSeenSequenceId.current.set(c.circleId, c.lastSeenSequenceId ?? 0);
      myOwnEventIds.current.set(c.circleId, new Set(c.ownEventIds));
      processedKeyPackageIds.current.set(c.circleId, new Set(c.processedKeyPackageIds));
      triedWelcomeIds.current.set(c.circleId, new Set(c.triedWelcomeIds));
      processedLeaveIds.current.set(c.circleId, new Set(c.processedLeaveIds));
      processedRejoinRequestIds.current.set(c.circleId, new Set(c.processedRejoinRequestIds));
      pendingRejoinKeyPackages.current.set(
        c.circleId,
        new Map(
          (c.pendingRejoinKeyPackages ?? []).map(([id, bytes]) => [id, base64ToBytes(bytes)]),
        ),
      );
      pendingJoinKeyPackages.current.set(
        c.circleId,
        new Map((c.pendingJoinKeyPackages ?? []).map(([id, bytes]) => [id, base64ToBytes(bytes)])),
      );
      if (c.awaitingRejoinNonce) {
        awaitingRejoinNonce.current.set(c.circleId, c.awaitingRejoinNonce);
        awaitingRejoinWelcome.current.add(c.circleId);
      }
    }
    updateCircles(() => restored);
  };
  const restoreTimeline = (saved: TimelineItem[] = []) => {
    timeline = saved;
    timelineSeqRef.current = saved.reduce((next, item) => {
      const sequence = /^t(\d+)$/.exec(item.id);
      return sequence ? Math.max(next, Number(sequence[1]) + 1) : next;
    }, 0);
  };
  backup.registerSnapshotProvider(
    () => ({
      timeline,
      nicknames: identity.nicknamesRef.current,
      profilePhotos: identity.profilePhotosRef.current,
      circles: toBackedUpCircles(circlesRef.current),
    }),
    (snapshot) => {
      restoreTimeline(snapshot.timeline);
      restoreCircles(snapshot.circles);
      identity.updateNicknames(() => snapshot.nicknames);
      identity.updateProfilePhotos(() => snapshot.profilePhotos ?? {});
    },
  );
  backup.onStateCommitted(changes.emit);

  let initialization: Promise<void> | null = null;
  let loadedDevice: string | null = null;
  const initialize = (): Promise<void> => {
    if (initialization) return initialization;
    initialization = (async () => {
      await identityRuntime.initialize();
      const seed = identity.pendingCircleSeed;
      if (seed !== null || loadedDevice !== identity.deviceId) {
        setCirclesReady(false);
        restoreTimeline(identity.pendingTimeline);
        restoreCircles(seed ?? []);
        if (identity.deviceId) {
          await loadLocations(identity.deviceId);
          await Promise.all(
            Object.values(circlesRef.current)
              .filter((c) => c.role === "member")
              .map((c) => refreshMembers(c.circleId)),
          );
        }
        // Persist the optional setup profile even before the first Circle exists.
        if (identity.deviceId && seed !== null) await backup.stateTransaction(async () => {});
        loadedDevice = identity.deviceId;
        identity.clearPendingCircleSeed();
      }
      setCirclesReady(true);
      startForegroundChecks();
    })().finally(() => {
      initialization = null;
    });
    return initialization;
  };

  // Every trigger reads current refs; mailbox cursors remain durable and
  // each Circle's membership controls are applied in relay sequence order.
  const pollCircle = async (circle: CircleInfo) => {
    const { circleId, mailboxId } = circle;
    if (circle.departureConfirmedAt) return;

    let envelopes: MailboxEnvelope[];
    try {
      envelopes = await relay.fetchEnvelopes(
        mailboxId,
        lastSeenSequenceId.current.get(circleId) ?? 0,
      );
    } catch {
      return; // relay hiccup; try again next tick
    }

    for (const envelope of envelopes.sort((a, b) => a.sequenceId - b.sequenceId)) {
      try {
        await backup.stateTransaction(async () => {
          if (envelope.sequenceId <= (lastSeenSequenceId.current.get(circleId) ?? 0)) return;
          if (
            envelope.kind !== "commit" &&
            bucket(myOwnEventIds.current, circleId).has(envelope.eventId)
          ) {
            const handover = circlesRef.current[circleId]?.handover;
            if (handover?.eventId === envelope.eventId) {
              patchCircle(circleId, {
                adminId: handover.adminId,
                isCreator: handover.adminId === identity.deviceIdRef.current,
              });
              appendSystem(
                circleId,
                `${displayMember(handover.adminId, identity.nicknamesRef.current)} is now the admin`,
              );
            }
            lastSeenSequenceId.current.set(circleId, envelope.sequenceId);
            return;
          }
          // Re-read current role/isCreator/invite each iteration — they can
          // change mid-poll (e.g. a join lands partway through a batch).
          const current = circlesRef.current[circleId];
          if (!current) return;

          try {
            if (envelope.kind === "keypackage") {
              if (
                current.isCreator &&
                current.role === "member" &&
                !bucket(processedKeyPackageIds.current, circleId).has(envelope.eventId)
              ) {
                bucket(processedKeyPackageIds.current, circleId).add(envelope.eventId);
                const invite = current.invite;
                if (!invite || invite.used || Date.now() >= invite.expiresAt) {
                  appendSystem(
                    circleId,
                    "Ignored a join request because there is no active invite.",
                  );
                } else {
                  // The pairing secret is inside this AEAD-protected payload,
                  // never the event ID. A mailbox observer can replay this
                  // exact request but cannot substitute their own KeyPackage.
                  try {
                    const plaintext = await bridge.openInviteRequest(
                      invite.nonce,
                      circleId,
                      mailboxId,
                      "join",
                      envelope.ciphertext,
                    );
                    // Older clients sealed the KeyPackage directly. Newer
                    // ones use a small encrypted envelope so manual requests
                    // can show a human-readable name and QR requests can
                    // prove possession of their QR-only one-time capability.
                    let keyPackage = plaintext;
                    let requestName = "Someone";
                    let qrCapability: string | undefined;
                    try {
                      const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
                        keyPackage?: unknown;
                        name?: unknown;
                        qrCapability?: unknown;
                      };
                      if (typeof payload.keyPackage === "string") {
                        keyPackage = base64ToBytes(payload.keyPackage);
                        if (!keyPackage.length) throw new Error("Empty KeyPackage");
                        if (typeof payload.name === "string") {
                          const candidate = payload.name
                            .trim()
                            .replace(/\s+/g, " ")
                            .slice(0, MAX_NICKNAME_LEN);
                          if (candidate) requestName = candidate;
                        }
                        if (typeof payload.qrCapability === "string")
                          qrCapability = payload.qrCapability;
                      }
                    } catch {
                      // Direct KeyPackages from an older app stay compatible.
                    }
                    let requests = pendingJoinKeyPackages.current.get(circleId);
                    if (!requests) {
                      requests = new Map();
                      pendingJoinKeyPackages.current.set(circleId, requests);
                    }
                    requests.set(envelope.eventId, keyPackage);
                    const requesterId = await bridge.keyPackageIdentity(DEVICE_SLOT, keyPackage);
                    if (requesterId === identity.deviceIdRef.current)
                      throw new Error("Own KeyPackage");
                    const blocked = current.blockedAutoJoinIds?.includes(requesterId);
                    if (!blocked) {
                      // Every valid invitation is now a short-lived,
                      // single-use admission capability. The requester ID is
                      // read from the signed MLS KeyPackage above, so a
                      // removed device cannot evade the block by claiming a
                      // different name in its encrypted request payload.
                      pendingJoinKeyPackages.current.delete(circleId);
                      patchCircle(circleId, {
                        invite: { ...invite, used: true },
                        pendingJoinRequests: [],
                        pendingJoinRequestNames: {},
                        pendingJoinRequestMemberIds: {},
                      });
                      enqueueMembershipChange(circleId, {
                        type: "add",
                        keyPackage: bytesToBase64(keyPackage),
                      });
                      appendSystem(
                        circleId,
                        "A new member is joining — waiting for the membership update to be confirmed.",
                      );
                    } else {
                      const pending = current.pendingJoinRequests ?? [];
                      if (!pending.includes(envelope.eventId)) {
                        const label = identity.nicknamesRef.current[requesterId] ?? requestName;
                        patchCircle(circleId, {
                          pendingJoinRequests: [...pending, envelope.eventId],
                          pendingJoinRequestNames: {
                            ...(current.pendingJoinRequestNames ?? {}),
                            [envelope.eventId]: label,
                          },
                          pendingJoinRequestMemberIds: {
                            ...(current.pendingJoinRequestMemberIds ?? {}),
                            [envelope.eventId]: requesterId,
                          },
                        });
                        appendSystem(
                          circleId,
                          `${label} was previously removed and is requesting to rejoin.`,
                        );
                      }
                    }
                  } catch {
                    // Invalid, stale and injected requests all look alike
                    // from outside and reveal nothing.
                  }
                }
              }
            } else if (envelope.kind === "welcome") {
              // A rejoining device may still have a member or removed role locally.
              // Only a Welcome encrypted for this device can be opened.
              if (
                (current.role === "joining" ||
                  current.role === "removed" ||
                  awaitingRejoinWelcome.current.has(circleId)) &&
                !bucket(triedWelcomeIds.current, circleId).has(envelope.eventId)
              ) {
                bucket(triedWelcomeIds.current, circleId).add(envelope.eventId);
                try {
                  if (current.role === "joining" || awaitingRejoinWelcome.current.has(circleId)) {
                    // Drop any stale local group state first — OpenMLS
                    // refuses to build a fresh group from a Welcome while
                    // storage still holds any state for this GroupId. An
                    // ordinary join can also follow removal + cold restart.
                    await bridge.forgetCircle(DEVICE_SLOT, circleId);
                  }
                  const joinedCircleId = current.authorityAdminId
                    ? await bridge.joinFromWelcomeWithAdmin(
                        DEVICE_SLOT,
                        envelope.ciphertext,
                        current.authorityAdminId,
                      )
                    : await bridge.joinFromWelcome(DEVICE_SLOT, envelope.ciphertext);
                  if (joinedCircleId === circleId) {
                    patchCircle(circleId, {
                      role: "member",
                      recoveryRequired: false,
                      syncError: undefined,
                      adminId: current.authorityAdminId ?? current.adminId,
                      authorityAdminId: undefined,
                      membershipAuthority: current.authorityAdminId ? "v1" : undefined,
                      awaitingAdminAnnouncement: !current.authorityAdminId,
                    });
                    awaitingRejoinWelcome.current.delete(circleId);
                    awaitingRejoinNonce.current.delete(circleId);
                    appendSystem(circleId, "You joined this Circle");
                    await refreshMembers(circleId);
                    // Re-broadcast the saved nickname after joining, including after a restore.
                    const me = identity.deviceIdRef.current;
                    const myNickname = me ? identity.nicknamesRef.current[me] : undefined;
                    if (myNickname) {
                      await broadcastToCircle(circleId, { type: "nickname", nickname: myNickname });
                    }
                    if (me)
                      await broadcastToCircle(circleId, {
                        type: "profile-photo",
                        photo: identity.profilePhotosRef.current[me] ?? null,
                      });
                    // This device just gained a whole new Circle to back up.
                  }
                } catch {
                  // Not our Welcome (HPKE-encrypted to someone else's key) —
                  // expected and harmless, just keep waiting.
                }
              }
            } else if (envelope.kind === "join-rejected") {
              if (current.role === "joining" && current.joinNonce) {
                const rejectedNonce = relay.parseInviteNonce(envelope.eventId);
                if (rejectedNonce === current.joinNonce) {
                  setNotice(
                    "Your join request was rejected (invite already used, expired, or invalid).",
                  );
                  forgetCircle(circleId);
                }
              } else if (awaitingRejoinNonce.current.get(circleId)) {
                // Keep the Circle after a failed rejoin so the member can retry with a fresh code.
                const rejectedNonce = relay.parseInviteNonce(envelope.eventId);
                if (rejectedNonce === awaitingRejoinNonce.current.get(circleId)) {
                  appendSystem(
                    circleId,
                    "Your request to rejoin was declined (invite code missing, already used, or expired).",
                  );
                  awaitingRejoinNonce.current.delete(circleId);
                  awaitingRejoinWelcome.current.delete(circleId);
                }
              }
            } else if (envelope.kind === "leave") {
              if (
                current.role === "member" &&
                !bucket(processedLeaveIds.current, circleId).has(envelope.eventId)
              ) {
                bucket(processedLeaveIds.current, circleId).add(envelope.eventId);
                const leavingMember = await bridge.processLeave(
                  DEVICE_SLOT,
                  circleId,
                  envelope.ciphertext,
                );
                const departingMembers = [
                  ...new Set([...(current.departingMembers ?? []), leavingMember]),
                ];
                const previousAdmin =
                  current.adminId ??
                  (current.isCreator ? identity.deviceIdRef.current : current.members[0]);
                const successor =
                  previousAdmin && !departingMembers.includes(previousAdmin)
                    ? previousAdmin
                    : (current.members.find((id) => !departingMembers.includes(id)) ??
                      current.members.at(-1));
                patchCircle(circleId, {
                  departingMembers,
                  adminId: successor,
                  isCreator: successor === identity.deviceIdRef.current,
                });
                const body = `${displayMember(leavingMember, identity.nicknamesRef.current)} left the Circle`;
                appendSystem(circleId, body);
                // The departing device ignores its own leave envelope, so this
                // alert is delivered only to the remaining Circle members.
                notifyIfBackgrounded(circleId, `Member left ${circleLabel(current)}`, body);
              }
            } else if (envelope.kind === "commit") {
              if (current.role === "member") {
                await bridge.processCommit(DEVICE_SLOT, circleId, envelope.ciphertext);
                if (!awaitingRejoinWelcome.current.has(circleId))
                  patchCircle(circleId, {
                    recoveryRequired: false,
                    pendingCommitEventId: undefined,
                  });
                appendSystem(circleId, "Membership updated");
                await notifyNewMembers(circleId, current.members);
              }
            } else if (envelope.kind === "rejoin-request") {
              // Rejoins always need admin approval. Do not check invite.used here:
              // multiple requesters may reach the pending list before approval spends the nonce.
              if (
                current.isCreator &&
                current.role === "member" &&
                !bucket(processedRejoinRequestIds.current, circleId).has(envelope.eventId)
              ) {
                bucket(processedRejoinRequestIds.current, circleId).add(envelope.eventId);
                const invite = current.invite;
                if (invite && Date.now() < invite.expiresAt)
                  try {
                    const plaintext = await bridge.openInviteRequest(
                      invite.nonce,
                      circleId,
                      mailboxId,
                      "rejoin",
                      envelope.ciphertext,
                    );
                    const request = JSON.parse(new TextDecoder().decode(plaintext)) as {
                      deviceId?: unknown;
                      keyPackage?: unknown;
                    };
                    if (
                      typeof request.deviceId === "string" &&
                      request.deviceId &&
                      request.deviceId !== identity.deviceIdRef.current &&
                      typeof request.keyPackage === "string"
                    ) {
                      const keyPackage = base64ToBytes(request.keyPackage);
                      let keyPackages = pendingRejoinKeyPackages.current.get(circleId);
                      if (!keyPackages) {
                        keyPackages = new Map();
                        pendingRejoinKeyPackages.current.set(circleId, keyPackages);
                      }
                      keyPackages.set(request.deviceId, keyPackage);
                      const already = current.pendingRejoinRequests ?? [];
                      if (!already.includes(request.deviceId)) {
                        patchCircle(circleId, {
                          pendingRejoinRequests: [...already, request.deviceId],
                        });
                        appendSystem(
                          circleId,
                          `${displayMember(request.deviceId, identity.nicknamesRef.current)} is requesting to rejoin`,
                        );
                      }
                    }
                  } catch {
                    // Invalid/stale encrypted requests reveal no pairing secret.
                  }
              }
            } else if (envelope.kind === "location-control-v1") {
              if (current.role === "member") {
                const sender = await receiveLocationControl(circleId, envelope);
                if (
                  !current.deleting &&
                  sender &&
                  sender !== identity.deviceIdRef.current &&
                  current.members.includes(sender)
                ) {
                  const body = `${displayMember(sender, identity.nicknamesRef.current)} started sharing their location`;
                  appendSystem(circleId, body);
                  notifyIfBackgrounded(
                    circleId,
                    `Location sharing · ${circleLabel(current)}`,
                    body,
                    "location",
                  );
                }
              }
            } else if (envelope.kind === "application") {
              if (current.role === "member") {
                try {
                  const { senderDeviceId, plaintext } = await bridge.decryptEvent(
                    DEVICE_SLOT,
                    circleId,
                    {
                      eventId: envelope.eventId,
                      epoch: envelope.epoch,
                      nonce: envelope.nonce,
                      ciphertext: envelope.ciphertext,
                    },
                  );
                  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as AppPayload;
                  if (payload.type === "attachment-chunk") {
                    const target = timeline.find(
                      (item) =>
                        item.circleId === circleId &&
                        item.senderId === senderDeviceId &&
                        item.messageId === payload.messageId &&
                        !item.deletedAt &&
                        item.attachment,
                    );
                    if (target?.attachment && current.members.includes(senderDeviceId)) {
                      const result = acceptAttachmentChunk(
                        target.attachment,
                        target.attachmentParts ?? {},
                        payload,
                      );
                      if (result) {
                        timeline = timeline.map((item) =>
                          item.id === target.id
                            ? {
                                ...item,
                                attachment: result.attachment,
                                attachmentParts: result.parts,
                              }
                            : item,
                        );
                        backup.afterStateCommit(changes.emit);
                        if (
                          result.attachment.base64 &&
                          senderDeviceId !== identity.deviceIdRef.current
                        )
                          await broadcastToCircle(circleId, {
                            type: "receipt",
                            messageId: payload.messageId,
                            recipientId: senderDeviceId,
                          });
                      }
                    }
                  } else if (payload.type === "message-edit" || payload.type === "message-delete") {
                    if (
                      current.members.includes(senderDeviceId) &&
                      typeof payload.messageId === "string" &&
                      payload.messageId.length <= 128 &&
                      Number.isFinite(payload.at) &&
                      payload.at <= Date.now() + 60_000
                    ) {
                      timeline = timeline.map((item) =>
                        item.circleId === circleId
                          ? applyMessageChange(item, senderDeviceId, payload)
                          : item,
                      );
                      backup.afterStateCommit(changes.emit);
                    }
                  } else if (payload.type === "profile-photo") {
                    if (
                      !current.deleting &&
                      current.members.includes(senderDeviceId) &&
                      validProfilePhoto(payload.photo)
                    ) {
                      identity.updateProfilePhotos((prev) => ({
                        ...prev,
                        [senderDeviceId]: payload.photo,
                      }));
                    }
                  } else if (payload.type === "nickname") {
                    const nickname = payload.nickname.trim().slice(0, MAX_NICKNAME_LEN);
                    if (nickname && nickname !== identity.nicknamesRef.current[senderDeviceId]) {
                      identity.updateNicknames((prev) => ({ ...prev, [senderDeviceId]: nickname }));
                      appendSystem(circleId, `${nickname} updated their name`);
                    }
                  } else if (payload.type === "admin-transfer") {
                    if (
                      senderDeviceId === current.adminId &&
                      typeof payload.id === "string" &&
                      payload.id.length <= 128 &&
                      payload.adminId !== senderDeviceId &&
                      current.members.includes(payload.adminId) &&
                      !(current.departingMembers ?? []).includes(payload.adminId)
                    ) {
                      // The sender identity came from MLS, not payload JSON.
                      // Persist the same transfer in crypto-core before this
                      // device will accept the successor's membership commits.
                      await bridge.adoptMembershipAdmin(
                        DEVICE_SLOT,
                        circleId,
                        senderDeviceId,
                        payload.adminId,
                      );
                      patchCircle(circleId, {
                        adminId: payload.adminId,
                        isCreator: payload.adminId === identity.deviceIdRef.current,
                      });
                      appendSystem(
                        circleId,
                        `${displayMember(payload.adminId, identity.nicknamesRef.current)} is now the admin`,
                      );
                      if (payload.adminId === identity.deviceIdRef.current)
                        await broadcastToCircle(circleId, { type: "admin-ack", id: payload.id });
                    }
                  } else if (payload.type === "admin-ack") {
                    if (
                      current.handover?.id === payload.id &&
                      current.handover.adminId === senderDeviceId &&
                      current.adminId === senderDeviceId
                    ) {
                      patchCircle(circleId, { handover: { ...current.handover, confirmed: true } });
                    }
                  } else if (payload.type === "circle-admin") {
                    // New members bootstrap the app-level admin from an authenticated member announcement.
                    // Established members only accept changes authorized by their current admin.
                    if (
                      payload.adminId === senderDeviceId &&
                      current.members.includes(senderDeviceId) &&
                      (current.awaitingAdminAnnouncement || senderDeviceId === current.adminId)
                    ) {
                      patchCircle(circleId, {
                        adminId: senderDeviceId,
                        isCreator: senderDeviceId === identity.deviceIdRef.current,
                        awaitingAdminAnnouncement: false,
                      });
                    }
                  } else if (payload.type === "reaction") {
                    if (
                      !current.deleting &&
                      current.members.includes(senderDeviceId) &&
                      validReaction(payload.emoji)
                    ) {
                      const target = timeline.find(
                        (item) =>
                          item.kind === "chat" &&
                          item.circleId === circleId &&
                          item.messageId === payload.messageId &&
                          item.senderId === payload.authorId &&
                          !item.deletedAt,
                      );
                      const previous = target?.reactions?.[senderDeviceId];
                      applyReaction(
                        circleId,
                        payload.messageId,
                        payload.authorId,
                        senderDeviceId,
                        payload.emoji,
                      );
                      if (
                        target &&
                        target.senderId === identity.deviceIdRef.current &&
                        senderDeviceId !== identity.deviceIdRef.current &&
                        payload.emoji &&
                        previous !== payload.emoji &&
                        shouldNotifyReaction(circleId, payload.messageId, senderDeviceId)
                      ) {
                        notifyIfBackgrounded(
                          circleId,
                          `Reaction in ${circleLabel(current)}`,
                          `${displayMember(senderDeviceId, identity.nicknamesRef.current)} reacted ${payload.emoji} to your message: ${target.text.slice(0, 100)}`,
                          "chat",
                        );
                      }
                    }
                  } else if (payload.type === "receipt") {
                    if (payload.recipientId === identity.deviceIdRef.current) {
                      timeline = timeline.map((item) =>
                        item.circleId === circleId &&
                        item.senderId === payload.recipientId &&
                        item.messageId === payload.messageId &&
                        item.recipients?.includes(senderDeviceId)
                          ? {
                              ...item,
                              delivery: "delivered",
                              deliveredTo: [
                                ...new Set([...(item.deliveredTo ?? []), senderDeviceId]),
                              ],
                            }
                          : item,
                      );
                      backup.afterStateCommit(changes.emit);
                    }
                  } else if (payload.type === "circle-rename") {
                    // The UI only lets admins rename a Circle, but this receiver
                    // currently accepts renames from any authenticated member.
                    const name = payload.name.trim().slice(0, MAX_CIRCLE_NAME_LEN);
                    if (name && name !== circlesRef.current[circleId]?.circleName) {
                      patchCircle(circleId, { circleName: name });
                      appendSystem(circleId, `Circle renamed to "${name}"`);
                    }
                  } else if (
                    payload.type === "chat" &&
                    typeof payload.text === "string" &&
                    payload.text.length <= 10000 &&
                    (payload.voice === undefined ||
                      (validVoiceMessage(payload.voice) &&
                        current.members.includes(senderDeviceId))) &&
                    (payload.attachment === undefined ||
                      (!payload.voice &&
                        validAttachmentInfo(payload.attachment) &&
                        current.members.includes(senderDeviceId)))
                  ) {
                    const messageId =
                      typeof payload.messageId === "string" && payload.messageId.length <= 128
                        ? payload.messageId
                        : undefined;
                    const messageText = payload.attachment
                      ? attachmentLabel(payload.attachment)
                      : payload.voice
                        ? voiceLabel(payload.voice)
                        : payload.text;
                    const replyTo = validMessageReply(payload.replyTo)
                      ? { messageId: payload.replyTo.messageId, senderId: payload.replyTo.senderId }
                      : undefined;
                    const added = appendChat(
                      circleId,
                      senderDeviceId,
                      messageText,
                      messageId,
                      false,
                      payload.voice,
                      replyTo,
                      typeof payload.sentAt === "number" &&
                        Number.isFinite(payload.sentAt) &&
                        payload.sentAt <= Date.now() + 60_000
                        ? payload.sentAt
                        : undefined,
                      payload.attachment
                        ? {
                            name: payload.attachment.name,
                            mimeType: payload.attachment.mimeType,
                            size: payload.attachment.size,
                            kind: payload.attachment.kind,
                            base64: "",
                          }
                        : undefined,
                    );
                    if (
                      messageId &&
                      !payload.attachment &&
                      senderDeviceId !== identity.deviceIdRef.current
                    ) {
                      await broadcastToCircle(circleId, {
                        type: "receipt",
                        messageId,
                        recipientId: senderDeviceId,
                      });
                    }
                    const label = displayMember(senderDeviceId, identity.nicknamesRef.current);
                    if (added && !current.deleting)
                      notifyIfBackgrounded(
                        circleId,
                        `New message in ${circleLabel(current)}`,
                        `${label}: ${messageText}`,
                        "chat",
                      );
                  }
                } catch (err) {
                  const error = describeError(err);
                  if (!isExpectedEcho(error)) {
                    if (__DEV__) console.info("Circle message could not be opened", error);
                    appendSystem(
                      circleId,
                      error.includes("StaleEpoch")
                        ? "An older message arrived after the Circle's keys changed and could not be opened."
                        : "A message could not be opened. Other messages can still arrive; check Circle settings if this continues.",
                    );
                  }
                }
              }
            }
          } catch (err) {
            const error = describeError(err);
            // Stale controls are historical replay, classified by the MLS
            // header. A rejoin replaces unusable history with its new Welcome.
            if (
              !error.includes("StaleEpoch") &&
              !isExpectedEcho(error) &&
              !awaitingRejoinWelcome.current.has(circleId)
            )
              throw err;
          }
          lastSeenSequenceId.current.set(circleId, envelope.sequenceId);
          if (circlesRef.current[circleId]?.syncError)
            patchCircle(circleId, { syncError: undefined });
        });
      } catch (err) {
        if (__DEV__) console.info(`Circle ${envelope.kind} update failed`, describeError(err));
        await backup.stateTransaction(async () => {
          if (circlesRef.current[circleId] && !circlesRef.current[circleId].syncError) {
            patchCircle(circleId, {
              syncError:
                "A membership update could not be applied. Sending is paused while this Circle reconnects.",
            });
          }
        });
        return; // Retain cursor; do not skip a commit required by later messages.
      }
    }
    if (
      backup.hasRejectedEnvelope(mailboxId) &&
      circlesRef.current[circleId]?.role === "member" &&
      !circlesRef.current[circleId]?.recoveryRequired &&
      !circlesRef.current[circleId]?.syncError
    ) {
      await backup.stateTransaction(async () => {
        const state = await bridge.circlePublicationState(DEVICE_SLOT, circleId);
        await backup.resealRejected(
          mailboxId,
          lastSeenSequenceId.current.get(circleId) ?? 0,
          state.epoch,
          (plaintext) =>
            bridge.encryptEvent(DEVICE_SLOT, circleId, new TextEncoder().encode(plaintext)),
        );
      });
    }
    // Leave requests survive offline deletion and epoch changes. Only erase
    // MLS state after peers confirm removal, or nobody else remains.
    await backup.stateTransaction(async () => {
      const current = circlesRef.current[circleId];
      if (!current) return;
      patchCircle(circleId, { lastSuccessfulSync: Date.now() });
      if (current.deleting) {
        const me = identity.deviceIdRef.current!;
        if (
          current.role === "removed" ||
          (current.role === "member" && current.members.length <= 1)
        ) {
          await eraseCircle(circleId);
          patchCircle(circleId, {
            circleId,
            mailboxId,
            circleName: current.circleName,
            role: "removed",
            isCreator: false,
            members: [],
            deleting: true,
            departureConfirmedAt: Date.now(),
          });
          if (notice?.startsWith("Leaving requested.")) setNotice(null);
          return;
        }
        if (
          current.role === "member" &&
          !current.pendingCommitEventId &&
          !current.recoveryRequired &&
          !current.syncError
        ) {
          const publication = await bridge.circlePublicationState(DEVICE_SLOT, circleId);
          if (!publication.pendingCommit && current.leaveEpoch !== publication.epoch) {
            const proposal = await bridge.proposeLeave(DEVICE_SLOT, circleId);
            const eventId = queueControl(mailboxId, "leave", proposal);
            bucket(myOwnEventIds.current, circleId).add(eventId);
            patchCircle(circleId, { leaveEpoch: publication.epoch });
          }
        }
      }
      if (current.isCreator) {
        for (const memberId of current.departingMembers ?? []) {
          if (memberId !== identity.deviceIdRef.current && current.members.includes(memberId))
            enqueueMembershipChange(circleId, { type: "remove", memberId });
        }
      }
    });

    // Stage at most one membership operation after complete catch-up. The
    // current epoch remains active until its own commit is read in relay order.
    const current = circlesRef.current[circleId];
    if (
      current?.role === "member" &&
      current.isCreator &&
      current.membershipAuthority === "v1" &&
      !current.syncError &&
      !current.pendingCommitEventId &&
      (current.recoveryRequired || current.membershipChanges?.length)
    ) {
      await backup.stateTransaction(async () => {
        const ready = circlesRef.current[circleId];
        if (ready.pendingCommitEventId) return;
        if (ready.recoveryRequired && !ready.membershipChanges?.length)
          enqueueMembershipChange(circleId, { type: "refresh" });
        await stageNextMembershipChange(circleId);
      });
    }
    if (
      circlesRef.current[circleId]?.pendingChats?.length ||
      circlesRef.current[circleId]?.pendingBroadcasts?.length
    )
      await backup.stateTransaction(async () => {
        const ready = circlesRef.current[circleId];
        if (!ready || ready.recoveryRequired || ready.syncError || ready.pendingCommitEventId)
          return;
        if (ready.role !== "member") {
          patchCircle(circleId, { pendingChats: [], pendingBroadcasts: [] });
          appendSystem(
            circleId,
            "Your queued messages were not sent because your membership ended.",
          );
          return;
        }
        const broadcasts = ready.pendingBroadcasts ?? [];
        const isMessageAction = (plaintext: string) =>
          ["reaction", "message-edit", "message-delete"].includes(JSON.parse(plaintext).type);
        // A reaction to our own offline draft must follow the chat it references.
        const payloads = [
          ...broadcasts.filter((p) => !isMessageAction(p)),
          ...(ready.pendingChats ?? []).flatMap((chat) =>
            typeof chat === "string"
              ? [JSON.stringify({ type: "chat", text: chat })]
              : attachmentPayloads(chat),
          ),
          ...broadcasts.filter(isMessageAction),
        ];
        for (const plaintext of payloads) {
          const envelope = await bridge.encryptEvent(
            DEVICE_SLOT,
            circleId,
            new TextEncoder().encode(plaintext),
          );
          bucket(myOwnEventIds.current, circleId).add(envelope.eventId);
          const payload = JSON.parse(plaintext) as AppPayload;
          if (payload.type === "admin-transfer" && ready.handover?.id === payload.id)
            patchCircle(circleId, { handover: { ...ready.handover, eventId: envelope.eventId } });
          queueEnvelope(mailboxId, {
            ...envelope,
            kind: "application",
            plaintext,
            expectedSequenceId: lastSeenSequenceId.current.get(circleId) ?? 0,
          });
        }
        patchCircle(circleId, { pendingChats: [], pendingBroadcasts: [] });
      });
  };

  const pollingCircles = ref(new Map<string, Promise<void>>());
  const pollAll = async () => {
    const tasks: Promise<void>[] = [];
    for (const circle of Object.values(circlesRef.current)) {
      let task = pollingCircles.current.get(circle.circleId);
      if (!task) {
        task = pollCircle(circle)
          .catch((err) => {
            if (__DEV__) console.info("Circle sync deferred", describeError(err));
          })
          .finally(() => pollingCircles.current.delete(circle.circleId));
        pollingCircles.current.set(circle.circleId, task);
      }
      tasks.push(task);
    }
    await Promise.all(tasks);
    await backup.flushOutbox();
    void backup.syncBackupNow(DEVICE_SLOT);
  };

  const configureBackgroundConnection = async () => {
    if (!Native.configureBackgroundNotifications) return;
    const before = Native.backgroundNotificationStatus();
    const mailboxes = Object.values(circlesRef.current)
      .filter((c) => c.role !== "removed")
      .map((c) => c.mailboxId)
      .sort();
    // Clear stale subscriptions even if the server is temporarily unreachable.
    if (!mailboxes.length) {
      Native.configureBackgroundNotifications("", [], "");
      return;
    }
    const capabilities = await relay.relayCapabilities();
    const url = capabilities.syncHub
      ? (process.env.EXPO_PUBLIC_RELAY_URL ?? "").replace(/\/$/, "") + capabilities.syncHub
      : "";
    Native.configureBackgroundNotifications(url, mailboxes, (await installationToken()) ?? "");
    if (before.enabled && before.configured && !before.running) {
      if (!backgroundRestartNoticeShown)
        setNotice("Background connection resumed after Android stopped its service.");
      backgroundRestartNoticeShown = true;
    } else if (before.running) backgroundRestartNoticeShown = false;
  };

  const coordinator = new SyncCoordinator(async () => {
    await initialize();
    if (!identity.deviceId)
      throw new Error("Open Family Circle to restore your identity before syncing.");
    await pollAll();
    try {
      await configureBackgroundConnection();
    } catch {
      /* Keep the saved subscription available during server outages. */
    }
    try {
      await synchronizeLocations();
      locationChanges.emit();
    } catch {
      locationChanges.emit();
      throw new Error("Location sync is waiting for a connection.");
    }
  });

  let foregroundChecksStarted = false;
  const startForegroundChecks = () => {
    if (foregroundChecksStarted) return;
    foregroundChecksStarted = true;
    bridge.createEventsChannel();
    Native.setAppForeground?.(AppState.currentState === "active");
    let lastSync = 0,
      lastHealth = 0;
    let checking = false;
    const tick = async () => {
      if (checking || AppState.currentState !== "active") return;
      checking = true;
      try {
        if (Date.now() - lastHealth >= 60_000) {
          lastHealth = Date.now();
          setRelayStatus((await relay.healthCheck()) ? "connected" : "unreachable");
        }
        if (!identity.deviceId) return;
        await initialize();
        const mailboxes = Object.values(circlesRef.current)
          .filter((c) => c.role !== "removed")
          .map((c) => c.mailboxId)
          .sort();
        try {
          await configureBackgroundConnection();
        } catch {
          /* Keep foreground sync available while the subscription reconnects. */
        }
        const capabilities = await relay.relayCapabilities();
        if (AppState.currentState !== "active") return;
        const url = capabilities.syncHub
          ? (process.env.EXPO_PUBLIC_RELAY_URL ?? "").replace(/\/$/, "") + capabilities.syncHub
          : "";
        const token = (await installationToken()) ?? "";
        if (AppState.currentState !== "active") return;
        Native.configureRelayConnection(url, mailboxes, token);
        const status = Native.relayConnectionStatus();
        const sharing = (await command<LocationState>({ op: "status" })).shares.some(
          (s) => s.active,
        );
        if (
          status.dirty ||
          Date.now() - lastSync >= (status.connected && !sharing ? 60_000 : 5_000)
        ) {
          lastSync = Date.now();
          await coordinator.request();
        }
      } catch {
        /* Durable state survives outages; next permitted trigger retries. */
      } finally {
        checking = false;
      }
    };
    AppState.addEventListener("change", (state) => {
      appStateRef.current = state;
      Native.setAppForeground?.(state === "active");
      if (state === "active") {
        void tick();
        void initialize()
          .then(async () => {
            if (
              identity.deviceId &&
              AppState.currentState === "active" &&
              (await command<LocationState>({ op: "status" })).shares.some((s) => s.active)
            )
              Native.startLocationService();
          })
          .catch(() => {});
      }
    });
    setInterval(() => {
      void tick();
    }, 1000);
    void tick();
  };

  const createCircle = async (): Promise<string | null> => {
    try {
      const adminId = identity.deviceIdRef.current;
      if (!adminId) throw new Error("Identity is unavailable.");
      const circle = await bridge.createCircle(DEVICE_SLOT);
      const mailboxId = await relay.registerMailbox();
      const invite = await freshInvite();
      updateCircles((prev) => ({
        ...prev,
        [circle.circleId]: {
          circleId: circle.circleId,
          mailboxId,
          role: "member",
          isCreator: true,
          members: [],
          adminId,
          membershipAuthority: "v1",
          invite,
        },
      }));
      await refreshMembers(circle.circleId);
      appendSystem(circle.circleId, "You created this Circle");

      return circle.circleId;
    } catch (err) {
      setNotice(`Couldn't create a Circle: ${describeError(err)}`);
      return null;
    }
  };

  const regenerateInvite = async (circleId: string) => {
    const active = circlesRef.current[circleId];
    if (!active?.isCreator || active.deleting || active.membershipAuthority !== "v1") return;
    try {
      const invite = await freshInvite();
      pendingJoinKeyPackages.current.delete(circleId);
      patchCircle(circleId, {
        invite,
        pendingJoinRequests: [],
        pendingJoinRequestNames: {},
        pendingJoinRequestMemberIds: {},
      });

      appendSystem(circleId, "Generated a new invite code — the old one no longer works.");
    } catch (err) {
      appendSystem(circleId, `Couldn't generate a new invite code: ${describeError(err)}`);
    }
  };

  const joinCircle = async (pairingCode: string): Promise<boolean> => {
    const parts = pairingCode.trim().split(".");
    const [circleId, mailboxId, inviteNonce] = parts;
    const hasQrCapability = parts.length >= 5 && parts.at(-2) === "qr";
    const qrCapability = hasQrCapability ? parts.at(-1) : undefined;
    const authorityAdminId = parts[3] === "qr" ? undefined : parts[3];
    if (!circleId || !mailboxId || !inviteNonce) {
      setNotice("That invite code doesn't look right — check it and try again.");
      return false;
    }
    const previous = circlesRef.current[circleId];
    if (previous?.role === "joining") {
      if (previous.mailboxId !== mailboxId) {
        setNotice("That invite code does not match the pending Circle request.");
        return false;
      }
      // An unanswered request has no MLS membership to leave. Remove it
      // locally before submitting the fresh invite, which also discards the
      // old queued request so it cannot keep the person stuck forever.
      await eraseCircle(circleId);
    } else if (previous && previous.role !== "removed") {
      setNotice(
        previous.deleting
          ? "Still leaving this Circle. Rejoin once the other members have confirmed your departure."
          : "You're already in (or joining) that Circle.",
      );
      return false;
    }
    if (previous && previous.mailboxId !== mailboxId) {
      setNotice("That invite code does not match this Circle.");
      return false;
    }
    try {
      updateCircles((prev) => ({
        ...prev,
        [circleId]: {
          circleName: previous?.circleName,
          circleId,
          mailboxId,
          role: "joining",
          isCreator: false,
          members: [],
          adminId: authorityAdminId,
          authorityAdminId,
          joinNonce: inviteNonce,
          joinRequestedAt: Date.now(),
        },
      }));
      const keyPackage = await bridge.createKeyPackage(DEVICE_SLOT);
      const name = identity.deviceIdRef.current
        ? identity.nicknamesRef.current[identity.deviceIdRef.current]
        : undefined;
      const payload = new TextEncoder().encode(
        JSON.stringify({
          keyPackage: bytesToBase64(keyPackage),
          ...(name ? { name } : {}),
          ...(qrCapability ? { qrCapability } : {}),
        }),
      );
      const sealed = await bridge.sealInviteRequest(
        inviteNonce,
        circleId,
        mailboxId,
        "join",
        payload,
      );
      queueControl(mailboxId, "keypackage", sealed, relay.buildInviteRequestEventId());
      appendSystem(
        circleId,
        qrCapability
          ? "Scanned invitation sent — joining as soon as the Circle confirms the membership update."
          : "Request sent — waiting to be let in...",
      );
      return true;
    } catch (err) {
      forgetCircle(circleId);
      setNotice(`Couldn't send a join request: ${describeError(err)}`);
      return false;
    }
  };

  const sendMessage = async (
    circleId: string,
    text: string,
    voice?: VoiceMessage,
    replyToItemId?: string,
    attachment?: ChatAttachment,
  ) => {
    const active = circlesRef.current[circleId];
    const trimmed = text.trim();
    if (
      !active ||
      active.deleting ||
      active.role !== "member" ||
      active.recoveryRequired ||
      active.syncError ||
      !trimmed ||
      trimmed.length > 10000 ||
      (voice !== undefined && !validVoiceMessage(voice)) ||
      (attachment !== undefined && (!validAttachment(attachment) || !!voice))
    )
      return false;
    try {
      const target =
        replyToItemId === undefined
          ? undefined
          : timeline.find(
              (item) =>
                item.id === replyToItemId && item.circleId === circleId && item.kind === "chat",
            );
      if (
        replyToItemId !== undefined &&
        (!target?.messageId || !target.senderId || target.deletedAt)
      )
        return false;
      const replyTo =
        target?.messageId && target.senderId
          ? { messageId: target.messageId, senderId: target.senderId }
          : undefined;
      if (replyTo && !validMessageReply(replyTo)) return false;
      // Persist the draft inside the encrypted checkpoint. Encrypt only after
      // a successful catch-up, so offline sends use the current epoch on return.
      const messageId = relay.randomId();
      const sentAt = Date.now();
      patchCircle(circleId, {
        pendingChats: [
          ...(active.pendingChats ?? []),
          {
            messageId,
            sentAt,
            text: trimmed,
            ...(attachment ? { attachment } : {}),
            ...(voice ? { voice } : {}),
            ...(replyTo ? { replyTo } : {}),
          },
        ],
      });
      const me = identity.deviceIdRef.current;
      if (me)
        appendChat(circleId, me, trimmed, messageId, true, voice, replyTo, sentAt, attachment);
      return true;
    } catch (err) {
      appendSystem(circleId, `Message failed to send: ${describeError(err)}`);
      return false;
    }
  };

  const changeMessage = async (
    circleId: string,
    itemId: string,
    text?: string,
  ): Promise<boolean> => {
    const circle = circlesRef.current[circleId],
      me = identity.deviceIdRef.current;
    const item = timeline.find((item) => item.id === itemId && item.circleId === circleId);
    const now = Date.now();
    if (
      !circle ||
      circle.role !== "member" ||
      circle.deleting ||
      circle.recoveryRequired ||
      circle.syncError ||
      !item ||
      !canChangeMessage(item, me, now)
    )
      return false;
    if (
      text !== undefined &&
      (item.voice || item.attachment || !text.trim() || text.trim().length > 10000)
    )
      return false;
    if (text !== undefined && text.trim() === item.text) return true;
    const change: MessageChange =
      text === undefined
        ? { type: "message-delete", messageId: item.messageId!, at: now }
        : { type: "message-edit", messageId: item.messageId!, at: now, text: text.trim() };
    const updated = applyMessageChange(item, me!, change);
    if (updated === item) return false;
    timeline = timeline.map((value) => (value.id === itemId ? updated : value));
    backup.afterStateCommit(changes.emit);
    // An unsealed offline draft has never reached anyone: erase it and its
    // queued edits instead of publishing its contents just to delete them.
    if (
      text === undefined &&
      circle.pendingChats?.some(
        (chat) => typeof chat !== "string" && chat.messageId === item.messageId,
      )
    ) {
      patchCircle(circleId, {
        pendingChats: circle.pendingChats.filter(
          (chat) => typeof chat === "string" || chat.messageId !== item.messageId,
        ),
        pendingBroadcasts: (circle.pendingBroadcasts ?? []).filter((value) => {
          const p = JSON.parse(value);
          return p.messageId !== item.messageId;
        }),
      });
    } else await broadcastToCircle(circleId, change);
    return true;
  };

  const applyReaction = (
    circleId: string,
    messageId: string,
    authorId: string,
    memberId: string,
    emoji: string | null,
  ) => {
    timeline = timeline.map((item) => {
      if (
        item.deletedAt ||
        item.kind !== "chat" ||
        item.circleId !== circleId ||
        !item.messageId ||
        item.messageId !== messageId ||
        item.senderId !== authorId
      )
        return item;
      const reactions = { ...item.reactions };
      if (emoji === null) delete reactions[memberId];
      else reactions[memberId] = emoji;
      return { ...item, reactions };
    });
    backup.afterStateCommit(changes.emit);
  };

  const reactToMessage = async (circleId: string, itemId: string, emoji: string | null) => {
    const circle = circlesRef.current[circleId],
      me = identity.deviceIdRef.current;
    const item = timeline.find(
      (item) => item.circleId === circleId && item.id === itemId && item.kind === "chat",
    );
    if (
      !circle ||
      circle.deleting ||
      circle.role !== "member" ||
      circle.recoveryRequired ||
      circle.syncError ||
      !me ||
      !item?.messageId ||
      item.deletedAt ||
      !item.senderId ||
      !validReaction(emoji)
    )
      return false;
    if ((item.reactions?.[me] ?? null) === emoji) return true;
    applyReaction(circleId, item.messageId, item.senderId, me, emoji);
    await broadcastToCircle(circleId, {
      type: "reaction",
      messageId: item.messageId,
      authorId: item.senderId,
      emoji,
    });
    return true;
  };

  const removeMember = async (circleId: string, memberId: string) => {
    const active = circlesRef.current[circleId];
    if (
      !active?.isCreator ||
      active.deleting ||
      active.role !== "member" ||
      active.membershipAuthority !== "v1"
    )
      return;
    patchCircle(circleId, {
      blockedAutoJoinIds: [...new Set([...(active.blockedAutoJoinIds ?? []), memberId])],
    });
    enqueueMembershipChange(circleId, { type: "remove", memberId });
    appendSystem(
      circleId,
      `Removal requested for ${displayMember(memberId, identity.nicknamesRef.current)} — waiting for confirmation.`,
    );
  };

  const eraseCircle = async (circleId: string): Promise<boolean> => {
    const active = circlesRef.current[circleId];
    if (!active) return true;
    // Idempotent even for pending joins without an MLS group. The native
    // removal also queues a location stop and erases the Circle's pins.
    await bridge.forgetCircle(DEVICE_SLOT, circleId);
    backup.discardMailboxOutbox(active.mailboxId);
    timeline = timeline.filter((item) => item.circleId !== circleId);
    forgetCircle(circleId);
    backup.afterStateCommit(() => {
      changes.emit();
      locationChanges.emit();
    });
    return true;
  };

  const deleteCircle = async (circleId: string): Promise<boolean> => {
    const current = circlesRef.current[circleId];
    if (!current || current.deleting) return true;
    if (
      current.role === "joining" ||
      current.role === "removed" ||
      (current.role === "member" && current.members.length <= 1)
    )
      return eraseCircle(circleId);
    if (
      (current.isCreator && current.members.length > 1) ||
      (current.handover && !current.handover.confirmed)
    ) {
      setNotice(
        "Choose a new admin in Circle settings and wait for their phone to confirm before leaving.",
      );
      return false;
    }
    await command({ op: "stop", circleId });
    // Keep prepared commits and join requests: they may already have reached
    // peers. Drop unsent chat, but preserve protocol data needed to leave.
    backup.discardMailboxApplications(current.mailboxId);
    timeline = timeline.filter((item) => item.circleId !== circleId);
    const departingMembers = [
      ...new Set([...(current.departingMembers ?? []), identity.deviceIdRef.current!]),
    ];
    const previousAdmin =
      current.adminId ?? (current.isCreator ? identity.deviceIdRef.current : current.members[0]);
    const successor =
      previousAdmin && !departingMembers.includes(previousAdmin)
        ? previousAdmin
        : (current.members.find((id) => !departingMembers.includes(id)) ?? current.members.at(-1));
    patchCircle(circleId, {
      deleting: true,
      pendingChats: [],
      pendingBroadcasts: [],
      membershipChanges: [],
      departingMembers,
      adminId: successor,
      isCreator: successor === identity.deviceIdRef.current,
    });
    backup.afterStateCommit(() => {
      changes.emit();
      locationChanges.emit();
    });
    setNotice("Leaving requested. Other members must reconnect to confirm your departure.");
    return true;
  };

  const leaveCircle = deleteCircle;

  const transferAdmin = async (circleId: string, memberId: string) => {
    const current = circlesRef.current[circleId];
    if (
      !current?.isCreator ||
      current.membershipAuthority !== "v1" ||
      current.role !== "member" ||
      current.deleting ||
      current.recoveryRequired ||
      current.syncError ||
      current.pendingCommitEventId ||
      (current.handover && !current.handover.confirmed)
    )
      return;
    if (
      memberId === identity.deviceIdRef.current ||
      !current.members.includes(memberId) ||
      current.departingMembers?.includes(memberId)
    )
      return;
    const id = relay.randomId();
    const me = identity.deviceIdRef.current;
    if (!me) return;
    // Commit this policy transition before queuing its MLS-authenticated
    // application message. A crash/retry can delay delivery, but cannot let
    // the former admin create another membership commit in the meantime.
    await bridge.adoptMembershipAdmin(DEVICE_SLOT, circleId, me, memberId);
    patchCircle(circleId, {
      handover: { id, adminId: memberId },
      adminId: memberId,
      isCreator: false,
    });
    await broadcastToCircle(circleId, { type: "admin-transfer", id, adminId: memberId });
  };
  const setNotifications = async (circleId: string, preferences: backup.CircleNotifications) => {
    if (!circlesRef.current[circleId]) return;
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
    if (circlesRef.current[circleId]?.departureConfirmedAt) forgetCircle(circleId);
  };

  backup.onEnvelopeAcknowledged?.((entry) => {
    if (entry.kind !== "application" || !entry.plaintext) return;
    let payload: AppPayload;
    try {
      payload = JSON.parse(entry.plaintext);
    } catch {
      return;
    }
    if (payload.type === "admin-transfer") return; // already atomically adopted before queueing it
    if ((payload.type !== "chat" && payload.type !== "attachment-chunk") || !payload.messageId)
      return;
    const id = payload.messageId;
    timeline = timeline.map((item) =>
      item.messageId === id &&
      item.senderId === identity.deviceIdRef.current &&
      circlesRef.current[item.circleId]?.mailboxId === entry.mailboxId &&
      item.delivery === "waiting" &&
      (!item.attachment ||
        (payload.type === "attachment-chunk" &&
          payload.index === Math.ceil(item.attachment.base64.length / ATTACHMENT_CHUNK_LENGTH) - 1))
        ? { ...item, delivery: "sent" }
        : item,
    );
    backup.afterStateCommit(changes.emit);
  });

  // Self-service ask to be re-added to a Circle whose local MLS state has
  // gone bad. Requires a pairing code (same as Join Circle) obtained from
  // the creator out-of-band.
  const requestRejoin = async (circleId: string, pairingCode: string) => {
    const active = circlesRef.current[circleId];
    const me = identity.deviceIdRef.current;
    if (!active || active.deleting || !me) return;
    const [codeCircleId, codeMailboxId, inviteNonce, authorityAdminId] = pairingCode
      .trim()
      .split(".");
    if (!codeCircleId || !codeMailboxId || !inviteNonce) {
      appendSystem(circleId, "Enter the invite code the Circle's admin shared with you.");
      return;
    }
    if (codeCircleId !== active.circleId || codeMailboxId !== active.mailboxId) {
      appendSystem(circleId, "That invite code doesn't match this Circle.");
      return;
    }
    try {
      const keyPackage = await bridge.createKeyPackage(DEVICE_SLOT);
      const payload = new TextEncoder().encode(
        JSON.stringify({ deviceId: me, keyPackage: bytesToBase64(keyPackage) }),
      );
      const sealed = await bridge.sealInviteRequest(
        inviteNonce,
        circleId,
        active.mailboxId,
        "rejoin",
        payload,
      );
      const eventId = queueControl(
        active.mailboxId,
        "rejoin-request",
        sealed,
        relay.buildRejoinRequestEventId(),
      );
      bucket(myOwnEventIds.current, circleId).add(eventId);
      awaitingRejoinWelcome.current.add(circleId);
      awaitingRejoinNonce.current.set(circleId, inviteNonce);
      patchCircle(circleId, { recoveryRequired: true, syncError: undefined, authorityAdminId });
      appendSystem(circleId, "Rejoin request sent — waiting for the admin to approve...");
    } catch (err) {
      appendSystem(circleId, `Rejoin request failed: ${describeError(err)}`);
    }
  };

  // Approval spends the invite and drops the other pending requests.
  // If the requester still has a stale leaf, replace it in the same commit.
  const approveRejoinRequest = async (circleId: string, requesterId: string) => {
    const active = circlesRef.current[circleId];
    if (!active || active.deleting || !active.isCreator || active.membershipAuthority !== "v1")
      return;
    if (!active.invite || active.invite.used) {
      appendSystem(
        circleId,
        "Can't approve — this invite code was already used. Generate a new one first.",
      );
      return;
    }
    const keyPackage = pendingRejoinKeyPackages.current.get(circleId)?.get(requesterId);
    if (!keyPackage) return;
    enqueueMembershipChange(circleId, {
      type: "rejoin",
      memberId: requesterId,
      keyPackage: bytesToBase64(keyPackage),
    });
    pendingRejoinKeyPackages.current.delete(circleId);
    patchCircle(circleId, { invite: { ...active.invite, used: true }, pendingRejoinRequests: [] });
    appendSystem(
      circleId,
      `Approved ${displayMember(requesterId, identity.nicknamesRef.current)}'s rejoin — waiting for confirmation.`,
    );
  };

  // Approve a manual join using the KeyPackage opened from its encrypted request.
  const approveJoinRequest = async (circleId: string, requestId: string) => {
    const active = circlesRef.current[circleId];
    if (!active || active.deleting || !active.isCreator || active.membershipAuthority !== "v1")
      return;
    if (!active.invite || active.invite.used || Date.now() >= active.invite.expiresAt) {
      appendSystem(circleId, "Can't approve — generate a fresh invite code first.");
      return;
    }
    const keyPackage = pendingJoinKeyPackages.current.get(circleId)?.get(requestId);
    if (!keyPackage) return;
    enqueueMembershipChange(circleId, { type: "add", keyPackage: bytesToBase64(keyPackage) });
    pendingJoinKeyPackages.current.delete(circleId);
    const requesterId = active.pendingJoinRequestMemberIds?.[requestId];
    patchCircle(circleId, {
      invite: { ...active.invite, used: true },
      pendingJoinRequests: [],
      pendingJoinRequestNames: {},
      pendingJoinRequestMemberIds: {},
      blockedAutoJoinIds: requesterId
        ? active.blockedAutoJoinIds?.filter((id) => id !== requesterId)
        : active.blockedAutoJoinIds,
    });
    appendSystem(
      circleId,
      "Approved the join request — waiting for the membership update to be confirmed.",
    );
  };

  // Sets (and broadcasts) this device's own nickname — global across all
  // Circles, so it fans out to every Circle currently joined.
  const setNickname = async (nickname: string) => {
    const me = identity.deviceIdRef.current;
    const trimmed = nickname.trim().slice(0, MAX_NICKNAME_LEN);
    if (!me || !trimmed || trimmed === identity.nicknamesRef.current[me]) return;
    identity.updateNicknames((prev) => ({ ...prev, [me]: trimmed }));
    await broadcastNicknameToAllCircles(trimmed);
    backup.syncBackupNow(DEVICE_SLOT);
  };

  const setProfilePhoto = async (photo: string | null): Promise<boolean> => {
    const me = identity.deviceIdRef.current;
    if (!me || !validProfilePhoto(photo)) return false;
    if ((identity.profilePhotosRef.current[me] ?? null) === photo) return true;
    identity.updateProfilePhotos((prev) => ({ ...prev, [me]: photo }));
    for (const circle of Object.values(circlesRef.current)) {
      await broadcastToCircle(circle.circleId, { type: "profile-photo", photo });
    }
    backup.syncBackupNow(DEVICE_SLOT);
    return true;
  };

  // Local callers must be the admin. Receiving clients still need their
  // own sender check to reject renames from a modified member client.
  const setCircleName = async (circleId: string, name: string) => {
    const active = circlesRef.current[circleId];
    const trimmed = name.trim().slice(0, MAX_CIRCLE_NAME_LEN);
    if (!active?.isCreator || active.deleting || !trimmed || trimmed === active.circleName) return;
    patchCircle(circleId, { circleName: trimmed });
    await broadcastToCircle(circleId, { type: "circle-rename", name: trimmed });
    appendSystem(circleId, `Circle renamed to "${trimmed}"`);
    backup.syncBackupNow(DEVICE_SLOT);
  };

  const refreshConnection = async (circleId: string) => {
    const circle = circlesRef.current[circleId];
    if (!circle?.isCreator || circle.role !== "member" || circle.syncError) return;
    enqueueMembershipChange(circleId, { type: "refresh" });
    appendSystem(circleId, "Connection key refresh requested — waiting for confirmation.");
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
        setNotice(`The change could not be saved. Please try again. ${describeError(error)}`);
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
      Object.entries(circles).map(([id, circle]) => [
        id,
        {
          ...circle,
          pendingSends:
            backup.pendingMessageCount(circle.mailboxId) + (circle.pendingChats?.length ?? 0),
        },
      ]),
    ),
    timeline,
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
          ? sendMessage(id, attachmentLabel(attachment), undefined, replyToItemId, attachment)
          : false,
      false,
    ),
    sendVoiceMessage: durableAction(
      async (id: string, voice: VoiceMessage, replyToItemId?: string) =>
        validVoiceMessage(voice) ? sendMessage(id, voiceLabel(voice), voice, replyToItemId) : false,
      false,
    ),
    sendMessage: durableAction(
      (id: string, text: string, replyToItemId?: string) =>
        sendMessage(id, text, undefined, replyToItemId),
      false,
    ),
    editMessage: durableAction(
      (circleId: string, itemId: string, text: string) => changeMessage(circleId, itemId, text),
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
