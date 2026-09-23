/**
 * Serialize foreground and background state transactions in one queue.
 * Roll back failed operations or commits before continuing. If rollback fails,
 * reject subsequent work because the saved and in-memory state may disagree.
 */
export class StateJournal {
  private tail: Promise<unknown> = Promise.resolve();
  private failure: unknown;

  run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      return operation();
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  async transaction<T, S>(
    adapter: {
      snapshot: () => S;
      begin: () => Promise<void>;
      commit: () => Promise<void>;
      rollback: (snapshot: S) => Promise<void>;
    },
    operation: () => Promise<T>,
    recover?: (error: unknown) => (() => Promise<T>) | undefined,
  ): Promise<T> {
    const execute = async (
      operation: () => Promise<T>,
      recovery?: typeof recover,
    ): Promise<T> => {
      const before = adapter.snapshot();
      await adapter.begin();
      let applied = false;
      try {
        const result = await operation();
        applied = true;
        await adapter.commit();
        return result;
      } catch (error) {
        try {
          await adapter.rollback(before);
        } catch (rollbackError) {
          this.failure = rollbackError;
          throw error;
        }
        // Recovery gets a fresh native transaction only after full rollback.
        // Keep the journal locked, never recover a failed save, and do not
        // recursively recover if the recovery transaction itself fails.
        const next = applied ? undefined : recovery?.(error);
        if (next) return execute(next);
        throw error;
      }
    };
    return this.run(() => execute(operation, recover));
  }
}
