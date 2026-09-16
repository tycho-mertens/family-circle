// A voice message or recording takes audio focus from the previous message.
let current: (() => void) | null = null;
export function stopVoicePlayback() {
  const stop = current;
  current = null;
  stop?.();
}
export function claimVoicePlayback(stop: () => void) {
  stopVoicePlayback();
  current = stop;
}
export function releaseVoicePlayback(stop: () => void) {
  if (current === stop) current = null;
}
export function ownsVoicePlayback(stop: () => void) {
  return current === stop;
}
