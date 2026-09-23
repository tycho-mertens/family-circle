import { circleTransition } from "./circle-transitions";
import * as backup from "../backup";
import { bytesToBase64 } from "../base64";
import * as bridge from "../bridge";
import * as relay from "../relay";
import type { CircleCheckpoints } from "./circle-checkpoints";
import { bucket } from "./circle-checkpoints";
import { DEVICE_SLOT } from "./circle-constants";
import { displayMember, type CircleInfo, type Invite } from "./circle-types";
import { describeError, type IdentityContextValue } from "./identity";

interface Dependencies {
  checkpoints: CircleCheckpoints;
  identity: Pick<IdentityContextValue, "deviceIdRef" | "nicknamesRef">;
  freshInvite: () => Promise<Invite>;
  putCircle: (circle: CircleInfo) => void;
  refreshMembers: (circleId: string) => Promise<string[] | null>;
  appendSystem: (circleId: string, text: string) => void;
  setNotice: (value: string | null) => void;
  getCircle: (circleId: string) => CircleInfo | undefined;
  patchCircle: (circleId: string, patch: Partial<CircleInfo>) => void;
  eraseCircle: (circleId: string) => Promise<boolean>;
  queueControl: (
    mailboxId: string,
    kind: Exclude<relay.EnvelopeKind, "application">,
    ciphertext: Uint8Array,
    eventId?: string,
  ) => string;
  forgetCircle: (circleId: string) => void;
  enqueueMembershipChange: (circleId: string, change: backup.MembershipChange) => void;
}

