import type { AttachmentChunk, AttachmentInfo, ChatAttachment } from "../attachment";
import type * as backup from "../persistence/types";
import type { MessageChange } from "../message-actions";
import type { MessageReply } from "../message-reply";
import type { VoiceMessage } from "../voice-message";

export type Role = "joining" | "member" | "removed";

// Chat and profile updates share the encrypted application channel.
export type AppPayload =
  | MessageChange
  | AttachmentChunk
  | {
      type: "chat";
      text: string;
      messageId?: string;
      voice?: VoiceMessage;
      attachment?: AttachmentInfo;
      replyTo?: MessageReply;
      sentAt?: number;
    }
  | { type: "reaction"; messageId: string; authorId: string; emoji: string | null }
  | { type: "receipt"; messageId: string; recipientId: string }
  | { type: "admin-transfer"; id: string; adminId: string }
  | { type: "admin-ack"; id: string }
  | { type: "profile-photo"; photo: string | null }
  | { type: "nickname"; nickname: string }
  | { type: "circle-rename"; name: string }
  | { type: "circle-admin"; adminId: string };

export interface Invite {
  nonce: string;
  // A separate one-time bearer capability, included only in the QR form of
  // an invitation and carried inside the encrypted join request.
  qrNonce?: string;
  expiresAt: number;
  used: boolean;
  adminId?: string;
}

export interface CircleInfo {
  circleId: string;
  mailboxId: string;
  role: Role;
  isAdmin: boolean;
  members: string[];
  invite?: Invite; // only meaningful when isAdmin
  joinNonce?: string; // only meaningful when role === "joining" (this device's own request)
  joinRequestedAt?: number; // only meaningful when role === "joining"
  // Device IDs awaiting rejoin approval. Only the current admin
  // (isAdmin) can approve these requests.
  pendingRejoinRequests?: string[];
  // Previously removed devices need approval even with a valid invitation.
  // These opaque request IDs identify their encrypted join requests.
  // Associated KeyPackages stay in encrypted local state, not relay-visible
  // metadata.
  pendingJoinRequests?: string[];
  // The joining phone's self-reported name. Helps a human recognize the
  // request they are approving; it is not authenticated.
  pendingJoinRequestNames?: Record<string, string>;
  pendingJoinRequestMemberIds?: Record<string, string>;
  // Devices explicitly removed by the admin cannot use a later invite to
  // return automatically. Their next request is held for explicit approval.
  blockedAutoJoinIds?: string[];
  // Optional Circle display name, editable by the admin in the UI.
  circleName?: string;
  recoveryRequired?: boolean;
  syncError?: string;
  rejectedControl?: backup.BackedUpCircle["rejectedControl"];
  pendingSends?: number;
  pendingChats?: backup.BackedUpCircle["pendingChats"];
  pendingBroadcasts?: string[];
  membershipChanges?: backup.MembershipChange[];
  pendingCommitEventId?: string;
  adminId?: string;
  authorityAdminId?: string;
  membershipAuthority?: "v1";
  deleting?: boolean;
  leaveEpoch?: number;
  departingMembers?: string[];
  notifications?: backup.CircleNotifications;
  lastSuccessfulSync?: number;
  departureConfirmedAt?: number;
  awaitingAdminAnnouncement?: boolean;
  handover?: backup.BackedUpCircle["handover"];
}

export type TimelineItem = backup.SavedChatItem;

export const shortId = (id: string) => id.slice(0, 6);

/** Display the Circle name, falling back to a short ID. */
export const circleLabel = (c: Pick<CircleInfo, "circleId" | "circleName">) =>
  c.circleName ?? shortId(c.circleId);

/**
 * Use the supplied nickname map so UI and background callers can pass current state.
 * Full device IDs remain available in member settings for verification.
 */
export const displayMember = (id: string, nicknameMap: Record<string, string>) =>
  nicknameMap[id] ?? `Member ${shortId(id.replace(/^device-/, ""))}`;

export interface CirclesContextValue {
  pollNow: () => Promise<void>;
  circlesReady: boolean;
  circles: Record<string, CircleInfo>;
  timeline: TimelineItem[];
  notice: string | null;
  relayStatus: "checking" | "connected" | "unreachable";
  clearNotice: () => void;

  createCircle: () => Promise<string | null>;
  joinCircle: (pairingCode: string) => Promise<boolean>;
  regenerateInvite: (circleId: string) => Promise<void>;
  sendAttachment: (
    circleId: string,
    attachment: ChatAttachment,
    replyToItemId?: string,
  ) => Promise<boolean>;
  sendVoiceMessage: (
    circleId: string,
    voice: VoiceMessage,
    replyToItemId?: string,
  ) => Promise<boolean>;
  sendMessage: (circleId: string, text: string, replyToItemId?: string) => Promise<boolean>;
  editMessage: (circleId: string, itemId: string, text: string) => Promise<boolean>;
  deleteMessage: (circleId: string, itemId: string) => Promise<boolean>;
  reactToMessage: (circleId: string, itemId: string, emoji: string | null) => Promise<boolean>;
  removeMember: (circleId: string, memberId: string) => Promise<void>;
  leaveCircle: (circleId: string) => Promise<boolean>;
  deleteCircle: (circleId: string) => Promise<boolean>;
  requestRejoin: (circleId: string, pairingCode: string) => Promise<void>;
  approveRejoinRequest: (circleId: string, requesterId: string) => Promise<void>;
  approveJoinRequest: (circleId: string, requestId: string) => Promise<void>;
  refreshConnection: (circleId: string) => Promise<void>;
  setNickname: (nickname: string) => Promise<void>;
  setProfilePhoto: (photo: string | null) => Promise<boolean>;
  setCircleName: (circleId: string, name: string) => Promise<void>;
  setNotifications: (
    circleId: string,
    preferences: backup.CircleNotifications,
  ) => Promise<void>;
  transferAdmin: (circleId: string, memberId: string) => Promise<void>;
  dismissDeparture: (circleId: string) => Promise<void>;
}
