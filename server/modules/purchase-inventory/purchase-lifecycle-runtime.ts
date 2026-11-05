import { cancelHotfixInitialization, currentHotfixActivation, runHotfixInitialization } from '../../common/hotfix-runtime-activation';

/** Lifecycle worker scheduling is opt-in; constructing this object performs no work. */
export class PurchaseLifecycleRuntime {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  private generation = 0;
  private ready = false;
  private activationOwner: object | undefined;

  constructor(
    private readonly worker: { run(limit?: number): Promise<unknown> },
    private readonly dependencies: { verify(): Promise<boolean> },
    private readonly reportFailure: (code: string) => void,
    private readonly intervalMs = 5_000,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new Error('采购卡片调度间隔无效');
  }

  isReady(): boolean { return this.ready && !!this.timer && currentHotfixActivation().isAcceptingNewWork(); }

  private report(code: string): void { try { this.reportFailure(code); } catch { /* diagnostics must not affect scheduling */ } }

  /** Disabled by default; the caller must first wire every business and rollback dependency. */
  async start(enabled: boolean): Promise<void> {
    if (enabled !== true) return;
    if (this.timer || this.pending) throw new Error('采购卡片调度已启动');
    const generation = ++this.generation;
    let verified = false;
    try { verified = await this.dependencies.verify() === true; } catch { /* fail closed */ }
    if (generation !== this.generation) return;
    if (!verified) throw new Error('采购卡片运行条件未就绪');
    const owner={};this.activationOwner=owner;
    await runHotfixInitialization(owner,()=>{
      if(generation!==this.generation)return;
      this.ready = true;
      this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
      this.timer.unref?.();
    });
  }

  /** One worker pass at a time. Readiness is withdrawn until a failed dependency recovers. */
  async tick(): Promise<void> {
    if (!this.timer || this.pending || !currentHotfixActivation().isAcceptingNewWork()) return;
    const generation = this.generation;
    const work = (async () => {
      try {
        const verified = await this.dependencies.verify() === true;
        if (generation !== this.generation || !currentHotfixActivation().isAcceptingNewWork()) return;
        this.ready = verified;
        if (!verified) { this.report('PURCHASE_LIFECYCLE_NOT_READY'); return; }
        await this.worker.run();
      } catch {
        if (generation === this.generation) {
          this.ready = false;
          this.report('PURCHASE_LIFECYCLE_WORKER_FAILED');
        }
      }
    })();
    this.pending = work;
    try { await work; } finally { if (this.pending === work) this.pending = undefined; }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.ready = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const owner=this.activationOwner;this.activationOwner=undefined;
    if(owner)await cancelHotfixInitialization(owner);
    const pending = this.pending;
    if (pending) await pending;
  }
}
