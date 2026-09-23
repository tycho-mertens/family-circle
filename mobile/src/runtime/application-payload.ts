import { validAttachmentInfo, ATTACHMENT_CHUNK_LENGTH } from "../attachment";
import { validMessageReply } from "../message-reply";
import { validProfilePhoto } from "../profile-photo";
import { validReaction } from "../reactions";
import { validVoiceMessage } from "../voice-message";
import type { AppPayload } from "./circle-types";

const messageId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 128;
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

// MLS authenticates the sender, not the JSON shape. Keep untrusted fields out
// of the handlers; optional legacy chat metadata can be discarded independently.
export function decodeApplicationPayload(plaintext: Uint8Array): AppPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  switch (p.type) {
    case "chat":
      if (
        typeof p.text !== "string" ||
        p.text.length > 10000 ||
        (p.voice !== undefined && !validVoiceMessage(p.voice)) ||
        (p.attachment !== undefined &&
          (!validAttachmentInfo(p.attachment) || p.voice !== undefined))
      )
        return null;
      return {
        type: "chat",
        text: p.text,
        messageId: messageId(p.messageId) ? p.messageId : undefined,
        sentAt: timestamp(p.sentAt) ? p.sentAt : undefined,
        replyTo: validMessageReply(p.replyTo) ? p.replyTo : undefined,
        voice: validVoiceMessage(p.voice) ? p.voice : undefined,
        attachment: validAttachmentInfo(p.attachment) ? p.attachment : undefined,
      };
    case "message-edit":
      return messageId(p.messageId) && timestamp(p.at) && typeof p.text === "string"
        ? { type: p.type, messageId: p.messageId, at: p.at, text: p.text }
        : null;
    case "message-delete":
      return messageId(p.messageId) && timestamp(p.at)
        ? { type: p.type, messageId: p.messageId, at: p.at }
        : null;
    case "attachment-chunk":
      return messageId(p.messageId) &&
        typeof p.index === "number" &&
        Number.isInteger(p.index) &&
        p.index >= 0 &&
        typeof p.data === "string" &&
        p.data.length <= ATTACHMENT_CHUNK_LENGTH
        ? { type: p.type, messageId: p.messageId, index: p.index, data: p.data }
        : null;
    case "reaction":
      return messageId(p.messageId) && typeof p.authorId === "string" && validReaction(p.emoji)
        ? { type: p.type, messageId: p.messageId, authorId: p.authorId, emoji: p.emoji }
        : null;
    case "receipt":
      return messageId(p.messageId) && typeof p.recipientId === "string"
        ? { type: p.type, messageId: p.messageId, recipientId: p.recipientId }
        : null;
    case "admin-transfer":
      return messageId(p.id) && typeof p.adminId === "string"
        ? { type: p.type, id: p.id, adminId: p.adminId }
        : null;
    case "admin-ack":
      return messageId(p.id) ? { type: p.type, id: p.id } : null;
    case "circle-admin":
      return typeof p.adminId === "string" ? { type: p.type, adminId: p.adminId } : null;
    case "profile-photo":
      return validProfilePhoto(p.photo) ? { type: p.type, photo: p.photo } : null;
    case "nickname":
      return typeof p.nickname === "string" ? { type: p.type, nickname: p.nickname } : null;
    case "circle-rename":
      return typeof p.name === "string" ? { type: p.type, name: p.name } : null;
    default:
      return null; // A newer client may send a payload this version does not know.
  }
}
