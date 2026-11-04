/** Keeps business operations serial while queued card work may overtake outbox bookkeeping. */
export class FairOperationQueue {
  private readonly ordinary: Array<() => Promise<void>> = [];
  private readonly interactive: Array<() => Promise<void>> = [];
  private readonly idleWaiters: Array<() => void> = [];
  private draining = false;
  private burst = 0;

  enqueue<T>(operation: () => Promise<T>, interactive = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      (interactive ? this.interactive : this.ordinary).push(async () => {
        try { resolve(await operation()); }
        catch (error) { reject(error); }
      });
      if (!this.draining) {
        this.draining = true;
        queueMicrotask(() => { void this.drain(); });
      }
    });
  }

  idle(): Promise<void> {
    return this.draining ? new Promise(resolve => this.idleWaiters.push(resolve)) : Promise.resolve();
  }

  private async drain(): Promise<void> {
    try {
      while (this.interactive.length || this.ordinary.length) {
        const interactive = this.interactive.length > 0 && (!this.ordinary.length || this.burst < 4);
        this.burst = interactive ? this.burst + 1 : 0;
        await (interactive ? this.interactive : this.ordinary).shift()!();
        // Return to timers/I/O even when a series of cached operations resolves immediately.
        if (interactive) await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally {
      this.draining = false;
      this.burst = 0;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}
