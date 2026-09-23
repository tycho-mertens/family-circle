import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const {
  validAttachment,
  validAttachmentInfo,
  attachmentPayloads,
  acceptAttachmentChunk,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
} = await loadTypeScriptModule("src/attachment.ts");
const attachment = {
  name: "sample.bin",
  mimeType: "application/octet-stream",
  kind: "file",
  size: 220000,
  base64: Buffer.alloc(220000, 42).toString("base64"),
};
test("large attachments round-trip as bounded chunks in either order, without bytes in metadata", () => {
  assert.equal(validAttachment(attachment), true);
  const payloads = Array.from(attachmentPayloads({ messageId: "id", attachment }), JSON.parse);
  assert.equal(payloads[0].attachment.base64, undefined);
  assert.equal(payloads.length, 4);
  assert.ok(payloads.every((p) => Buffer.byteLength(JSON.stringify(p)) < 256 * 1024));
  for (const chunks of [payloads.slice(1), payloads.slice(1).reverse()]) {
    let state = { attachment: { ...payloads[0].attachment, base64: "" }, parts: {} };
    for (const chunk of chunks)
      state = acceptAttachmentChunk(state.attachment, state.parts ?? {}, chunk);
    assert.equal(state.attachment.base64, attachment.base64);
    assert.equal(state.parts, undefined);
  }
});
test("invalid sizes, paths, types and encoded data are rejected", () => {
  for (const patch of [
    { name: "../secret" },
    { name: "bad\\name" },
    { size: MAX_ATTACHMENT_BYTES + 1 },
    { size: 0 },
    { size: 1.5 },
    { kind: "image" },
    { mimeType: "text/html\n" },
    { base64: "https://x.test" },
    { base64: attachment.base64 + "AAAA" },
  ])
    assert.equal(validAttachment({ ...attachment, ...patch }), false);
  assert.equal(validAttachmentInfo({ ...attachment, base64: undefined }), true);
});
test("duplicate and malformed chunks cannot change completed data or create gaps", () => {
  const chunks = Array.from(attachmentPayloads({ messageId: "id", attachment }), JSON.parse).slice(
    1,
  );
  const incoming = { ...attachment, base64: "" };
  for (const patch of [
    { index: -1 },
    { index: NaN },
    { index: 1000000 },
    { index: 0.5 },
    { data: "bad" },
    { data: chunks[0].data + "AAAA" },
  ])
    assert.equal(acceptAttachmentChunk(incoming, {}, { ...chunks[0], ...patch }), null);
  const first = acceptAttachmentChunk(incoming, {}, chunks[0]);
  assert.equal(acceptAttachmentChunk(first.attachment, first.parts, chunks[0]), null);
  assert.equal(acceptAttachmentChunk(attachment, {}, chunks[0]), null);
});

const imageAttachment = (mimeType, bytes) => ({
  name: "photo." + mimeType.split("/")[1],
  mimeType,
  kind: "image",
  size: bytes.length,
  base64: Buffer.from(bytes).toString("base64"),
});
const png = (width, height) => {
  const bytes = Buffer.alloc(45);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.write("IEND", 37, "ascii");
  return bytes;
};
const gif = (width, height) => {
  const bytes = Buffer.alloc(29);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  bytes[13] = 0x2c;
  bytes.writeUInt16LE(width, 18);
  bytes.writeUInt16LE(height, 20);
  bytes[23] = 2;
  bytes[24] = 2;
  bytes[25] = 0x4c;
  bytes[26] = 0x01;
  bytes[28] = 0x3b;
  return bytes;
};
const jpeg = (width, height) =>
  Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
const webp = (width, height) => {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBPVP8X", 8, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  bytes.write("VP8 ", 30, "ascii");
  bytes.writeUInt32LE(10, 34);
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a], 38);
  bytes.writeUInt16LE(width, 44);
  bytes.writeUInt16LE(height, 46);
  return bytes;
};
test("received images must have bounded decoded dimensions and a matching valid header", () => {
  assert.equal(validAttachment(imageAttachment("image/png", png(1600, 1200))), true);
  assert.equal(validAttachment(imageAttachment("image/gif", gif(320, 240))), true);
  assert.equal(validAttachment(imageAttachment("image/jpeg", jpeg(1600, 1200))), true);
  assert.equal(validAttachment(imageAttachment("image/webp", webp(1600, 1200))), true);
  assert.equal(
    validAttachment(imageAttachment("image/png", png(MAX_IMAGE_DIMENSION + 1, 1))),
    false,
  );
  assert.equal(
    validAttachment(imageAttachment("image/png", png(4097, Math.floor(MAX_IMAGE_PIXELS / 4097) + 1))),
    false,
  );
  assert.equal(
    validAttachment(imageAttachment("image/jpeg", jpeg(MAX_IMAGE_DIMENSION + 1, 1))),
    false,
  );
  assert.equal(
    validAttachment(
      imageAttachment("image/webp", webp(4097, Math.floor(MAX_IMAGE_PIXELS / 4097) + 1)),
    ),
    false,
  );
  assert.equal(validAttachment(imageAttachment("image/png", Buffer.from("not an image"))), false);
  assert.equal(validAttachment(imageAttachment("image/png", png(100, 100).subarray(0, 24))), false);
  assert.equal(validAttachment(imageAttachment("image/jpeg", jpeg(100, 100).subarray(0, 21))), false);
  assert.equal(validAttachment(imageAttachment("image/jpeg", png(100, 100))), false);

  const oversized = imageAttachment("image/png", png(MAX_IMAGE_DIMENSION + 1, 1));
  const { base64, ...info } = oversized;
  assert.equal(
    acceptAttachmentChunk(
      { ...info, base64: "" },
      {},
      { type: "attachment-chunk", messageId: "image", index: 0, data: base64 },
    ),
    null,
  );
});
