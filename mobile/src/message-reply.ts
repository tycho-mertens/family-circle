// Quotes resolve against locally authenticated history. Never trust quoted text
// or an author's display name supplied by the person sending a reply.
export interface MessageReply {
  messageId: string;
  senderId: string;
}
export function validMessageReply(value: unknown): value is MessageReply {
  if (!value || typeof value !== "object") return false;
  const reply = value as MessageReply;
  return (
    typeof reply.messageId === "string" &&
    reply.messageId.length > 0 &&
    reply.messageId.length <= 128 &&
    typeof reply.senderId === "string" &&
    reply.senderId.length > 0 &&
    reply.senderId.length <= 200
  );
}
