import { circleTransition } from "./circle-transitions";
import type { Timeline } from "./timeline";
import { attachmentLabel, validAttachmentInfo } from "../attachment";
import * as bridge from "../bridge";
import { validMessageReply } from "../message-reply";
import { validProfilePhoto } from "../profile-photo";
import { validReaction } from "../reactions";
import { validVoiceMessage, voiceLabel } from "../voice-message";
import { DEVICE_SLOT, MAX_CIRCLE_NAME_LEN } from "./circle-constants";
import {
  circleLabel,
  displayMember,
  type AppPayload,
  type CircleInfo,
} from "./circle-types";
import { type IdentityContextValue, MAX_NICKNAME_LEN } from "./identity";

interface Dependencies {
  timeline: Pick<
    Timeline,
    | "receiveAttachmentChunk"
    | "changeMessage"
    | "find"
    | "applyReaction"
    | "markDelivered"
    | "appendChat"
  >;
  identity: Pick<
    IdentityContextValue,
    "deviceIdRef" | "nicknamesRef" | "updateNicknames" | "updateProfilePhotos"
  >;
  broadcastToCircle: (circleId: string, payload: AppPayload) => Promise<void>;
  appendSystem: (circleId: string, text: string) => void;
  patchCircle: (circleId: string, patch: Partial<CircleInfo>) => void;
  shouldNotifyReaction: (
    circleId: string,
    messageId: string,
    reactorId: string,
  ) => boolean;
  notifyIfBackgrounded: (
    circleId: string,
    title: string,
    body: string,
    category?: "chat" | "location" | "system",
  ) => void;
  getCircle: (circleId: string) => CircleInfo | undefined;
}

