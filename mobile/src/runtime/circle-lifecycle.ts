import type { CircleInfo } from "./circle-types";

export type CircleLifecycle =
  | { status: "absent" | "joining" | "removed" | "leaving" | "departed" }
  | { status: "recovering"; reason: "keys" | "sync" }
  | { status: "member"; publication: "ready" | "pending" };

// Derived from the persisted fields so older checkpoints need no migration.
// Departure takes precedence over stale recovery and membership flags.
export function circleLifecycle(circle: CircleInfo | undefined): CircleLifecycle {
  if (!circle) return { status: "absent" };
  if (circle.departureConfirmedAt) return { status: "departed" };
  if (circle.deleting) return { status: "leaving" };
  if (circle.role !== "member") return { status: circle.role };
  if (circle.syncError) return { status: "recovering", reason: "sync" };
  if (circle.recoveryRequired) return { status: "recovering", reason: "keys" };
  return { status: "member", publication: circle.pendingCommitEventId ? "pending" : "ready" };
}

// Drafts can be saved while a membership commit is pending. Encryption waits
// until catch-up confirms the commit and the current epoch.
export const canWriteMessages = (circle: CircleInfo | undefined) =>
  circleLifecycle(circle).status === "member";

export type DepartureAction = "none" | "erase" | "handover" | "request";
export function departureAction(circle: CircleInfo | undefined): DepartureAction {
  if (!circle) return "none";
  const { status } = circleLifecycle(circle);
  if (status === "absent" || status === "leaving" || status === "departed") return "none";
  if (status === "joining" || status === "removed" || circle.members.length <= 1)
    return "erase";
  if (circle.isAdmin || (circle.handover && !circle.handover.confirmed)) return "handover";
  return "request";
}

export function canTransferAdmin(circle: CircleInfo | undefined): boolean {
  const lifecycle = circleLifecycle(circle);
  return (
    lifecycle.status === "member" &&
    lifecycle.publication === "ready" &&
    !!circle?.isAdmin &&
    circle.membershipAuthority === "v1" &&
    !(circle.handover && !circle.handover.confirmed)
  );
}
