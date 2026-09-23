import { createRuntimeDiagnostics } from "../diagnostics";
import type Native from "../../modules/family-circle-bridge";
import { StateJournal } from "../state-journal";
import { encodeAppMetadata } from "./metadata";
import { createOutbox, type OutboxTransport } from "./outbox";
import type { BackupSnapshot, OutboxEntry } from "./types";

type CheckpointStorage = Pick<
  typeof Native,
  | "beginChatTransaction"
  | "commitChatTransaction"
  | "abortChatTransaction"
  | "configureChatState"
>;

export interface PersistenceRuntime {
  snapshot: () => BackupSnapshot;
  restore: (snapshot: BackupSnapshot) => void;
  committed: () => void;
  acknowledged: (entry: OutboxEntry) => void;
}

// One instance owns the journal, outbox, rollback callbacks, and deferred effects.
// The app creates it once; tests can supply independent native storage instances.
export function createChatPersistence(
  native: CheckpointStorage,
  transport: OutboxTransport,
) {
  const journal = new StateJournal();
  const reportFailure = createRuntimeDiagnostics();
  let initialized = false;
  let runtime: PersistenceRuntime | undefined;

  // Identity storage may load first, but transactions require the complete
  // runtime binding. Register all callbacks together before starting work.
  function bindRuntime(binding: PersistenceRuntime): void {
    if (runtime) throw new Error("Chat persistence already has a runtime owner.");
    runtime = { ...binding };
  }

  function requireRuntime(): PersistenceRuntime {
    if (!runtime) throw new Error("Chat persistence runtime is not bound.");
    return runtime;
  }

  let effects: (() => void)[] | null = null;
  function afterStateCommit(effect: () => void): void {
    if (effects) effects.push(effect);
    else effect();
  }

  const outbox = createOutbox({
    transport,
    journal,
    getSnapshot: () => requireRuntime().snapshot(),
    stateTransaction,
    onAcknowledged: (entry) => requireRuntime().acknowledged(entry),
  });

  const {
    pendingMessageCount,
    queueEnvelope,
    discardMailboxApplications,
    discardMailboxOutbox,
    flushOutbox,
    resealRejected,
    hasRejectedEnvelope,
  } = outbox;

  const snapshot = (): BackupSnapshot => ({
    ...requireRuntime().snapshot(),
    outbox: outbox.snapshot(),
  });

  async function stateTransaction<T>(operation: () => Promise<T>): Promise<T> {
    if (!initialized)
      throw new Error("Your identity is still loading. Try again shortly.");
    return journal.transaction(
      {
        snapshot,
        begin: async () => {
          await native.beginChatTransaction();
          effects = [];
        },
        commit: async () => {
          await native.commitChatTransaction(encodeAppMetadata(snapshot()));
          const committed = effects ?? [];
          effects = null;
          try {
            requireRuntime().committed();
          } catch (error) {
            reportFailure("Committed state listener", error);
          }
          for (const effect of committed) {
            try {
              effect();
            } catch (error) {
              reportFailure("Post-commit effect", error);
            }
          }
        },
        rollback: async (before) => {
          effects = null;
          await native.abortChatTransaction();
          outbox.restore(before.outbox ?? []);
          requireRuntime().restore(before);
        },
      },
      operation,
    );
  }

  async function configureLocal(
    encKey: Uint8Array,
    initial: BackupSnapshot,
    preserveLocations = false,
  ): Promise<void> {
    outbox.restore(initial.outbox ?? []);
    await native.configureChatState(
      encKey,
      encodeAppMetadata(initial),
      preserveLocations,
    );
    await native.beginChatTransaction();
    await native.commitChatTransaction(encodeAppMetadata(initial));
    initialized = true;
  }

  return {
    get ready() {
      return initialized && runtime !== undefined;
    },
    run: <T>(operation: () => Promise<T>) => journal.run(operation),
    snapshot,
    configureLocal,
    bindRuntime,
    afterStateCommit,
    stateTransaction,
    pendingMessageCount,
    queueEnvelope,
    discardMailboxApplications,
    discardMailboxOutbox,
    flushOutbox,
    resealRejected,
    hasRejectedEnvelope,
  };
}
