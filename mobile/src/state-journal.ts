/** One queue for state transactions, including foreground/background callers.
 * A failed commit restores the previous in-memory snapshot before work resumes.
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
  ): Promise<T> {
    return this.run(async () => {
      const before = adapter.snapshot();
      await adapter.begin();
      try {
        const result = await operation();
        await adapter.commit();
        return result;
      } catch (error) {
        try {
          await adapter.rollback(before);
        } catch (rollbackError) {
          this.failure = rollbackError;
        }
        throw error;
      }
    });
  }
}
