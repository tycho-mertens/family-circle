import type { SavedChatItem } from "./backup";
export const MESSAGE_ACTION_WINDOW_MS = 15 * 60_000;
export type MessageChange =
  | { type: "message-edit"; messageId: string; at: number; text: string }
  | { type: "message-delete"; messageId: string; at: number };
export function withinMessageWindow(item: SavedChatItem, now: number): boolean {
  const sentAt = item.sentAt ?? item.at;
  return (
    Number.isFinite(now) &&
    Number.isFinite(sentAt) &&
    now >= sentAt &&
    now - sentAt < MESSAGE_ACTION_WINDOW_MS
  );
}
export function canChangeMessage(
  item: SavedChatItem,
  deviceId: string | null | undefined,
  now = Date.now(),
): boolean {
  return (
    item.kind === "chat" &&
    !!item.messageId &&
    !!deviceId &&
    item.senderId === deviceId &&
    !item.deletedAt &&
    withinMessageWindow(item, now)
  );
}
export function applyMessageChange(
  item: SavedChatItem,
  senderId: string,
  change: MessageChange,
): SavedChatItem {
  if (
    item.kind !== "chat" ||
    item.senderId !== senderId ||
    item.messageId !== change.messageId ||
    item.deletedAt ||
    !withinMessageWindow(item, change.at)
  )
    return item;
  if (change.type === "message-delete")
    return {
      ...item,
      text: "",
      voice: undefined,
      attachment: undefined,
      attachmentParts: undefined,
      originalText: undefined,
      editedAt: undefined,
      reactions: undefined,
      replyTo: undefined,
      deletedAt: change.at,
    };
  if (
    item.voice ||
    item.attachment ||
    typeof change.text !== "string" ||
    !change.text.trim() ||
    change.text.length > 10000 ||
    change.at <= (item.editedAt ?? -Infinity) ||
    change.text === item.text
  )
    return item;
  return {
    ...item,
    originalText: item.originalText ?? item.text,
    text: change.text,
    editedAt: change.at,
  };
}
