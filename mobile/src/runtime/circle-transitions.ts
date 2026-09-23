import type { CircleInfo } from "./circle-types";

type CircleTransition =
  | { type: "joined" }
  | { type: "commit-confirmed" }
  | { type: "rejoin-requested"; authorityAdminId?: string }
  | { type: "leave-requested"; departingMembers: string[]; adminId?: string }
  | { type: "handover-started"; id: string; adminId: string }
  | { type: "admin-changed"; adminId: string };

/** Keep fields that describe one lifecycle change together in the same checkpoint. */
export function circleTransition(
  current: CircleInfo,
  event: CircleTransition,
  deviceId: string | null,
): Partial<CircleInfo> {
  switch (event.type) {
    case "joined":
      // A delayed Welcome must not cancel an already requested departure.
      return {
        role: "member",
        recoveryRequired: false,
        syncError: undefined,
        joinNonce: undefined,
        joinRequestedAt: undefined,
        adminId: current.authorityAdminId ?? current.adminId,
        isAdmin: (current.authorityAdminId ?? current.adminId) === deviceId,
        authorityAdminId: undefined,
        membershipAuthority: current.authorityAdminId ? "v1" : undefined,
        awaitingAdminAnnouncement: !current.authorityAdminId,
      };
    case "commit-confirmed":
      return { recoveryRequired: false, pendingCommitEventId: undefined };
    case "rejoin-requested":
      return {
        recoveryRequired: true,
        syncError: undefined,
        authorityAdminId: event.authorityAdminId,
      };
    case "leave-requested":
      return {
        deleting: true,
        pendingChats: [],
        pendingBroadcasts: [],
        membershipChanges: [],
        departingMembers: event.departingMembers,
        adminId: event.adminId,
        isAdmin: event.adminId === deviceId,
      };
    case "handover-started":
      return {
        handover: { id: event.id, adminId: event.adminId },
        adminId: event.adminId,
        isAdmin: false,
      };
    case "admin-changed":
      return { adminId: event.adminId, isAdmin: event.adminId === deviceId };
  }
}

/** Retain the admin while present; otherwise choose the first remaining member. */
export function remainingAdmin(
  current: CircleInfo,
  members: string[],
  departingMembers: string[],
  deviceId: string | null,
): string | undefined {
  const previous = current.adminId ?? (current.isAdmin ? deviceId : members[0]);
  if (previous && members.includes(previous) && !departingMembers.includes(previous))
    return previous;
  return members.find((id) => !departingMembers.includes(id)) ?? members.at(-1);
}
