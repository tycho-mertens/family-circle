import { createRuntimeDiagnostics } from "../diagnostics";
import { rejectedCommit } from "./rejected-commit";
import { circleTransition, remainingAdmin } from "./circle-transitions";
import * as backup from "../backup";
import { base64ToBytes, bytesToBase64 } from "../base64";
import * as bridge from "../bridge";
import { receiveLocationControl } from "../location";
import type { MailboxEnvelope } from "../relay";
import * as relay from "../relay";
import type { CircleCheckpoints } from "./circle-checkpoints";
import { bucket } from "./circle-checkpoints";
import { DEVICE_SLOT } from "./circle-constants";
import {
  circleLabel,
  displayMember,
  type AppPayload,
  type CircleInfo,
} from "./circle-types";
import { type IdentityContextValue, MAX_NICKNAME_LEN } from "./identity";

interface Dependencies {
  checkpoints: CircleCheckpoints;
  appendSystem: (circleId: string, text: string) => void;
  identity: Pick<
    IdentityContextValue,
    "deviceIdRef" | "nicknamesRef" | "profilePhotosRef"
  >;
  patchCircle: (circleId: string, patch: Partial<CircleInfo>) => void;
  enqueueMembershipChange: (circleId: string, change: backup.MembershipChange) => void;
  refreshMembers: (circleId: string) => Promise<string[] | null>;
  broadcastToCircle: (circleId: string, payload: AppPayload) => Promise<void>;
  setNotice: (value: string | null) => void;
  forgetCircle: (circleId: string) => void;
  notifyIfBackgrounded: (
    circleId: string,
    title: string,
    body: string,
    category?: "chat" | "location" | "system",
  ) => void;
  notifyNewMembers: (circleId: string, previousMembers: string[]) => Promise<void>;
}

