import {
  ATTACHMENT_CHUNK_LENGTH,
  acceptAttachmentChunk,
  type AttachmentChunk,
} from "../attachment";
import type { AppPayload } from "./circle-types";
import type { ChatAttachment } from "../attachment";
import type { MessageReply } from "../message-reply";
import type { VoiceMessage } from "../voice-message";
import { applyMessageChange, type MessageChange } from "../message-actions";
import type { CircleInfo, TimelineItem } from "./circle-types";

export interface NewChat {
  circleId: string;
  senderId: string;
  text: string;
  messageId?: string;
  own?: boolean;
  voice?: VoiceMessage;
  replyTo?: MessageReply;
  sentAt?: number;
  attachment?: ChatAttachment;
}

// Only this store replaces timeline state. The runtime schedules notifications
// after the surrounding persistence transaction commits.
export function createTimeline({
  getCircle,
  onChange,
}: {
  getCircle: (circleId: string) => CircleInfo | undefined;
  onChange: () => void;
}) {
  let items: TimelineItem[] = [];
  // Timeline IDs increase for the lifetime of this runtime.
  let sequence = 0;
  const nextTimelineId = () => `t${sequence++}`;

  const appendSystem = (circleId: string, text: string) => {
    if (getCircle(circleId)?.deleting) return;
    const item: TimelineItem = {
      id: nextTimelineId(),
      circleId,
      kind: "system",
      text,
      at: Date.now(),
    };
    items = [...items, item];
    onChange();
  };
  const appendChat = ({
    circleId,
    senderId,
    text,
    messageId,
    own = false,
    voice,
    replyTo,
    sentAt,
    attachment,
  }: NewChat) => {
    if (getCircle(circleId)?.deleting) return;
    if (
      messageId &&
      items.some(
        (item) =>
          item.circleId === circleId &&
          item.senderId === senderId &&
          item.messageId === messageId,
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
            recipients: getCircle(circleId)!.members.filter((id) => id !== senderId),
            deliveredTo: [],
          }
        : {}),
    };
    items = [...items, item];
    onChange();
    return true;
  };

  const restore = (saved: TimelineItem[] = []) => {
    items = saved;
    sequence = saved.reduce((next, item) => {
      const match = /^t(\d+)$/.exec(item.id);
      return match ? Math.max(next, Number(match[1]) + 1) : next;
    }, 0);
  };
  const update = (transform: (item: TimelineItem) => TimelineItem) => {
    items = items.map(transform);
    onChange();
  };
  const removeCircle = (circleId: string) => {
    items = items.filter((item) => item.circleId !== circleId);
    onChange();
  };
  const changeMessage = (circleId: string, senderId: string, change: MessageChange) =>
    update((item) =>
      item.circleId === circleId ? applyMessageChange(item, senderId, change) : item,
    );
  const applyReaction = (
    circleId: string,
    messageId: string,
    authorId: string,
    memberId: string,
    emoji: string | null,
  ) => {
    update((item) => {
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
  };
  const receiveAttachmentChunk = (
    circleId: string,
    senderId: string,
    chunk: AttachmentChunk,
  ) => {
    const target = items.find(
      (item) =>
        item.circleId === circleId &&
        item.senderId === senderId &&
        item.messageId === chunk.messageId &&
        !item.deletedAt &&
        item.attachment,
    );
    if (!target?.attachment) return false;
    const result = acceptAttachmentChunk(
      target.attachment,
      target.attachmentParts ?? {},
      chunk,
    );
    if (!result) return false;
    update((item) =>
      item.id === target.id
        ? { ...item, attachment: result.attachment, attachmentParts: result.parts }
        : item,
    );
    return !!result.attachment.base64;
  };
  const markDelivered = (
    circleId: string,
    messageId: string,
    authorId: string,
    recipientId: string,
  ) => {
    update((item) =>
      item.circleId === circleId &&
      item.senderId === authorId &&
      item.messageId === messageId &&
      item.recipients?.includes(recipientId)
        ? {
            ...item,
            delivery: "delivered",
            deliveredTo: [...new Set([...(item.deliveredTo ?? []), recipientId])],
          }
        : item,
    );
  };
  const markSent = (mailboxId: string, senderId: string | null, payload: AppPayload) => {
    if ((payload.type !== "chat" && payload.type !== "attachment-chunk") || !payload.messageId)
      return;
    update((item) =>
      item.messageId === payload.messageId &&
      item.senderId === senderId &&
      getCircle(item.circleId)?.mailboxId === mailboxId &&
      item.delivery === "waiting" &&
      (!item.attachment ||
        (payload.type === "attachment-chunk" &&
          payload.index ===
            Math.ceil(item.attachment.base64.length / ATTACHMENT_CHUNK_LENGTH) - 1))
        ? { ...item, delivery: "sent" }
        : item,
    );
  };
  return {
    snapshot: () => items,
    restore,
    appendChat,
    appendSystem,
    receiveAttachmentChunk,
    markDelivered,
    markSent,
    removeCircle,
    changeMessage,
    applyReaction,
    find: (predicate: (item: TimelineItem) => boolean) => items.find(predicate),
  };
}
export type Timeline = ReturnType<typeof createTimeline>;
