import { createRuntimeDiagnostics } from "../diagnostics";
import type * as relay from "../relay";

export type OutboxTransport = Pick<typeof relay, "uploadEnvelope" | "isMailboxChanged">;
import type * as bridge from "../bridge";
import { base64ToBytes, bytesToBase64 } from "../base64";
import type { StateJournal } from "../state-journal";
import type { BackupSnapshot, OutboxEntry } from "./types";

interface Dependencies {
  transport: OutboxTransport;
  journal: StateJournal;
  getSnapshot: () => BackupSnapshot;
  stateTransaction: <T>(operation: () => Promise<T>) => Promise<T>;
  onAcknowledged: (entry: OutboxEntry) => void;
}

// The journal guards reads as well as writes: only committed envelopes may be uploaded.
export function createOutbox({
  transport,
  journal,
  getSnapshot,
  stateTransaction,
  onAcknowledged,
}: Dependencies) {
  const reportFailure = createRuntimeDiagnostics();
  let entries: OutboxEntry[] = [];
  function pendingMessageCount(mailboxId: string) {
    const messages = new Set<string>();
    for (const entry of entries) {
      if (entry.mailboxId !== mailboxId || entry.kind !== "application") continue;
      try {
        const payload = entry.plaintext ? JSON.parse(entry.plaintext) : null;
        if (!payload || payload.type === "chat" || payload.type === "attachment-chunk")
          messages.add(payload?.messageId ?? entry.eventId);
      } catch {
        messages.add(entry.eventId);
      } // Legacy plain-text drafts.
    }
    return messages.size;
  }

  function queueEnvelope(
    mailboxId: string,
    envelope: {
      eventId: string;
      epoch: number;
      kind: relay.EnvelopeKind;
      nonce: Uint8Array;
      ciphertext: Uint8Array;
      expectedSequenceId?: number;
      plaintext?: string;
      commitEventId?: string;
    },
  ): void {
    if (!entries.some((entry) => entry.eventId === envelope.eventId)) {
      entries.push({
        ...envelope,
        mailboxId,
        nonce: bytesToBase64(envelope.nonce),
        ciphertext: bytesToBase64(envelope.ciphertext),
      });
    }
  }

  /** Keep membership protocol envelopes until a leave has been confirmed. */
  function discardMailboxApplications(mailboxId: string): void {
    entries = entries.filter(
      (entry) => entry.mailboxId !== mailboxId || entry.kind !== "application",
    );
  }

  /** Call inside stateTransaction when deleting a local Circle. */
  function discardMailboxOutbox(mailboxId: string): void {
    entries = entries.filter((entry) => entry.mailboxId !== mailboxId);
  }

  let flushing: Promise<void> | null = null;
  function flushOutbox(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      while (entries.length) {
        // Take only committed data: an ongoing transaction may still roll back.
        const entry = await journal.run(async () => {
          const blocked = new Set(
            getSnapshot()
              .circles.filter((circle) => circle.syncError)
              .map((circle) => circle.mailboxId),
          );
          for (const pending of entries) {
            if (blocked.has(pending.mailboxId)) continue;
            if (pending.needsSync) {
              blocked.add(pending.mailboxId);
              continue;
            }
            return pending;
          }
          return undefined;
        });
        if (!entry) break;
        let acceptedSequence: number;
        try {
          acceptedSequence = await transport.uploadEnvelope(entry.mailboxId, {
            ...entry,
            nonce: base64ToBytes(entry.nonce),
            ciphertext: base64ToBytes(entry.ciphertext),
          });
        } catch (error) {
          if (transport.isMailboxChanged(error)) {
            // The relay confirmed that it did not store this event. Catch up
            // before resealing; uncertain outcomes must retry the original bytes.
            await stateTransaction(async () => {
              const pending = entries.find((item) => item.eventId === entry.eventId);
              if (pending) pending.needsSync = true;
            });
          } else {
            reportFailure("Outbox publication", error);
          }
          break;
        }
        await stateTransaction(async () => {
          onAcknowledged(entry);
          entries = entries.filter((item) => item.eventId !== entry.eventId);
          // The conditional append confirms that no other envelope came first.
          // Let messages queued at the same cursor advance past our own upload.
          if (
            entry.expectedSequenceId !== undefined &&
            Number.isFinite(acceptedSequence)
          ) {
            for (const pending of entries)
              if (
                pending.mailboxId === entry.mailboxId &&
                pending.expectedSequenceId === entry.expectedSequenceId
              )
                pending.expectedSequenceId = acceptedSequence;
          }
        });
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  /** Called inside a transaction after fetching and processing all mailbox pages. */
  async function resealRejected(
    mailboxId: string,
    cursor: number,
    currentEpoch: number,
    encrypt: (plaintext: string) => Promise<bridge.EncryptedEnvelope>,
  ): Promise<void> {
    for (const entry of entries.filter(
      (item) => item.mailboxId === mailboxId && item.needsSync,
    )) {
      // A pending local commit leaves the current epoch active. A same-epoch
      // rejection needs only a fresh cursor, not a new ratchet generation.
      if (entry.epoch === currentEpoch) {
        entry.expectedSequenceId = cursor;
        entry.needsSync = false;
        continue;
      }
      if (entry.plaintext === undefined)
        throw new Error(
          "A queued message from an older app cannot be retried automatically.",
        );
      const sealed = await encrypt(entry.plaintext);
      Object.assign(entry, {
        epoch: sealed.epoch,
        nonce: bytesToBase64(sealed.nonce),
        ciphertext: bytesToBase64(sealed.ciphertext),
        expectedSequenceId: cursor,
        needsSync: false,
      });
    }
  }
  function hasRejectedEnvelope(mailboxId: string): boolean {
    return entries.some((entry) => entry.mailboxId === mailboxId && entry.needsSync);
  }

  return {
    pendingMessageCount,
    queueEnvelope,
    discardMailboxApplications,
    discardMailboxOutbox,
    flushOutbox,
    resealRejected,
    hasRejectedEnvelope,
    snapshot: () => entries.map((entry) => ({ ...entry })),
    restore: (saved: OutboxEntry[]) => {
      entries = saved;
    },
  };
}