// The sync loop supplies the authenticated sender and owns the state transaction.
export function createApplicationHandler({
  timeline,
  identity,
  broadcastToCircle,
  appendSystem,
  patchCircle,
  shouldNotifyReaction,
  notifyIfBackgrounded,
  getCircle,
}: Dependencies) {
  const handleAttachmentChunk = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: Extract<AppPayload, { type: "attachment-chunk" }>,
  ) => {
    if (!current.members.includes(senderDeviceId)) return;
    const complete = timeline.receiveAttachmentChunk(circleId, senderDeviceId, payload);
    if (complete && senderDeviceId !== identity.deviceIdRef.current)
      await broadcastToCircle(circleId, {
        type: "receipt",
        messageId: payload.messageId,
        recipientId: senderDeviceId,
      });
  };

  const handleMessageChange = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: Extract<AppPayload, { type: "message-edit" | "message-delete" }>,
  ) => {
    if (
      current.members.includes(senderDeviceId) &&
      typeof payload.messageId === "string" &&
      payload.messageId.length <= 128 &&
      Number.isFinite(payload.at) &&
      payload.at <= Date.now() + 60_000
    ) {
      timeline.changeMessage(circleId, senderDeviceId, payload);
    }
  };

  const handleProfilePhoto = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: Extract<AppPayload, { type: "profile-photo" }>,
  ) => {
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
  };

  const handleNickname = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: Extract<AppPayload, { type: "nickname" }>,
  ) => {
    const nickname = payload.nickname.trim().slice(0, MAX_NICKNAME_LEN);
    if (nickname && nickname !== identity.nicknamesRef.current[senderDeviceId]) {
      identity.updateNicknames((prev) => ({ ...prev, [senderDeviceId]: nickname }));
      appendSystem(circleId, `${nickname} updated their name`);
    }
  };

  const handleAdminTransfer = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: Extract<AppPayload, { type: "admin-transfer" }>,
  ) => {
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
      patchCircle(
        circleId,
        circleTransition(
          current,
          { type: "admin-changed", adminId: payload.adminId },
          identity.deviceIdRef.current,
        ),
      );
      appendSystem(
        circleId,
        `${displayMember(payload.adminId, identity.nicknamesRef.current)} is now the admin`,
      );
      if (payload.adminId === identity.deviceIdRef.current)
        await broadcastToCircle(circleId, { type: "admin-ack", id: payload.id });
    }
  };

  const handleAdminAck = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: Extract<AppPayload, { type: "admin-ack" }>,
  ) => {
    if (
      current.handover?.id === payload.id &&
      current.handover.adminId === senderDeviceId &&
      current.adminId === senderDeviceId
    ) {
      patchCircle(circleId, { handover: { ...current.handover, confirmed: true } });
    }
  };

  const handleCircleAdmin = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: Extract<AppPayload, { type: "circle-admin" }>,
  ) => {
    // New members bootstrap the app-level admin from an authenticated member announcement.
    // Established members only accept changes authorized by their current admin.
    if (
      payload.adminId === senderDeviceId &&
      current.members.includes(senderDeviceId) &&
      (current.awaitingAdminAnnouncement || senderDeviceId === current.adminId)
    ) {
      patchCircle(circleId, {
        adminId: senderDeviceId,
        isAdmin: senderDeviceId === identity.deviceIdRef.current,
        awaitingAdminAnnouncement: false,
      });
    }
  };

  const handleReaction = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: Extract<AppPayload, { type: "reaction" }>,
  ) => {
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
      timeline.applyReaction(
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
  };

  const handleReceipt = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: Extract<AppPayload, { type: "receipt" }>,
  ) => {
    if (payload.recipientId === identity.deviceIdRef.current) {
      timeline.markDelivered(
        circleId,
        payload.messageId,
        payload.recipientId,
        senderDeviceId,
      );
    }
  };

  const handleCircleRename = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: Extract<AppPayload, { type: "circle-rename" }>,
  ) => {
    // The UI only lets admins rename a Circle, but this receiver
    // currently accepts renames from any authenticated member.
    const name = payload.name.trim().slice(0, MAX_CIRCLE_NAME_LEN);
    if (name && name !== getCircle(circleId)?.circleName) {
      patchCircle(circleId, { circleName: name });
      appendSystem(circleId, `Circle renamed to "${name}"`);
    }
  };

  const handleChat = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: Extract<AppPayload, { type: "chat" }>,
  ) => {
    if (!(
      typeof payload.text === "string" &&
      payload.text.length <= 10000 &&
      (payload.voice === undefined ||
        (validVoiceMessage(payload.voice) && current.members.includes(senderDeviceId))) &&
      (payload.attachment === undefined ||
        (!payload.voice &&
          validAttachmentInfo(payload.attachment) &&
          current.members.includes(senderDeviceId)))
    ))
      return;

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
    const added = timeline.appendChat({
      circleId,
      senderId: senderDeviceId,
      text: messageText,
      messageId,
      voice: payload.voice,
      replyTo,
      sentAt:
        typeof payload.sentAt === "number" &&
        Number.isFinite(payload.sentAt) &&
        payload.sentAt <= Date.now() + 60_000
          ? payload.sentAt
          : undefined,
      attachment: payload.attachment
        ? {
            name: payload.attachment.name,
            mimeType: payload.attachment.mimeType,
            size: payload.attachment.size,
            kind: payload.attachment.kind,
            base64: "",
          }
        : undefined,
    });
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
  };

  const handleApplication = async (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: AppPayload,
  ) => {
    switch (payload.type) {
      case "attachment-chunk":
        return handleAttachmentChunk(circleId, current, senderDeviceId, payload);
      case "message-edit":
      case "message-delete":
        return handleMessageChange(circleId, current, senderDeviceId, payload);
      case "profile-photo":
        return handleProfilePhoto(circleId, current, senderDeviceId, payload);
      case "nickname":
        return handleNickname(circleId, current, senderDeviceId, payload);
      case "admin-transfer":
        return handleAdminTransfer(circleId, current, senderDeviceId, payload);
      case "admin-ack":
        return handleAdminAck(circleId, current, senderDeviceId, payload);
      case "circle-admin":
        return handleCircleAdmin(circleId, current, senderDeviceId, payload);
      case "reaction":
        return handleReaction(circleId, current, senderDeviceId, payload);
      case "receipt":
        return handleReceipt(circleId, current, senderDeviceId, payload);
      case "circle-rename":
        return handleCircleRename(circleId, current, senderDeviceId, payload);
      case "chat":
        return handleChat(circleId, current, senderDeviceId, payload);
    }
  };

  return { handleApplication };
}