// The sync loop applies one control at a time in relay order, inside a transaction.
export function createControlHandler({
  checkpoints,
  appendSystem,
  identity,
  patchCircle,
  enqueueMembershipChange,
  refreshMembers,
  broadcastToCircle,
  setNotice,
  forgetCircle,
  notifyIfBackgrounded,
  notifyNewMembers,
}: Dependencies) {
  const reportFailure = createRuntimeDiagnostics();
  const {
    processedKeyPackageIds,
    triedWelcomeIds,
    processedLeaveIds,
    processedRejoinRequestIds,
    pendingRejoinKeyPackages,
    pendingJoinKeyPackages,
    awaitingRejoinNonce,
    awaitingRejoinWelcome,
  } = checkpoints;

  const handleJoinRequest = async (current: CircleInfo, envelope: MailboxEnvelope) => {
    const { circleId, mailboxId } = current;

    if (
      current.isAdmin &&
      current.role === "member" &&
      !bucket(processedKeyPackageIds.current, circleId).has(envelope.eventId)
    ) {
      bucket(processedKeyPackageIds.current, circleId).add(envelope.eventId);
      const invite = current.invite;
      if (!invite || invite.used || Date.now() >= invite.expiresAt) {
        appendSystem(
          circleId,
          "Ignored a join request because there is no active invite.",
        );
      } else {
        // The pairing secret is inside this AEAD-protected payload,
        // never the event ID. A mailbox observer can replay this
        // exact request but cannot substitute their own KeyPackage.
        try {
          const plaintext = await bridge.openInviteRequest(
            invite.nonce,
            circleId,
            mailboxId,
            "join",
            envelope.ciphertext,
          );
          // Older clients sealed the KeyPackage directly. Newer requests
          // include a display name for devices that need rejoin approval.
          let keyPackage = plaintext;
          let requestName = "Someone";
          try {
            const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
              keyPackage?: unknown;
              name?: unknown;
            };
            if (typeof payload.keyPackage === "string") {
              keyPackage = base64ToBytes(payload.keyPackage);
              if (!keyPackage.length) throw new Error("Empty KeyPackage");
              if (typeof payload.name === "string") {
                const candidate = payload.name
                  .trim()
                  .replace(/\s+/g, " ")
                  .slice(0, MAX_NICKNAME_LEN);
                if (candidate) requestName = candidate;
              }
            }
          } catch {
            // Direct KeyPackages from an older app stay compatible.
          }
          let requests = pendingJoinKeyPackages.current.get(circleId);
          if (!requests) {
            requests = new Map();
            pendingJoinKeyPackages.current.set(circleId, requests);
          }
          requests.set(envelope.eventId, keyPackage);
          const requesterId = await bridge.keyPackageIdentity(DEVICE_SLOT, keyPackage);
          if (requesterId === identity.deviceIdRef.current)
            throw new Error("Own KeyPackage");
          const blocked = current.blockedAutoJoinIds?.includes(requesterId);
          if (!blocked) {
            // Consume the invite for this admission. The block check uses the
            // signed KeyPackage identity, so changing the request name cannot
            // let a removed device bypass approval.
            pendingJoinKeyPackages.current.delete(circleId);
            patchCircle(circleId, {
              invite: { ...invite, used: true },
              pendingJoinRequests: [],
              pendingJoinRequestNames: {},
              pendingJoinRequestMemberIds: {},
            });
            enqueueMembershipChange(circleId, {
              type: "add",
              keyPackage: bytesToBase64(keyPackage),
            });
            appendSystem(
              circleId,
              "A new member is joining — waiting for the membership update to be confirmed.",
            );
          } else {
            const pending = current.pendingJoinRequests ?? [];
            if (!pending.includes(envelope.eventId)) {
              const label = identity.nicknamesRef.current[requesterId] ?? requestName;
              patchCircle(circleId, {
                pendingJoinRequests: [...pending, envelope.eventId],
                pendingJoinRequestNames: {
                  ...(current.pendingJoinRequestNames ?? {}),
                  [envelope.eventId]: label,
                },
                pendingJoinRequestMemberIds: {
                  ...(current.pendingJoinRequestMemberIds ?? {}),
                  [envelope.eventId]: requesterId,
                },
              });
              appendSystem(
                circleId,
                `${label} was previously removed and is requesting to rejoin.`,
              );
            }
          }
        } catch (error) {
          reportFailure("Incoming join request", error);
          // Ignore failed requests without sending an error response.
        }
      }
    }
  };

  const handleWelcome = async (current: CircleInfo, envelope: MailboxEnvelope) => {
    const { circleId, mailboxId } = current;

    // A rejoining device may still have a member or removed role locally.
    // Only a Welcome encrypted for this device can be opened.
    if (
      (current.role === "joining" ||
        current.role === "removed" ||
        awaitingRejoinWelcome.current.has(circleId)) &&
      !bucket(triedWelcomeIds.current, circleId).has(envelope.eventId)
    ) {
      bucket(triedWelcomeIds.current, circleId).add(envelope.eventId);
      try {
        if (current.role === "joining" || awaitingRejoinWelcome.current.has(circleId)) {
          // Clear stale state before accepting the Welcome: OpenMLS cannot
          // create a group while the same GroupId is still stored. This also
          // applies to a normal join after removal and an app restart.
          await bridge.forgetCircle(DEVICE_SLOT, circleId);
        }
        const joinedCircleId = current.authorityAdminId
          ? await bridge.joinFromWelcomeWithAdmin(
              DEVICE_SLOT,
              envelope.ciphertext,
              current.authorityAdminId,
            )
          : await bridge.joinFromWelcome(DEVICE_SLOT, envelope.ciphertext);
        if (joinedCircleId === circleId) {
          patchCircle(
            circleId,
            circleTransition(current, { type: "joined" }, identity.deviceIdRef.current),
          );
          awaitingRejoinWelcome.current.delete(circleId);
          awaitingRejoinNonce.current.delete(circleId);
          appendSystem(circleId, "You joined this Circle");
          await refreshMembers(circleId);
          // Re-broadcast the saved nickname after joining, including after a restore.
          const me = identity.deviceIdRef.current;
          const myNickname = me ? identity.nicknamesRef.current[me] : undefined;
          if (myNickname) {
            await broadcastToCircle(circleId, { type: "nickname", nickname: myNickname });
          }
          if (me)
            await broadcastToCircle(circleId, {
              type: "profile-photo",
              photo: identity.profilePhotosRef.current[me] ?? null,
            });
        }
      } catch (error) {
        reportFailure("Incoming Welcome", error);
        // Welcomes for other devices cannot be decrypted here. Any failure
        // in this block is ignored; the tried event ID prevents another attempt.
      }
    }
  };

  const handleJoinRejected = async (current: CircleInfo, envelope: MailboxEnvelope) => {
    const { circleId, mailboxId } = current;

    if (current.role === "joining" && current.joinNonce) {
      const rejectedNonce = relay.parseInviteNonce(envelope.eventId);
      if (rejectedNonce === current.joinNonce) {
        setNotice(
          "Your join request was rejected (invite already used, expired, or invalid).",
        );
        forgetCircle(circleId);
      }
    } else if (awaitingRejoinNonce.current.get(circleId)) {
      // Keep the Circle after a failed rejoin so the member can retry with a fresh code.
      const rejectedNonce = relay.parseInviteNonce(envelope.eventId);
      if (rejectedNonce === awaitingRejoinNonce.current.get(circleId)) {
        appendSystem(
          circleId,
          "Your request to rejoin was declined (invite code missing, already used, or expired).",
        );
        awaitingRejoinNonce.current.delete(circleId);
        awaitingRejoinWelcome.current.delete(circleId);
      }
    }
  };

  const handleLeave = async (current: CircleInfo, envelope: MailboxEnvelope) => {
    const { circleId, mailboxId } = current;

    if (
      current.role === "member" &&
      !bucket(processedLeaveIds.current, circleId).has(envelope.eventId)
    ) {
      bucket(processedLeaveIds.current, circleId).add(envelope.eventId);
      const leavingMember = await bridge.processLeave(
        DEVICE_SLOT,
        circleId,
        envelope.ciphertext,
      );
      const departingMembers = [
        ...new Set([...(current.departingMembers ?? []), leavingMember]),
      ];
      const successor = remainingAdmin(
        current,
        current.members,
        departingMembers,
        identity.deviceIdRef.current,
      );
      patchCircle(circleId, {
        departingMembers,
        adminId: successor,
        isAdmin: successor === identity.deviceIdRef.current,
      });
      const body = `${displayMember(leavingMember, identity.nicknamesRef.current)} left the Circle`;
      appendSystem(circleId, body);
      // The departing device ignores its own leave envelope, so this
      // alert is delivered only to the remaining Circle members.
      notifyIfBackgrounded(circleId, `Member left ${circleLabel(current)}`, body);
    }
  };

  const handleCommit = async (current: CircleInfo, envelope: MailboxEnvelope) => {
    const { circleId, mailboxId } = current;

    if (current.role === "member") {
      try {
        await bridge.processCommit(DEVICE_SLOT, circleId, envelope.ciphertext);
      } catch (error) {
        throw rejectedCommit(error) ?? error;
      }
      if (!awaitingRejoinWelcome.current.has(circleId))
        patchCircle(
          circleId,
          circleTransition(
            current,
            { type: "commit-confirmed" },
            identity.deviceIdRef.current,
          ),
        );
      appendSystem(circleId, "Membership updated");
      await notifyNewMembers(circleId, current.members);
    }
  };

  const handleRejoinRequest = async (current: CircleInfo, envelope: MailboxEnvelope) => {
    const { circleId, mailboxId } = current;

    // Rejoins always need admin approval. Do not check invite.used here:
    // multiple requesters may reach the pending list before approval spends the nonce.
    if (
      current.isAdmin &&
      current.role === "member" &&
      !bucket(processedRejoinRequestIds.current, circleId).has(envelope.eventId)
    ) {
      bucket(processedRejoinRequestIds.current, circleId).add(envelope.eventId);
      const invite = current.invite;
      if (invite && Date.now() < invite.expiresAt)
        try {
          const plaintext = await bridge.openInviteRequest(
            invite.nonce,
            circleId,
            mailboxId,
            "rejoin",
            envelope.ciphertext,
          );
          const request = JSON.parse(new TextDecoder().decode(plaintext)) as {
            deviceId?: unknown;
            keyPackage?: unknown;
          };
          if (
            typeof request.deviceId === "string" &&
            request.deviceId &&
            request.deviceId !== identity.deviceIdRef.current &&
            typeof request.keyPackage === "string"
          ) {
            const keyPackage = base64ToBytes(request.keyPackage);
            let keyPackages = pendingRejoinKeyPackages.current.get(circleId);
            if (!keyPackages) {
              keyPackages = new Map();
              pendingRejoinKeyPackages.current.set(circleId, keyPackages);
            }
            keyPackages.set(request.deviceId, keyPackage);
            const already = current.pendingRejoinRequests ?? [];
            if (!already.includes(request.deviceId)) {
              patchCircle(circleId, {
                pendingRejoinRequests: [...already, request.deviceId],
              });
              appendSystem(
                circleId,
                `${displayMember(request.deviceId, identity.nicknamesRef.current)} is requesting to rejoin`,
              );
            }
          }
        } catch (error) {
          reportFailure("Incoming rejoin request", error);
          // Ignore failed rejoin requests without sending an error response.
        }
    }
  };

  const handleLocationControlV1 = async (
    current: CircleInfo,
    envelope: MailboxEnvelope,
  ) => {
    const { circleId, mailboxId } = current;

    if (current.role === "member") {
      const sender = await receiveLocationControl(circleId, envelope);
      if (
        !current.deleting &&
        sender &&
        sender !== identity.deviceIdRef.current &&
        current.members.includes(sender)
      ) {
        const body = `${displayMember(sender, identity.nicknamesRef.current)} started sharing their location`;
        appendSystem(circleId, body);
        notifyIfBackgrounded(
          circleId,
          `Location sharing · ${circleLabel(current)}`,
          body,
          "location",
        );
      }
    }
  };

  const handleControl = async (current: CircleInfo, envelope: MailboxEnvelope) => {
    switch (envelope.kind) {
      case "keypackage":
        return handleJoinRequest(current, envelope);
      case "welcome":
        return handleWelcome(current, envelope);
      case "join-rejected":
        return handleJoinRejected(current, envelope);
      case "leave":
        return handleLeave(current, envelope);
      case "commit":
        return handleCommit(current, envelope);
      case "rejoin-request":
        return handleRejoinRequest(current, envelope);
      case "location-control-v1":
        return handleLocationControlV1(current, envelope);
    }
  };

  return { handleControl };
}
