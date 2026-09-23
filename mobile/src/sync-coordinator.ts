/** Requests received during a sync share its promise and schedule one follow-up pass. */
export class SyncCoordinator {
  private running: Promise<void> | null = null;
  private again = false;
  constructor(private readonly cycle: () => Promise<void>) {}
  request(): Promise<void> {
    this.again = true;
    if (this.running) return this.running;
    this.running = Promise.resolve()
      .then(async () => {
        do {
          this.again = false;
          await this.cycle();
        } while (this.again);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
