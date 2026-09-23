import type { ChatAttachment } from "../attachment";
import type { MessageReply } from "../message-reply";
import type { VoiceMessage } from "../voice-message";
import type { EnvelopeKind } from "../relay";

/**
 * App state for one Circle, alongside the MLS state held by crypto-core.
 * `CircleInfo` in `src/runtime/circle-types.ts` uses these fields at runtime.
 * Commit `lastSeenSequenceId` with MLS state so a restart resumes from the
 * matching position in the mailbox.
 */
export interface BackedUpCircle {
  circleId: string;
  mailboxId: string;
  // Legacy checkpoint name for the current admin; runtime code uses isAdmin.
  isCreator: boolean;
  invite?: {
    nonce: string;
    qrNonce?: string;
    expiresAt: number;
    used: boolean;
    adminId?: string;
  };
  lastSeenSequenceId?: number;
  // Broadcast as a "circle-rename" AppPayload by src/runtime/profile-actions.ts.
  // Absent until someone names the Circle.
  circleName?: string;
  role?: "joining" | "member" | "removed";
  joinNonce?: string;
  joinRequestedAt?: number;
  ownEventIds?: string[];
  processedKeyPackageIds?: string[];
  triedWelcomeIds?: string[];
  processedLeaveIds?: string[];
  processedRejoinRequestIds?: string[];
  pendingRejoinKeyPackages?: [string, string][];
  pendingJoinKeyPackages?: [string, string][];
  pendingJoinRequestNames?: [string, string][];
  pendingJoinRequestMemberIds?: [string, string][];
  blockedAutoJoinIds?: string[];
  awaitingRejoinNonce?: string;
  recoveryRequired?: boolean;
  syncError?: string;
  pendingChats?: (
    | string
    | {
        messageId: string;
        text: string;
        voice?: VoiceMessage;
        attachment?: ChatAttachment;
        replyTo?: MessageReply;
        sentAt?: number;
      }
  )[];
  pendingBroadcasts?: string[];
  membershipChanges?: MembershipChange[];
  pendingCommitEventId?: string;
  adminId?: string;
  authorityAdminId?: string;
  membershipAuthority?: "v1";
  deleting?: boolean;
  leaveEpoch?: number;
  departingMembers?: string[];
  members?: string[];
  notifications?: CircleNotifications;
  lastSuccessfulSync?: number;
  departureConfirmedAt?: number;
  awaitingAdminAnnouncement?: boolean;
  handover?: { id: string; adminId: string; eventId?: string; confirmed?: boolean };
}

export interface CircleNotifications {
  chat: boolean;
  location: boolean;
  quietHours: boolean;
  quietStart: string;
  quietEnd: string;
}

export type MembershipChange =
  | { type: "refresh" }
  | { type: "remove"; memberId: string }
  | { type: "add"; keyPackage: string }
  | { type: "rejoin"; memberId: string; keyPackage: string };

/** Local timeline entry. Recovery uploads exclude this history. */
export interface SavedChatItem {
  id: string;
  circleId: string;
  kind: "chat" | "system";
  text: string;
  voice?: VoiceMessage;
  attachment?: ChatAttachment;
  attachmentParts?: Record<string, string>;
  replyTo?: MessageReply;
  senderId?: string;
  at: number;
  sentAt?: number;
  editedAt?: number;
  originalText?: string;
  deletedAt?: number;
  messageId?: string;
  delivery?: "waiting" | "sent" | "delivered";
  recipients?: string[];
  deliveredTo?: string[];
  reactions?: Record<string, string>; // Authenticated member ID -> one emoji.
}

export interface BackupSnapshot {
  timeline?: SavedChatItem[];
  nicknames: Record<string, string>;
  profilePhotos?: Record<string, string | null>;
  circles: BackedUpCircle[];
  outbox?: OutboxEntry[];
}

export interface ResumedIdentity {
  timeline?: SavedChatItem[];
  deviceId: string;
  circles: BackedUpCircle[];
  nicknames: Record<string, string>;
  profilePhotos?: Record<string, string | null>;
}

export interface OutboxEntry {
  mailboxId: string;
  eventId: string;
  epoch: number;
  kind: EnvelopeKind;
  nonce: string;
  ciphertext: string;
  expectedSequenceId?: number;
  plaintext?: string; // Only inside the encrypted local checkpoint, never sent to the relay.
  needsSync?: boolean;
  commitEventId?: string; // The prepared commit associated with a Welcome.
}
