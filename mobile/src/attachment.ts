export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_CHUNK_LENGTH = 128 * 1024; // base64, divisible by four
export interface AttachmentInfo {
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "video" | "file";
}
export interface ChatAttachment extends AttachmentInfo {
  base64: string;
}
export interface AttachmentChunk {
  type: "attachment-chunk";
  messageId: string;
  index: number;
  data: string;
}
export const attachmentKind = (mime: string): AttachmentInfo["kind"] =>
  ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)
    ? "image"
    : ["video/mp4", "video/quicktime", "video/webm"].includes(mime)
      ? "video"
      : "file";
export function validAttachmentInfo(value: unknown): value is AttachmentInfo {
  if (!value || typeof value !== "object") return false;
  const a = value as AttachmentInfo;
  return (
    typeof a.name === "string" &&
    a.name.length > 0 &&
    a.name.length <= 180 &&
    !/[\x00-\x1f\x7f/\\]/.test(a.name) &&
    typeof a.mimeType === "string" &&
    a.mimeType.length <= 120 &&
    /^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType) &&
    a.kind === attachmentKind(a.mimeType) &&
    Number.isInteger(a.size) &&
    a.size > 0 &&
    a.size <= MAX_ATTACHMENT_BYTES
  );
}
const encodedLength = (size: number) => 4 * Math.ceil(size / 3);
// Checks the envelope, not the picture: name, MIME, declared size and that the
// base64 decodes to exactly that many bytes. Nothing here decodes the image, so
// a file within the 10 MiB cap can still carry pathological dimensions and blow
// up the decoder that renders it.
export function validAttachment(value: unknown): value is ChatAttachment {
  if (!validAttachmentInfo(value)) return false;
  const a = value as ChatAttachment;
  return (
    typeof a.base64 === "string" &&
    a.base64.length === encodedLength(a.size) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(a.base64) &&
    (a.base64.length / 4) * 3 - (a.base64.endsWith("==") ? 2 : a.base64.endsWith("=") ? 1 : 0) ===
      a.size
  );
}
export const attachmentLabel = (a: AttachmentInfo) =>
  `${a.kind === "image" ? "Photo" : a.kind === "video" ? "Video" : "File"} · ${a.name}`;
export const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
export function attachmentPayloads(chat: {
  messageId: string;
  attachment?: ChatAttachment;
  [key: string]: unknown;
}): string[] {
  if (!chat.attachment) return [JSON.stringify({ type: "chat", ...chat })];
  const { base64, ...info } = chat.attachment;
  const payloads = [JSON.stringify({ type: "chat", ...chat, attachment: info })];
  for (let start = 0; start < base64.length; start += ATTACHMENT_CHUNK_LENGTH)
    payloads.push(
      JSON.stringify({
        type: "attachment-chunk",
        messageId: chat.messageId,
        index: start / ATTACHMENT_CHUNK_LENGTH,
        data: base64.slice(start, start + ATTACHMENT_CHUNK_LENGTH),
      }),
    );
  return payloads;
}
export function acceptAttachmentChunk(
  info: ChatAttachment,
  parts: Record<string, string>,
  chunk: AttachmentChunk,
): { attachment: ChatAttachment; parts?: Record<string, string> } | null {
  if (info.base64 || !Number.isInteger(chunk.index) || chunk.index < 0) return null;
  const length = encodedLength(info.size),
    count = Math.ceil(length / ATTACHMENT_CHUNK_LENGTH);
  if (
    chunk.index >= count ||
    typeof chunk.data !== "string" ||
    chunk.data.length !==
      Math.min(ATTACHMENT_CHUNK_LENGTH, length - chunk.index * ATTACHMENT_CHUNK_LENGTH) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.data) ||
    (chunk.index < count - 1 && chunk.data.includes("=")) ||
    parts[chunk.index] !== undefined
  )
    return null;
  const next: Record<string, string> = { ...parts, [chunk.index]: chunk.data };
  if (Object.keys(next).length < count) return { attachment: info, parts: next };
  const attachment = {
    ...info,
    base64: Array.from({ length: count }, (_, index) => next[index]).join(""),
  };
  return validAttachment(attachment) ? { attachment } : null;
}
