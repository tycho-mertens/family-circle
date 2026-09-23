import { cleanProfilePhotos } from "../profile-photo";
import type { BackupSnapshot, BackedUpCircle } from "./types";

export function encodeAppMetadata(snapshot: BackupSnapshot): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(snapshot));
}

export const EMPTY_SNAPSHOT: BackupSnapshot = { nicknames: {}, circles: [] };

export function decodeAppMetadata(bytes: Uint8Array): BackupSnapshot {
  if (bytes.length === 0) return EMPTY_SNAPSHOT;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.circles)) {
      const nicknames =
        parsed.nicknames && typeof parsed.nicknames === "object" ? parsed.nicknames : {};
      return {
        nicknames,
        profilePhotos: cleanProfilePhotos(parsed.profilePhotos),
        timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
        circles: parsed.circles as BackedUpCircle[],
        outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
      };
    }
    return EMPTY_SNAPSHOT;
  } catch {
    return EMPTY_SNAPSHOT; // Keep the identity usable even when app metadata cannot be decoded.
  }
}
