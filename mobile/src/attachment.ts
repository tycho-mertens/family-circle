export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_CHUNK_LENGTH = 128 * 1024; // base64, divisible by four
// 16M RGBA pixels require at most 64 MiB for one decoded frame. The separate
// side limit also rejects extremely narrow images that some decoders allocate
// inefficiently. Outgoing photos are already resized to at most 1600px.
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 8192;
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

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const decodeBase64 = (value: string) => {
  const bytes = new Uint8Array(
    (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0),
  );
  let output = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64_CHARS.indexOf(value[index]);
    const b = BASE64_CHARS.indexOf(value[index + 1]);
    const c = value[index + 2] === "=" ? 0 : BASE64_CHARS.indexOf(value[index + 2]);
    const d = value[index + 3] === "=" ? 0 : BASE64_CHARS.indexOf(value[index + 3]);
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (output < bytes.length) bytes[output++] = bits >> 16;
    if (output < bytes.length) bytes[output++] = (bits >> 8) & 0xff;
    if (output < bytes.length) bytes[output++] = bits & 0xff;
  }
  return bytes;
};
const be16 = (b: Uint8Array, at: number) => b[at] * 256 + b[at + 1];
const be32 = (b: Uint8Array, at: number) =>
  b[at] * 0x1000000 + b[at + 1] * 0x10000 + b[at + 2] * 0x100 + b[at + 3];
const le16 = (b: Uint8Array, at: number) => b[at] + b[at + 1] * 256;
const le24 = (b: Uint8Array, at: number) => b[at] + b[at + 1] * 256 + b[at + 2] * 65536;
const le32 = (b: Uint8Array, at: number) =>
  b[at] + b[at + 1] * 256 + b[at + 2] * 65536 + b[at + 3] * 0x1000000;
const textAt = (b: Uint8Array, at: number, text: string) =>
  at + text.length <= b.length &&
  Array.from(text).every((character, index) => b[at + index] === character.charCodeAt(0));

function jpegDimensions(bytes: Uint8Array): [number, number] | null {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  )
    return null;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let at = 2;
  while (at < bytes.length) {
    while (at < bytes.length && bytes[at] === 0xff) at++;
    if (at >= bytes.length) return null;
    const marker = bytes[at++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) return null;
    const length = be16(bytes, at);
    if (length < 2 || at + length > bytes.length) return null;
    if (startOfFrame.has(marker))
      return length >= 7 ? [be16(bytes, at + 5), be16(bytes, at + 3)] : null;
    at += length;
  }
  return null;
}

function pngDimensions(bytes: Uint8Array): [number, number] | null {
  if (
    bytes.length < 45 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
    be32(bytes, 8) !== 13 ||
    !textAt(bytes, 12, "IHDR")
  )
    return null;
  const dimensions: [number, number] = [be32(bytes, 16), be32(bytes, 20)];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = be32(bytes, at);
    if (length > bytes.length - at - 12) return null;
    const end = at + 12 + length;
    if (textAt(bytes, at + 4, "IEND")) return length === 0 && end === bytes.length ? dimensions : null;
    at = end;
  }
  return null;
}

const skipGifBlocks = (bytes: Uint8Array, start: number) => {
  let at = start;
  while (at < bytes.length) {
    const length = bytes[at++];
    if (length === 0) return at;
    if (length > bytes.length - at) return -1;
    at += length;
  }
  return -1;
};
function gifDimensions(bytes: Uint8Array): [number, number] | null {
  if (
    bytes.length < 14 ||
    (!textAt(bytes, 0, "GIF87a") && !textAt(bytes, 0, "GIF89a"))
  )
    return null;
  const dimensions: [number, number] = [le16(bytes, 6), le16(bytes, 8)];
  let at = 13;
  if (bytes[10] & 0x80) at += 3 * 2 ** ((bytes[10] & 0x07) + 1);
  let foundImage = false;
  while (at < bytes.length) {
    const marker = bytes[at++];
    if (marker === 0x3b) return foundImage && at === bytes.length ? dimensions : null;
    if (marker === 0x21) {
      if (at >= bytes.length) return null;
      at = skipGifBlocks(bytes, at + 1);
    } else if (marker === 0x2c) {
      if (at + 9 > bytes.length) return null;
      const flags = bytes[at + 8];
      at += 9;
      if (flags & 0x80) at += 3 * 2 ** ((flags & 0x07) + 1);
      if (at >= bytes.length) return null;
      at = skipGifBlocks(bytes, at + 1);
      foundImage = true;
    } else return null;
    if (at < 0) return null;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): [number, number] | null {
  if (
    bytes.length < 20 ||
    !textAt(bytes, 0, "RIFF") ||
    !textAt(bytes, 8, "WEBP") ||
    le32(bytes, 4) + 8 !== bytes.length
  )
    return null;
  let at = 12;
  let canvas: [number, number] | null = null;
  while (at + 8 <= bytes.length) {
    const size = le32(bytes, at + 4);
    const data = at + 8;
    if (size > bytes.length - data) return null;
    if (textAt(bytes, at, "VP8X") && size >= 10)
      canvas = [le24(bytes, data + 4) + 1, le24(bytes, data + 7) + 1];
    if (
      textAt(bytes, at, "VP8 ") &&
      size >= 10 &&
      bytes[data + 3] === 0x9d &&
      bytes[data + 4] === 0x01 &&
      bytes[data + 5] === 0x2a
    )
      return canvas ?? [le16(bytes, data + 6) & 0x3fff, le16(bytes, data + 8) & 0x3fff];
    if (textAt(bytes, at, "VP8L") && size >= 5 && bytes[data] === 0x2f)
      return canvas ?? [
        1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8),
        1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 0x0f) << 10),
      ];
    at = data + size + (size & 1);
  }
  return null;
}

export function imageDimensions(base64: string, mimeType: string): [number, number] | null {
  const bytes = decodeBase64(base64);
  if (mimeType === "image/png") return pngDimensions(bytes);
  if (mimeType === "image/gif") return gifDimensions(bytes);
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  if (mimeType === "image/webp") return webpDimensions(bytes);
  return null;
}

export function validImageDimensions(base64: string, mimeType: string) {
  const dimensions = imageDimensions(base64, mimeType);
  if (!dimensions) return false;
  const [width, height] = dimensions;
  return (
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

export function validAttachment(value: unknown): value is ChatAttachment {
  if (!validAttachmentInfo(value)) return false;
  const a = value as ChatAttachment;
  const validEnvelope =
    typeof a.base64 === "string" &&
    a.base64.length === encodedLength(a.size) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(a.base64) &&
    (a.base64.length / 4) * 3 - (a.base64.endsWith("==") ? 2 : a.base64.endsWith("=") ? 1 : 0) ===
      a.size;
  return validEnvelope && (a.kind !== "image" || validImageDimensions(a.base64, a.mimeType));
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
