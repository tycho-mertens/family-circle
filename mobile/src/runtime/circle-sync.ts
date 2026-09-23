import { nativeErrorCode, isExpectedMlsEcho } from "../native-errors";
import { createRuntimeDiagnostics } from "../diagnostics";
import { decodeApplicationPayload } from "./application-payload";
import { attachmentPayloads } from "../attachment";
import * as backup from "../backup";
import * as bridge from "../bridge";
import type { MailboxEnvelope } from "../relay";
import * as relay from "../relay";
import { bucket } from "./circle-checkpoints";
import { DEVICE_SLOT } from "./circle-constants";
import { displayMember, type AppPayload, type CircleInfo } from "./circle-types";
import { type IdentityContextValue } from "./identity";
import { ref } from "./observable";
import { RejectedCommit } from "./rejected-commit";

interface Dependencies {
  lastSeenSequenceId: { current: Map<string, number> };
  myOwnEventIds: { current: Map<string, Set<string>> };
  listCircles: () => CircleInfo[];
  getCircle: (circleId: string) => CircleInfo | undefined;
  patchCircle: (circleId: string, patch: Partial<CircleInfo>) => void;
  identity: Pick<IdentityContextValue, "deviceIdRef" | "nicknamesRef">;
  appendSystem: (circleId: string, text: string) => void;
  handleControl: (current: CircleInfo, envelope: MailboxEnvelope) => Promise<void>;
  handleApplication: (
    circleId: string,
    current: CircleInfo,
    senderDeviceId: string,
    payload: AppPayload,
  ) => Promise<void>;
  awaitingRejoinWelcome: { current: Set<string> };
  eraseCircle: (circleId: string) => Promise<boolean>;
  putCircle: (circle: CircleInfo) => void;
  getNotice: () => string | null;
  setNotice: (value: string | null) => void;
  queueControl: (
    mailboxId: string,
    kind: Exclude<relay.EnvelopeKind, "application">,
    ciphertext: Uint8Array,
    eventId?: string,
  ) => string;
  enqueueMembershipChange: (circleId: string, change: backup.MembershipChange) => void;
  stageNextMembershipChange: (circleId: string) => Promise<void>;
  queueEnvelope: (
    mailboxId: string,
    envelope: Parameters<typeof backup.queueEnvelope>[1],
  ) => void;
}

