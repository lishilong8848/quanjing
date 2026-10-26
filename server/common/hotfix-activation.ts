import type { HotfixReleaseProof } from './hotfix-release-proof';

export interface HotfixActivationPorts {
  inspect(): HotfixReleaseProof;
  hasMaintenance(): boolean;
}

type Initializer = { initialize: () => void | Promise<void>; cancelled: boolean; promise?: Promise<void> };
type Phase = 'waiting' | 'initializing' | 'active' | 'failed' | 'closed';

export class HotfixActivation {
  private readonly jobs = new Map<object, Initializer>();
  private readonly deploymentId?: string;
  private proof: HotfixReleaseProof;
  private phase: Phase = 'waiting';
  private bootstrapComplete = false;
  private needsFreshProof = true;
  private failure?: Error;
  private refreshing?: Promise<void>;

  constructor(private readonly ports: HotfixActivationPorts) {
    this.proof = this.readProof();
    this.deploymentId = this.proof.deploymentId;
    if (this.proof.mode === 'invalid') this.fail('HOTFIX_INVALID_RELEASE_PROOF');
  }

  run(owner: object, initialize: () => void | Promise<void>): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.phase === 'closed') return Promise.reject(new Error('HOTFIX_ACTIVATION_CLOSED'));
    const previous = this.jobs.get(owner);
    if (previous) return previous.promise ?? (this.proof.canInitialize ? this.invoke(previous) : Promise.resolve());
    const job: Initializer = { initialize, cancelled: false };
    this.jobs.set(owner, job);
    // A protected Nest hook must return so the real health server can start before commit.
    return this.proof.canInitialize ? this.invoke(job) : Promise.resolve();
  }

  async cancel(owner: object): Promise<void> {
    const job = this.jobs.get(owner);
    if (!job) {
      this.jobs.set(owner, { initialize: () => undefined, cancelled: true });
      return;
    }
    job.cancelled = true;
    if (job.promise) await Promise.allSettled([job.promise]);
  }

  completeBootstrap(): void { this.bootstrapComplete = true; }

  refresh(): Promise<void> {
    if (this.phase === 'closed') return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    if (!this.bootstrapComplete) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const work = this.advance();
    this.refreshing = work;
    const clear = () => { if (this.refreshing === work) this.refreshing = undefined; };
    void work.then(clear, clear);
    return work;
  }

  async close(): Promise<void> {
    this.phase = 'closed';
    this.needsFreshProof = true;
    for (const job of this.jobs.values()) job.cancelled = true;
    await Promise.allSettled([...this.jobs.values()].flatMap(job => job.promise ? [job.promise] : []));
  }

  isAcceptingNewWork(): boolean {
    try {
      if (this.ports.hasMaintenance()) this.needsFreshProof = true;
    } catch (cause) { this.fail('HOTFIX_MAINTENANCE_UNREADABLE', cause); }
    return !this.failure && this.phase === 'active' && !this.needsFreshProof && this.proof.canAcceptNewWork;
  }

  status(): { phase: Phase; deploymentId?: string; reason?: string } {
    return { phase: this.phase, deploymentId: this.deploymentId, reason: this.failure?.message };
  }

  private fail(reason: string, cause?: unknown): Error {
    this.failure ??= new Error(reason, { cause });
    if (this.phase !== 'closed') this.phase = 'failed';
    this.needsFreshProof = true;
    return this.failure;
  }

  private inspect(): void {
    if (this.failure) throw this.failure;
    let proof: HotfixReleaseProof;
    try { proof = this.readProof(); }
    catch (cause) { throw this.fail('HOTFIX_INVALID_RELEASE_PROOF', cause); }
    if (proof.mode === 'invalid') throw this.fail('HOTFIX_INVALID_RELEASE_PROOF');
    if (proof.deploymentId !== this.deploymentId) throw this.fail('HOTFIX_RUNTIME_IDENTITY_CHANGED');
    this.proof = proof;
  }

  private readProof(): HotfixReleaseProof {
    let proof = this.ports.inspect();
    for (let retry = 0; retry < 2 && proof.mode === 'invalid' && proof.reason === 'PROOF_CHANGED_DURING_READ'; retry++) {
      proof = this.ports.inspect();
    }
    return proof;
  }

  private invoke(job: Initializer): Promise<void> {
    if (job.promise) return job.promise;
    if (job.cancelled || this.phase === 'closed') return Promise.resolve();
    this.phase = 'initializing';
    job.promise = Promise.resolve().then(async () => {
      if (job.cancelled || this.phase === 'closed') return;
      if (this.failure) throw this.failure;
      try { await job.initialize(); }
      catch (cause) { throw this.fail('HOTFIX_INITIALIZATION_FAILED', cause); }
    });
    return job.promise;
  }

  private async advance(): Promise<void> {
    this.inspect();
    if (!this.proof.canInitialize) {
      this.phase = 'waiting'; this.needsFreshProof = true;
      return;
    }
    for (const job of this.jobs.values()) {
      if (this.phase === 'closed') return;
      this.inspect();
      if (!this.proof.canInitialize) throw this.fail('HOTFIX_INITIALIZATION_PERMISSION_LOST');
      await this.invoke(job);
    }
    if (this.phase === 'closed') return;
    this.inspect();
    if (!this.proof.canInitialize) throw this.fail('HOTFIX_INITIALIZATION_PERMISSION_LOST');
    this.phase = 'active';
    try { this.needsFreshProof = this.ports.hasMaintenance() || !this.proof.canAcceptNewWork; }
    catch (cause) { throw this.fail('HOTFIX_MAINTENANCE_UNREADABLE', cause); }
  }
}
