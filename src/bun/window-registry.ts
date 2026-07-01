/**
 * Ordered registry of open windows. Front of the list is the most-recently
 * focused window. Kept as a pure, generic structure (no Electrobun dependency)
 * so focus ordering and push-broadcast fan-out are unit-testable.
 */
export class WindowRegistry<T> {
  private order: T[] = [];

  add(entry: T): void {
    this.remove(entry);
    this.order.unshift(entry);
  }

  remove(entry: T): void {
    this.order = this.order.filter((e) => e !== entry);
  }

  /** Promote an entry to the front (most-recently-focused). */
  focus(entry: T): void {
    if (!this.order.includes(entry)) return;
    this.add(entry);
  }

  get focused(): T | undefined {
    return this.order[0];
  }

  get all(): readonly T[] {
    return this.order;
  }

  get size(): number {
    return this.order.length;
  }

  /** Fan a side effect out to every window (e.g. a push message). */
  broadcast(fn: (entry: T) => void): void {
    for (const entry of this.order) fn(entry);
  }
}
