export interface VoiceMessage {
  mimeType: "audio/mp4";
  base64: string;
  durationMs: number;
}
export const MAX_VOICE_DURATION_MS = 60_000;
// Leaves ample room for JSON and MLS overhead below the relay's 256 KiB limit.
export const MAX_VOICE_BASE64_LENGTH = 192 * 1024;
export function validVoiceMessage(value: unknown): value is VoiceMessage {
  if (!value || typeof value !== "object") return false;
  const voice = value as VoiceMessage;
  return (
    voice.mimeType === "audio/mp4" &&
    Number.isFinite(voice.durationMs) &&
    voice.durationMs >= 500 &&
    voice.durationMs <= MAX_VOICE_DURATION_MS &&
    typeof voice.base64 === "string" &&
    voice.base64.length >= 16 &&
    voice.base64.length <= MAX_VOICE_BASE64_LENGTH &&
    voice.base64.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(voice.base64)
  );
}
export const voiceDuration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
export const voiceLabel = (voice: VoiceMessage) =>
  `Voice message · ${voiceDuration(voice.durationMs)}`;
