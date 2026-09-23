import { canWriteMessages } from "./circle-lifecycle";
import type { Timeline } from "./timeline";
import { validAttachment, type ChatAttachment } from "../attachment";
import { applyMessageChange, canChangeMessage, type MessageChange } from "../message-actions";
import { validMessageReply } from "../message-reply";
import { validReaction } from "../reactions";
import * as relay from "../relay";
import { validVoiceMessage, type VoiceMessage } from "../voice-message";
import { type AppPayload, type CircleInfo } from "./circle-types";
import { describeError, type IdentityContextValue } from "./identity";

interface Dependencies {
  getCircle: (circleId: string) => CircleInfo | undefined;
  timeline: Pick<Timeline, "find" | "appendChat" | "changeMessage" | "applyReaction">;
  patchCircle: (circleId: string, patch: Partial<CircleInfo>) => void;
  identity: Pick<IdentityContextValue, "deviceIdRef">;
  appendSystem: (circleId: string, text: string) => void;
  broadcastToCircle: (circleId: string, payload: AppPayload) => Promise<void>;
}

// The public runtime wraps these local changes in a durable state transaction.
export function createMessageActions({
  getCircle,
  timeline,
  patchCircle,
  identity,
  appendSystem,
  broadcastToCircle,
}: Dependencies) {
  const sendMessage = async (
    circleId: string,
    text: string,
    voice?: VoiceMessage,
    replyToItemId?: string,
    attachment?: ChatAttachment,
  ) => {
    const active = getCircle(circleId);
    const trimmed = text.trim();
    if (
      !active ||
      !canWriteMessages(active) ||
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
        timeline.appendChat({
          circleId,
          senderId: me,
          text: trimmed,
          messageId,
          own: true,
          voice,
          replyTo,
          sentAt,
          attachment,
        });
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
    const circle = getCircle(circleId),
      me = identity.deviceIdRef.current;
    const item = timeline.find((item) => item.id === itemId && item.circleId === circleId);
    const now = Date.now();
    if (!circle || !canWriteMessages(circle) || !item || !canChangeMessage(item, me, now))
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
    timeline.changeMessage(circleId, me!, change);
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

  const reactToMessage = async (circleId: string, itemId: string, emoji: string | null) => {
    const circle = getCircle(circleId),
      me = identity.deviceIdRef.current;
    const item = timeline.find(
      (item) => item.circleId === circleId && item.id === itemId && item.kind === "chat",
    );
    if (
      !circle ||
      !canWriteMessages(circle) ||
      !me ||
      !item?.messageId ||
      item.deletedAt ||
      !item.senderId ||
      !validReaction(emoji)
    )
      return false;
    if ((item.reactions?.[me] ?? null) === emoji) return true;
    timeline.applyReaction(circleId, item.messageId, item.senderId, me, emoji);
    await broadcastToCircle(circleId, {
      type: "reaction",
      messageId: item.messageId,
      authorId: item.senderId,
      emoji,
    });
    return true;
  };

  return { sendMessage, changeMessage, reactToMessage };
}
