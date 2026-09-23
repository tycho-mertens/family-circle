import { remainingAdmin } from "./circle-transitions";
import { base64ToBytes } from "../base64";
import type { MembershipChange } from "../persistence/types";
import type * as backup from "../backup";
import type { CircleInfo } from "./circle-types";

interface Dependencies {
  getCircle: (id: string) => CircleInfo | undefined;
  getDeviceId: () => string | null;
  patchCircle: (id: string, patch: Partial<CircleInfo>) => void;
  listMembers: (id: string) => Promise<string[]>;
  prepareMembershipChange: (
    id: string,
    keyPackage: Uint8Array,
    removals: string[],
  ) => Promise<{
    commitBytes: Uint8Array;
    welcomeBytes?: Uint8Array | null;
  }>;
  queueControl: (mailbox: string, kind: "commit", bytes: Uint8Array) => string;
  queueEnvelope: typeof backup.queueEnvelope;
  randomId: () => string;
  appendSystem: (id: string, text: string) => void;
  reportFailure: (operation: string, error: unknown) => void;
}

// Called within the runtime's state transaction: membership intent, commit,
// and dependent Welcome must share the same durable checkpoint.
export function createMembershipPublication({
  getCircle,
  getDeviceId,
  patchCircle,
  listMembers,
  prepareMembershipChange,
  queueControl,
  queueEnvelope,
  randomId,
  appendSystem,
  reportFailure,
}: Dependencies) {
  // Return the refreshed roster so callers can compare it with the previous one.
  const refreshMembers = async (circleId: string): Promise<string[] | null> => {
    try {
      const members = await listMembers(circleId);
      const departingMembers = (getCircle(circleId)?.departingMembers ?? []).filter(
        (id) => members.includes(id),
      );
      const current = getCircle(circleId);
      if (!current) return members;
      const adminId = remainingAdmin(current, members, departingMembers, getDeviceId());
      const patch: Partial<CircleInfo> = {
        members,
        departingMembers,
        adminId,
        isAdmin: adminId === getDeviceId(),
      };
      if (current?.handover && !members.includes(current.handover.adminId))
        patch.handover = undefined;
      const me = getDeviceId();
      if (me && !members.includes(me)) {
        patch.role = "removed";
      }
      patchCircle(circleId, patch);
      return members;
    } catch (error) {
      reportFailure("Membership roster refresh", error);
      return null; // not fatal — the member list just won't update this tick
    }
  };

  const enqueueMembershipChange = (circleId: string, change: MembershipChange) => {
    const current = getCircle(circleId);
    if (!current) return;
    const changes = current.membershipChanges ?? [];
    if (!changes.some((item) => JSON.stringify(item) === JSON.stringify(change))) {
      patchCircle(circleId, { membershipChanges: [...changes, change] });
    }
  };

  const stageNextMembershipChange = async (circleId: string) => {
    const current = getCircle(circleId);
    if (!current) return;
    const changes = [...(current.membershipChanges ?? [])];
    // A second approved removal may already have been fulfilled by a leave.
    while (
      changes[0]?.type === "remove" &&
      !current.members.includes(changes[0].memberId)
    )
      changes.shift();
    const change = changes.shift();
    if (!change) {
      patchCircle(circleId, { membershipChanges: [] });
      return;
    }
    const keyPackage =
      change.type === "add" || change.type === "rejoin"
        ? base64ToBytes(change.keyPackage)
        : new Uint8Array();
    const removals =
      (change.type === "remove" || change.type === "rejoin") &&
      current.members.includes(change.memberId)
        ? [change.memberId]
        : [];
    const prepared = await prepareMembershipChange(circleId, keyPackage, removals);
    const eventId = queueControl(current.mailboxId, "commit", prepared.commitBytes);
    if (prepared.welcomeBytes) {
      queueEnvelope(current.mailboxId, {
        eventId: randomId(),
        kind: "welcome",
        epoch: 0,
        nonce: new Uint8Array([0]),
        ciphertext: prepared.welcomeBytes,
        commitEventId: eventId,
      });
    }
    patchCircle(circleId, { membershipChanges: changes, pendingCommitEventId: eventId });
  };

  const refreshConnection = async (circleId: string) => {
    const circle = getCircle(circleId);
    if (!circle?.isAdmin || circle.role !== "member" || circle.syncError) return;
    enqueueMembershipChange(circleId, { type: "refresh" });
    appendSystem(
      circleId,
      "Connection key refresh requested — waiting for confirmation.",
    );
  };

  return {
    refreshMembers,
    enqueueMembershipChange,
    stageNextMembershipChange,
    refreshConnection,
  };
}