export function createInvitationActions({
  checkpoints,
  identity,
  freshInvite,
  putCircle,
  refreshMembers,
  appendSystem,
  setNotice,
  getCircle,
  patchCircle,
  eraseCircle,
  queueControl,
  forgetCircle,
  enqueueMembershipChange,
}: Dependencies) {
  const {
    myOwnEventIds,
    pendingRejoinKeyPackages,
    pendingJoinKeyPackages,
    awaitingRejoinNonce,
    awaitingRejoinWelcome,
  } = checkpoints;

  const createCircle = async (): Promise<string | null> => {
    try {
      const adminId = identity.deviceIdRef.current;
      if (!adminId) throw new Error("Identity is unavailable.");
      const circle = await bridge.createCircle(DEVICE_SLOT);
      const mailboxId = await relay.registerMailbox();
      const invite = await freshInvite();
      putCircle({
        circleId: circle.circleId,
        mailboxId,
        role: "member",
        isAdmin: true,
        members: [],
        adminId,
        membershipAuthority: "v1",
        invite,
      });
      await refreshMembers(circle.circleId);
      appendSystem(circle.circleId, "You created this Circle");

      return circle.circleId;
    } catch (err) {
      setNotice(`Couldn't create a Circle: ${describeError(err)}`);
      return null;
    }
  };

  const regenerateInvite = async (circleId: string) => {
    const active = getCircle(circleId);
    if (!active?.isAdmin || active.deleting || active.membershipAuthority !== "v1")
      return;
    try {
      const invite = await freshInvite();
      pendingJoinKeyPackages.current.delete(circleId);
      patchCircle(circleId, {
        invite,
        pendingJoinRequests: [],
        pendingJoinRequestNames: {},
        pendingJoinRequestMemberIds: {},
      });

      appendSystem(
        circleId,
        "Generated a new invite code — the old one no longer works.",
      );
    } catch (err) {
      appendSystem(
        circleId,
        `Couldn't generate a new invite code: ${describeError(err)}`,
      );
    }
  };

  const joinCircle = async (pairingCode: string): Promise<boolean> => {
    const parts = pairingCode.trim().split(".");
    const [circleId, mailboxId, inviteNonce] = parts;
    const hasQrCapability = parts.length >= 5 && parts.at(-2) === "qr";
    const qrCapability = hasQrCapability ? parts.at(-1) : undefined;
    const authorityAdminId = parts[3] === "qr" ? undefined : parts[3];
    if (!circleId || !mailboxId || !inviteNonce) {
      setNotice("That invite code doesn't look right — check it and try again.");
      return false;
    }
    const previous = getCircle(circleId);
    if (previous?.role === "joining") {
      if (previous.mailboxId !== mailboxId) {
        setNotice("That invite code does not match the pending Circle request.");
        return false;
      }
      // An unanswered request has no MLS membership to leave. Remove it
      // locally before submitting the fresh invite, which also discards the
      // old queued request so it cannot keep the person stuck forever.
      await eraseCircle(circleId);
    } else if (previous && previous.role !== "removed") {
      setNotice(
        previous.deleting
          ? "Still leaving this Circle. Rejoin once the other members have confirmed your departure."
          : "You're already in (or joining) that Circle.",
      );
      return false;
    }
    if (previous && previous.mailboxId !== mailboxId) {
      setNotice("That invite code does not match this Circle.");
      return false;
    }
    try {
      putCircle({
        circleName: previous?.circleName,
        circleId,
        mailboxId,
        role: "joining",
        isAdmin: false,
        members: [],
        adminId: authorityAdminId,
        authorityAdminId,
        joinNonce: inviteNonce,
        joinRequestedAt: Date.now(),
      });
      const keyPackage = await bridge.createKeyPackage(DEVICE_SLOT);
      const name = identity.deviceIdRef.current
        ? identity.nicknamesRef.current[identity.deviceIdRef.current]
        : undefined;
      const payload = new TextEncoder().encode(
        JSON.stringify({
          keyPackage: bytesToBase64(keyPackage),
          ...(name ? { name } : {}),
          ...(qrCapability ? { qrCapability } : {}),
        }),
      );
      const sealed = await bridge.sealInviteRequest(
        inviteNonce,
        circleId,
        mailboxId,
        "join",
        payload,
      );
      queueControl(mailboxId, "keypackage", sealed, relay.buildInviteRequestEventId());
      appendSystem(
        circleId,
        qrCapability
          ? "Scanned invitation sent — joining as soon as the Circle confirms the membership update."
          : "Request sent — waiting to be let in...",
      );
      return true;
    } catch (err) {
      forgetCircle(circleId);
      setNotice(`Couldn't send a join request: ${describeError(err)}`);
      return false;
    }
  };

  // Self-service ask to be re-added to a Circle whose local MLS state has
  // gone bad. Requires a pairing code (same as Join Circle) obtained from
  // the creator out-of-band.
  const requestRejoin = async (circleId: string, pairingCode: string) => {
    const active = getCircle(circleId);
    const me = identity.deviceIdRef.current;
    if (!active || active.deleting || !me) return;
    const [codeCircleId, codeMailboxId, inviteNonce, authorityAdminId] = pairingCode
      .trim()
      .split(".");
    if (!codeCircleId || !codeMailboxId || !inviteNonce) {
      appendSystem(circleId, "Enter the invite code the Circle's admin shared with you.");
      return;
    }
    if (codeCircleId !== active.circleId || codeMailboxId !== active.mailboxId) {
      appendSystem(circleId, "That invite code doesn't match this Circle.");
      return;
    }
    try {
      const keyPackage = await bridge.createKeyPackage(DEVICE_SLOT);
      const payload = new TextEncoder().encode(
        JSON.stringify({ deviceId: me, keyPackage: bytesToBase64(keyPackage) }),
      );
      const sealed = await bridge.sealInviteRequest(
        inviteNonce,
        circleId,
        active.mailboxId,
        "rejoin",
        payload,
      );
      const eventId = queueControl(
        active.mailboxId,
        "rejoin-request",
        sealed,
        relay.buildRejoinRequestEventId(),
      );
      bucket(myOwnEventIds.current, circleId).add(eventId);
      awaitingRejoinWelcome.current.add(circleId);
      awaitingRejoinNonce.current.set(circleId, inviteNonce);
      patchCircle(
        circleId,
        circleTransition(active, { type: "rejoin-requested", authorityAdminId }, me),
      );
      appendSystem(circleId, "Rejoin request sent — waiting for the admin to approve...");
    } catch (err) {
      appendSystem(circleId, `Rejoin request failed: ${describeError(err)}`);
    }
  };

  // Approval spends the invite and drops the other pending requests.
  // If the requester still has a stale leaf, replace it in the same commit.
  const approveRejoinRequest = async (circleId: string, requesterId: string) => {
    const active = getCircle(circleId);
    if (
      !active ||
      active.deleting ||
      !active.isAdmin ||
      active.membershipAuthority !== "v1"
    )
      return;
    if (!active.invite || active.invite.used) {
      appendSystem(
        circleId,
        "Can't approve — this invite code was already used. Generate a new one first.",
      );
      return;
    }
    const keyPackage = pendingRejoinKeyPackages.current.get(circleId)?.get(requesterId);
    if (!keyPackage) return;
    enqueueMembershipChange(circleId, {
      type: "rejoin",
      memberId: requesterId,
      keyPackage: bytesToBase64(keyPackage),
    });
    pendingRejoinKeyPackages.current.delete(circleId);
    patchCircle(circleId, {
      invite: { ...active.invite, used: true },
      pendingRejoinRequests: [],
    });
    appendSystem(
      circleId,
      `Approved ${displayMember(requesterId, identity.nicknamesRef.current)}'s rejoin — waiting for confirmation.`,
    );
  };

  // Approve a manual join using the KeyPackage opened from its encrypted request.
  const approveJoinRequest = async (circleId: string, requestId: string) => {
    const active = getCircle(circleId);
    if (
      !active ||
      active.deleting ||
      !active.isAdmin ||
      active.membershipAuthority !== "v1"
    )
      return;
    if (!active.invite || active.invite.used || Date.now() >= active.invite.expiresAt) {
      appendSystem(circleId, "Can't approve — generate a fresh invite code first.");
      return;
    }
    const keyPackage = pendingJoinKeyPackages.current.get(circleId)?.get(requestId);
    if (!keyPackage) return;
    enqueueMembershipChange(circleId, {
      type: "add",
      keyPackage: bytesToBase64(keyPackage),
    });
    pendingJoinKeyPackages.current.delete(circleId);
    const requesterId = active.pendingJoinRequestMemberIds?.[requestId];
    patchCircle(circleId, {
      invite: { ...active.invite, used: true },
      pendingJoinRequests: [],
      pendingJoinRequestNames: {},
      pendingJoinRequestMemberIds: {},
      blockedAutoJoinIds: requesterId
        ? active.blockedAutoJoinIds?.filter((id) => id !== requesterId)
        : active.blockedAutoJoinIds,
    });
    appendSystem(
      circleId,
      "Approved the join request — waiting for the membership update to be confirmed.",
    );
  };

  // Sets (and broadcasts) this device's own nickname — global across all
  // Circles, so it fans out to every Circle currently joined.

  return {
    createCircle,
    regenerateInvite,
    joinCircle,
    requestRejoin,
    approveRejoinRequest,
    approveJoinRequest,
  };
}
