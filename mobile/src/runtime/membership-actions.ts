import { circleTransition, remainingAdmin } from "./circle-transitions";
import { departureAction, canTransferAdmin } from "./circle-lifecycle";
import type { Timeline } from "./timeline";
import * as backup from "../backup";
import * as bridge from "../bridge";
import { command } from "../location";
import * as relay from "../relay";
import { DEVICE_SLOT } from "./circle-constants";
import { displayMember, type AppPayload, type CircleInfo } from "./circle-types";
import { type IdentityContextValue } from "./identity";
import { locationChanges } from "./location-events";
import { RuntimeChanges } from "./observable";

interface Dependencies {
  getCircle: (circleId: string) => CircleInfo | undefined;
  patchCircle: (circleId: string, patch: Partial<CircleInfo>) => void;
  enqueueMembershipChange: (circleId: string, change: backup.MembershipChange) => void;
  appendSystem: (circleId: string, text: string) => void;
  identity: Pick<IdentityContextValue, "deviceIdRef" | "nicknamesRef">;
  timeline: Pick<Timeline, "removeCircle">;
  forgetCircle: (circleId: string) => void;
  changes: RuntimeChanges;
  setNotice: (value: string | null) => void;
  broadcastToCircle: (circleId: string, payload: AppPayload) => Promise<void>;
}

export function createMembershipActions({
  getCircle,
  patchCircle,
  enqueueMembershipChange,
  appendSystem,
  identity,
  timeline,
  forgetCircle,
  changes,
  setNotice,
  broadcastToCircle,
}: Dependencies) {
  const removeMember = async (circleId: string, memberId: string) => {
    const active = getCircle(circleId);
    if (
      !active?.isAdmin ||
      active.deleting ||
      active.role !== "member" ||
      active.membershipAuthority !== "v1"
    )
      return;
    patchCircle(circleId, {
      blockedAutoJoinIds: [...new Set([...(active.blockedAutoJoinIds ?? []), memberId])],
    });
    enqueueMembershipChange(circleId, { type: "remove", memberId });
    appendSystem(
      circleId,
      `Removal requested for ${displayMember(memberId, identity.nicknamesRef.current)} — waiting for confirmation.`,
    );
  };

  const eraseCircle = async (circleId: string): Promise<boolean> => {
    const active = getCircle(circleId);
    if (!active) return true;
    // Idempotent even for pending joins without an MLS group. The native
    // removal also queues a location stop and erases the Circle's pins.
    await bridge.forgetCircle(DEVICE_SLOT, circleId);
    backup.discardMailboxOutbox(active.mailboxId);
    timeline.removeCircle(circleId);
    forgetCircle(circleId);
    backup.afterStateCommit(() => {
      changes.emit();
      locationChanges.emit();
    });
    return true;
  };

  const deleteCircle = async (circleId: string): Promise<boolean> => {
    const current = getCircle(circleId);
    const action = departureAction(current);
    if (!current || action === "none") return true;
    if (action === "erase") return eraseCircle(circleId);
    if (action === "handover") {
      setNotice(
        "Choose a new admin in Circle settings and wait for their phone to confirm before leaving.",
      );
      return false;
    }
    await command({ op: "stop", circleId });
    // Keep prepared commits and join requests: they may already have reached
    // peers. Drop unsent chat, but preserve protocol data needed to leave.
    backup.discardMailboxApplications(current.mailboxId);
    timeline.removeCircle(circleId);
    const departingMembers = [
      ...new Set([...(current.departingMembers ?? []), identity.deviceIdRef.current!]),
    ];
    const successor = remainingAdmin(
      current,
      current.members,
      departingMembers,
      identity.deviceIdRef.current,
    );
    patchCircle(
      circleId,
      circleTransition(
        current,
        {
          type: "leave-requested",
          departingMembers,
          adminId: successor,
        },
        identity.deviceIdRef.current,
      ),
    );
    backup.afterStateCommit(() => {
      changes.emit();
      locationChanges.emit();
    });
    setNotice(
      "Leaving requested. Other members must reconnect to confirm your departure.",
    );
    return true;
  };

  const leaveCircle = deleteCircle;

  const transferAdmin = async (circleId: string, memberId: string) => {
    const current = getCircle(circleId);
    if (!current || !canTransferAdmin(current)) return;
    if (
      memberId === identity.deviceIdRef.current ||
      !current.members.includes(memberId) ||
      current.departingMembers?.includes(memberId)
    )
      return;
    const id = relay.randomId();
    const me = identity.deviceIdRef.current;
    if (!me) return;
    // Commit this policy transition before queuing its MLS-authenticated
    // application message. A crash/retry can delay delivery, but cannot let
    // the former admin create another membership commit in the meantime.
    await bridge.adoptMembershipAdmin(DEVICE_SLOT, circleId, me, memberId);
    patchCircle(
      circleId,
      circleTransition(current, { type: "handover-started", id, adminId: memberId }, me),
    );
    await broadcastToCircle(circleId, { type: "admin-transfer", id, adminId: memberId });
  };

  return { removeMember, eraseCircle, deleteCircle, leaveCircle, transferAdmin };
}
