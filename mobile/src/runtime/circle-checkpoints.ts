import { ref } from "./observable";
import * as backup from "../backup";
import { base64ToBytes, bytesToBase64 } from "../base64";
import { type CircleInfo } from "./circle-types";

interface Dependencies {
  getCircles: () => Record<string, CircleInfo>;
  replaceCircles: (circles: Record<string, CircleInfo>) => void;
}

export function createCircleCheckpoints({ getCircles, replaceCircles }: Dependencies) {
  // Per-circle polling bookkeeping that doesn't need to drive re-renders.
  const lastSeenSequenceId = ref<Map<string, number>>(new Map());
  const myOwnEventIds = ref<Map<string, Set<string>>>(new Map());
  const processedKeyPackageIds = ref<Map<string, Set<string>>>(new Map());
  const triedWelcomeIds = ref<Map<string, Set<string>>>(new Map());
  const processedLeaveIds = ref<Map<string, Set<string>>>(new Map());
  const processedRejoinRequestIds = ref<Map<string, Set<string>>>(new Map());
  const pendingRejoinKeyPackages = ref<Map<string, Map<string, Uint8Array>>>(new Map());
  const pendingJoinKeyPackages = ref<Map<string, Map<string, Uint8Array>>>(new Map());
  const awaitingRejoinWelcome = ref<Set<string>>(new Set());
  const awaitingRejoinNonce = ref<Map<string, string>>(new Map());
  const toBackedUpCircles = (all: Record<string, CircleInfo>): backup.BackedUpCircle[] =>
    Object.values(all).map((circle) => ({
      circleId: circle.circleId,
      mailboxId: circle.mailboxId,
      isCreator: circle.isAdmin,
      invite: circle.invite,
      circleName: circle.circleName,
      lastSeenSequenceId: lastSeenSequenceId.current.get(circle.circleId),
      pendingChats: circle.pendingChats,
      members: circle.members,
      notifications: circle.notifications,
      lastSuccessfulSync: circle.lastSuccessfulSync,
      departureConfirmedAt: circle.departureConfirmedAt,
      handover: circle.handover,
      awaitingAdminAnnouncement: circle.awaitingAdminAnnouncement,
      pendingBroadcasts: circle.pendingBroadcasts,
      membershipChanges: circle.membershipChanges,
      pendingCommitEventId: circle.pendingCommitEventId,
      adminId: circle.adminId,
      authorityAdminId: circle.authorityAdminId,
      membershipAuthority: circle.membershipAuthority,
      deleting: circle.deleting,
      leaveEpoch: circle.leaveEpoch,
      departingMembers: circle.departingMembers,
      role: circle.role,
      joinNonce: circle.joinNonce,
      joinRequestedAt: circle.joinRequestedAt,
      recoveryRequired: circle.recoveryRequired,
      syncError: circle.syncError,
      ownEventIds: [...bucket(myOwnEventIds.current, circle.circleId)],
      processedKeyPackageIds: [
        ...bucket(processedKeyPackageIds.current, circle.circleId),
      ],
      triedWelcomeIds: [...bucket(triedWelcomeIds.current, circle.circleId)],
      processedLeaveIds: [...bucket(processedLeaveIds.current, circle.circleId)],
      processedRejoinRequestIds: [
        ...bucket(processedRejoinRequestIds.current, circle.circleId),
      ],
      pendingRejoinKeyPackages: [
        ...(pendingRejoinKeyPackages.current.get(circle.circleId) ?? []),
      ].map(([id, bytes]): [string, string] => [id, bytesToBase64(bytes)]),
      pendingJoinKeyPackages: [
        ...(pendingJoinKeyPackages.current.get(circle.circleId) ?? []),
      ].map(([id, bytes]): [string, string] => [id, bytesToBase64(bytes)]),
      pendingJoinRequestNames: Object.entries(circle.pendingJoinRequestNames ?? {}),
      pendingJoinRequestMemberIds: Object.entries(
        circle.pendingJoinRequestMemberIds ?? {},
      ),
      blockedAutoJoinIds: circle.blockedAutoJoinIds,
      awaitingRejoinNonce: awaitingRejoinNonce.current.get(circle.circleId),
    }));
  const restoreCircles = (seed: backup.BackedUpCircle[]) => {
    const restored: Record<string, CircleInfo> = {};
    for (const map of [
      lastSeenSequenceId,
      myOwnEventIds,
      processedKeyPackageIds,
      triedWelcomeIds,
      processedLeaveIds,
      processedRejoinRequestIds,
      pendingRejoinKeyPackages,
      pendingJoinKeyPackages,
      awaitingRejoinNonce,
    ])
      map.current.clear();
    awaitingRejoinWelcome.current.clear();
    for (const circle of seed) {
      const { isCreator, ...fields } = circle;
      restored[circle.circleId] = {
        ...fields,
        isAdmin: isCreator,
        role: circle.role ?? "member",
        members: circle.members ?? getCircles()[circle.circleId]?.members ?? [],
        pendingRejoinRequests: (circle.pendingRejoinKeyPackages ?? []).map(([id]) => id),
        pendingJoinRequests: (circle.pendingJoinKeyPackages ?? []).map(([id]) => id),
        pendingJoinRequestNames: Object.fromEntries(circle.pendingJoinRequestNames ?? []),
        pendingJoinRequestMemberIds: Object.fromEntries(
          circle.pendingJoinRequestMemberIds ?? [],
        ),
      };
      lastSeenSequenceId.current.set(circle.circleId, circle.lastSeenSequenceId ?? 0);
      myOwnEventIds.current.set(circle.circleId, new Set(circle.ownEventIds));
      processedKeyPackageIds.current.set(
        circle.circleId,
        new Set(circle.processedKeyPackageIds),
      );
      triedWelcomeIds.current.set(circle.circleId, new Set(circle.triedWelcomeIds));
      processedLeaveIds.current.set(circle.circleId, new Set(circle.processedLeaveIds));
      processedRejoinRequestIds.current.set(
        circle.circleId,
        new Set(circle.processedRejoinRequestIds),
      );
      pendingRejoinKeyPackages.current.set(
        circle.circleId,
        new Map(
          (circle.pendingRejoinKeyPackages ?? []).map(([id, bytes]) => [
            id,
            base64ToBytes(bytes),
          ]),
        ),
      );
      pendingJoinKeyPackages.current.set(
        circle.circleId,
        new Map(
          (circle.pendingJoinKeyPackages ?? []).map(([id, bytes]) => [
            id,
            base64ToBytes(bytes),
          ]),
        ),
      );
      if (circle.awaitingRejoinNonce) {
        awaitingRejoinNonce.current.set(circle.circleId, circle.awaitingRejoinNonce);
        awaitingRejoinWelcome.current.add(circle.circleId);
      }
    }
    replaceCircles(restored);
  };

  const forget = (circleId: string) => {
    for (const map of [
      lastSeenSequenceId,
      myOwnEventIds,
      processedKeyPackageIds,
      triedWelcomeIds,
      processedLeaveIds,
      processedRejoinRequestIds,
      pendingRejoinKeyPackages,
      pendingJoinKeyPackages,
      awaitingRejoinNonce,
    ])
      map.current.delete(circleId);
    awaitingRejoinWelcome.current.delete(circleId);
  };

  return {
    forget,
    toBackedUpCircles,
    restoreCircles,
    lastSeenSequenceId,
    myOwnEventIds,
    processedKeyPackageIds,
    triedWelcomeIds,
    processedLeaveIds,
    processedRejoinRequestIds,
    pendingRejoinKeyPackages,
    pendingJoinKeyPackages,
    awaitingRejoinWelcome,
    awaitingRejoinNonce,
  };
}

export function bucket(map: Map<string, Set<string>>, circleId: string): Set<string> {
  let set = map.get(circleId);
  if (!set) {
    set = new Set();
    map.set(circleId, set);
  }
  return set;
}

export type CircleCheckpoints = ReturnType<typeof createCircleCheckpoints>;
