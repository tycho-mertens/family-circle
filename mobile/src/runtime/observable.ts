/** Runtime state survives UI subscriptions being removed. */
export class RuntimeChanges {
  private revision = 0;
  private listeners = new Set<() => void>();

  getRevision = () => this.revision;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  emit = () => {
    this.revision++;
    for (const listener of this.listeners) listener();
  };
}

/** Mutable state shared with long-lived runtime callbacks; callers update it synchronously. */
export function ref<T>(current: T): { current: T } {
  return { current };
}
