import * as SecureStore from "expo-secure-store";
import { base64ToBytes, bytesToBase64 } from "../base64";

const SESSION_KEY = "familycircle.backupSession";
interface Session {
  backupId: string;
  authKey: Uint8Array;
  encKey: Uint8Array;
}

// SecureStore keeps the credentials across launches; this cache lasts for one process.
let session: Session | null = null;

interface StoredSession {
  backupId: string;
  authKey: string; // base64
  encKey: string; // base64
}

export async function saveSession(next: Session): Promise<void> {
  session = next;
  const stored: StoredSession = {
    backupId: next.backupId,
    authKey: bytesToBase64(next.authKey),
    encKey: bytesToBase64(next.encKey),
  };
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(stored));
}

export async function loadSession(): Promise<Session | null> {
  if (session) return session;
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredSession;
    session = {
      backupId: stored.backupId,
      authKey: base64ToBytes(stored.authKey),
      encKey: base64ToBytes(stored.encKey),
    };
    return session;
  } catch {
    return null; // Treat unreadable credentials as a missing local session.
  }
}