export function createCircleSync({
  lastSeenSequenceId,
  myOwnEventIds,
  listCircles,
  getCircle,
  patchCircle,
  identity,
  appendSystem,
  handleControl,
  handleApplication,
  awaitingRejoinWelcome,
  eraseCircle,
  putCircle,
  getNotice,
  setNotice,
  queueControl,
  enqueueMembershipChange,
  stageNextMembershipChange,
  queueEnvelope,
}: Dependencies) {
  const reportFailure = createRuntimeDiagnostics();
  const applyEnvelope = async (circleId: string, envelope: MailboxEnvelope) => {
    if (envelope.sequenceId <= (lastSeenSequenceId.current.get(circleId) ?? 0)) return;
    if (
      envelope.kind !== "commit" &&
      bucket(myOwnEventIds.current, circleId).has(envelope.eventId)
    ) {
      const handover = getCircle(circleId)?.handover;
      if (handover?.eventId === envelope.eventId) {
        patchCircle(circleId, {
          adminId: handover.adminId,
          isAdmin: handover.adminId === identity.deviceIdRef.current,
        });
        appendSystem(
          circleId,
          `${displayMember(handover.adminId, identity.nicknamesRef.current)} is now the admin`,
        );
      }
      lastSeenSequenceId.current.set(circleId, envelope.sequenceId);
      return;
    }
    // Re-read current role/isAdmin/invite each iteration — they can
    // change mid-poll (e.g. a join lands partway through a batch).
    const current = getCircle(circleId);
    if (!current) return;

    try {
      if (envelope.kind !== "application") {
        await handleControl(current, envelope);
      } else {
        if (current.role === "member") {
          let decrypted: Awaited<ReturnType<typeof bridge.decryptEvent>> | undefined;
          try {
            decrypted = await bridge.decryptEvent(DEVICE_SLOT, circleId, {
              eventId: envelope.eventId,
              epoch: envelope.epoch,
              nonce: envelope.nonce,
              ciphertext: envelope.ciphertext,
            });
          } catch (err) {
            if (!isExpectedMlsEcho(err)) {
              reportFailure("Incoming application message", err);
              appendSystem(
                circleId,
                nativeErrorCode(err) === "ERR_MLS_STALE_EPOCH"
                  ? "An older message arrived after the Circle's keys changed and could not be opened."
                  : "A message could not be opened. Other messages can still arrive; check Circle settings if this continues.",
              );
            }
          }
          if (decrypted) {
            const payload = decodeApplicationPayload(decrypted.plaintext);
            // Handler failures must roll back state and retain the cursor. They
            // are not decryption failures and may be safe to retry.
            if (payload)
              await handleApplication(
                circleId,
                current,
                decrypted.senderDeviceId,
                payload,
              );
          }
        }
      }
    } catch (err) {
      // Even during rejoin, rejected native processing must be rolled back.
      if (err instanceof RejectedCommit) throw err;
      if (envelope.kind === "application") throw err;
      // Stale controls are historical replay, classified by the MLS
      // header. A rejoin replaces unusable history with its new Welcome.
      if (
        nativeErrorCode(err) !== "ERR_MLS_STALE_EPOCH" &&
        !isExpectedMlsEcho(err) &&
        !awaitingRejoinWelcome.current.has(circleId)
      )
        throw err;
    }
    lastSeenSequenceId.current.set(circleId, envelope.sequenceId);
    if (getCircle(circleId)?.syncError) patchCircle(circleId, { syncError: undefined });
  };

  const pollCircle = async (circle: CircleInfo) => {
    const { circleId, mailboxId } = circle;
    if (circle.departureConfirmedAt) return;

    let envelopes: MailboxEnvelope[];
    try {
      envelopes = await relay.fetchEnvelopes(
        mailboxId,
        lastSeenSequenceId.current.get(circleId) ?? 0,
      );
    } catch (error) {
      reportFailure("Mailbox fetch", error);
      return; // Retry on the next sync without advancing the cursor.
    }

    for (const envelope of envelopes.sort((a, b) => a.sequenceId - b.sequenceId)) {
      try {
        await backup.stateTransaction(
          async () => {
            await applyEnvelope(circleId, envelope);
          },
          (error) => {
            if (envelope.kind !== "commit" || !(error instanceof RejectedCommit))
              return undefined;
            // The journal has restored both native and app state and retains
            // its lock through this fresh transaction. No queued action can
            // replace the Circle or change its cursor between these steps.
            return async () => {
              const restored = getCircle(circleId);
              if (!restored || restored.mailboxId !== mailboxId)
                throw new Error("Circle changed during commit rejection");
              lastSeenSequenceId.current.set(circleId, envelope.sequenceId);
              patchCircle(circleId, {
                rejectedControl: {
                  sequenceId: envelope.sequenceId,
                  code: error.code,
                  count: Math.min(
                    (restored.rejectedControl?.count ?? 0) + 1,
                    Number.MAX_SAFE_INTEGER,
                  ),
                },
                syncError: undefined,
              });
              reportFailure("Rejected membership update", error);
            };
          },
        );
      } catch (err) {
        reportFailure("Incoming Circle update", err);
        await backup.stateTransaction(async () => {
          if (getCircle(circleId) && !getCircle(circleId)?.syncError) {
            patchCircle(circleId, {
              syncError:
                envelope.kind === "application"
                  ? "A message update could not be saved. Sending is paused while this Circle retries."
                  : "A membership update could not be applied. Sending is paused while this Circle reconnects.",
            });
          }
        });
        return; // Retain cursor; do not skip a commit required by later messages.
      }
    }
    await resealRejectedMessages(circle);
    await advanceDeparture(circle);
    await stageMembershipChange(circle);
    await publishPendingMessages(circle);
  };

  const resealRejectedMessages = async ({ circleId, mailboxId }: CircleInfo) => {
    if (
      backup.hasRejectedEnvelope(mailboxId) &&
      getCircle(circleId)?.role === "member" &&
      !getCircle(circleId)?.recoveryRequired &&
      !getCircle(circleId)?.syncError
    ) {
      await backup.stateTransaction(async () => {
        const state = await bridge.circlePublicationState(DEVICE_SLOT, circleId);
        await backup.resealRejected(
          mailboxId,
          lastSeenSequenceId.current.get(circleId) ?? 0,
          state.epoch,
          (plaintext) =>
            bridge.encryptEvent(
              DEVICE_SLOT,
              circleId,
              new TextEncoder().encode(plaintext),
            ),
        );
      });
    }
  };

  const advanceDeparture = async ({ circleId, mailboxId }: CircleInfo) => {
    // Leave requests survive offline deletion and epoch changes. Only erase
    // MLS state after peers confirm removal, or nobody else remains.
    await backup.stateTransaction(async () => {
      const current = getCircle(circleId);
      if (!current) return;
      patchCircle(circleId, { lastSuccessfulSync: Date.now() });
      if (current.deleting) {
        if (
          current.role === "removed" ||
          (current.role === "member" && current.members.length <= 1)
        ) {
          await eraseCircle(circleId);
          putCircle({
            circleId,
            mailboxId,
            circleName: current.circleName,
            role: "removed",
            isAdmin: false,
            members: [],
            deleting: true,
            departureConfirmedAt: Date.now(),
          });
          if (getNotice()?.startsWith("Leaving requested.")) setNotice(null);
          return;
        }
        if (
          current.role === "member" &&
          !current.pendingCommitEventId &&
          !current.recoveryRequired &&
          !current.syncError
        ) {
          const publication = await bridge.circlePublicationState(DEVICE_SLOT, circleId);
          if (!publication.pendingCommit && current.leaveEpoch !== publication.epoch) {
            const proposal = await bridge.proposeLeave(DEVICE_SLOT, circleId);
            const eventId = queueControl(mailboxId, "leave", proposal);
            bucket(myOwnEventIds.current, circleId).add(eventId);
            patchCircle(circleId, { leaveEpoch: publication.epoch });
          }
        }
      }
      if (current.isAdmin) {
        for (const memberId of current.departingMembers ?? []) {
          if (
            memberId !== identity.deviceIdRef.current &&
            current.members.includes(memberId)
          )
            enqueueMembershipChange(circleId, { type: "remove", memberId });
        }
      }
    });
  };

  const stageMembershipChange = async ({ circleId, mailboxId }: CircleInfo) => {
    // Stage at most one membership operation after complete catch-up. The
    // current epoch remains active until its own commit is read in relay order.
    const current = getCircle(circleId);
    if (
      current?.role === "member" &&
      current.isAdmin &&
      current.membershipAuthority === "v1" &&
      !current.syncError &&
      !current.pendingCommitEventId &&
      (current.recoveryRequired || current.membershipChanges?.length)
    ) {
      await backup.stateTransaction(async () => {
        const ready = getCircle(circleId);
        if (!ready || ready.pendingCommitEventId) return;
        if (ready.recoveryRequired && !ready.membershipChanges?.length)
          enqueueMembershipChange(circleId, { type: "refresh" });
        await stageNextMembershipChange(circleId);
      });
    }
  };

  const publishPendingMessages = async ({ circleId, mailboxId }: CircleInfo) => {
    if (
      getCircle(circleId)?.pendingChats?.length ||
      getCircle(circleId)?.pendingBroadcasts?.length
    )
      await backup.stateTransaction(async () => {
        const ready = getCircle(circleId);
        if (
          !ready ||
          ready.recoveryRequired ||
          ready.syncError ||
          ready.pendingCommitEventId
        )
          return;
        if (ready.role !== "member") {
          patchCircle(circleId, { pendingChats: [], pendingBroadcasts: [] });
          appendSystem(
            circleId,
            "Your queued messages were not sent because your membership ended.",
          );
          return;
        }
        const broadcasts = ready.pendingBroadcasts ?? [];
        const isMessageAction = (plaintext: string) =>
          ["reaction", "message-edit", "message-delete"].includes(
            JSON.parse(plaintext).type,
          );
        // A reaction to our own offline draft must follow the chat it references.
        const payloads = [
          ...broadcasts.filter((p) => !isMessageAction(p)),
          ...(ready.pendingChats ?? []).flatMap((chat) =>
            typeof chat === "string"
              ? [JSON.stringify({ type: "chat", text: chat })]
              : attachmentPayloads(chat),
          ),
          ...broadcasts.filter(isMessageAction),
        ];
        for (const plaintext of payloads) {
          const envelope = await bridge.encryptEvent(
            DEVICE_SLOT,
            circleId,
            new TextEncoder().encode(plaintext),
          );
          bucket(myOwnEventIds.current, circleId).add(envelope.eventId);
          const payload = JSON.parse(plaintext) as AppPayload;
          if (payload.type === "admin-transfer" && ready.handover?.id === payload.id)
            patchCircle(circleId, {
              handover: { ...ready.handover, eventId: envelope.eventId },
            });
          queueEnvelope(mailboxId, {
            ...envelope,
            kind: "application",
            plaintext,
            expectedSequenceId: lastSeenSequenceId.current.get(circleId) ?? 0,
          });
        }
        patchCircle(circleId, { pendingChats: [], pendingBroadcasts: [] });
      });
  };

  const pollingCircles = ref(new Map<string, Promise<void>>());
  const pollAll = async () => {
    const tasks: Promise<void>[] = [];
    for (const circle of listCircles()) {
      let task = pollingCircles.current.get(circle.circleId);
      if (!task) {
        task = pollCircle(circle)
          .catch((err) => {
            reportFailure("Circle synchronization", err);
          })
          .finally(() => pollingCircles.current.delete(circle.circleId));
        pollingCircles.current.set(circle.circleId, task);
      }
      tasks.push(task);
    }
    await Promise.all(tasks);
    await backup.flushOutbox();
    void backup.syncBackupNow(DEVICE_SLOT);
  };

  return { pollAll };
}
