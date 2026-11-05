import { PurchaseLifecycleRuntime } from './purchase-lifecycle-runtime';
import { PurchaseLifecycleDeliveryService } from './purchase-lifecycle-delivery.service';
import { PurchaseLifecycleServerAuthorizer } from './purchase-lifecycle-delivery-authorizer';
import { PurchaseLifecycleGatewayRecordSource } from './purchase-lifecycle-gateway-record-source';

type Store = ConstructorParameters<typeof PurchaseLifecycleDeliveryService>[0] & ConstructorParameters<typeof PurchaseLifecycleGatewayRecordSource>[0];
type Gateway = ConstructorParameters<typeof PurchaseLifecycleDeliveryService>[2] & ConstructorParameters<typeof PurchaseLifecycleGatewayRecordSource>[1];
type Access = ConstructorParameters<typeof PurchaseLifecycleServerAuthorizer>[0];
type Environment = NonNullable<ConstructorParameters<typeof PurchaseLifecycleServerAuthorizer>[2]>;
type Check = () => Promise<boolean>;
export type LifecycleRuntimeMode = 'off' | 'drain' | 'new';
export type LifecycleStopStatus = 'clear' | 'pending' | 'unknown';

/** Proofs must be backed by actual production guards, not static feature flags. */
export interface LifecycleRuntimeChecks {
  writerFence: Check;
  applicationRecovery: Check;
  callbacksAndMessages: Check;
  attachmentsAndPayments: Check;
  identityAndAuthorization: Check;
  rollbackProtection: Check;
  deliveryAndReconciliation: Check;
  /** Includes in-flight, deferred, unconfirmed and future continuation work. */
  hasExistingWork: Check;
}

export interface LifecycleIsolatedFactoryOptions {
  store: Store;
  gateway: Gateway;
  access: Access;
  currentAppId: () => string;
  environment: Environment;
  attachmentBaseUrl: () => string;
  /** Actual synchronous upload capability; absent keeps write links hidden. */
  paymentUploadReady?: () => boolean;
  receiptUploadReady?: () => boolean;
  sourceGuard?: () => Promise<void>;
  checks: LifecycleRuntimeChecks;
  reportFailure: (code: string) => void;
  clock?: () => number;
  intervalMs?: number;
}

/**
 * Not a Nest provider and never started on construction. The caller must supply
 * durable, cross-process proof implementations before wiring it to the app.
 */
export class PurchaseLifecycleIsolatedFactory {
  private readonly runtime: PurchaseLifecycleRuntime;
  private mode: LifecycleRuntimeMode = 'off';
  private transition: Promise<void> = Promise.resolve();

  constructor(private readonly options: LifecycleIsolatedFactoryOptions) {
    const clock = options.clock || Date.now;
    const source = new PurchaseLifecycleGatewayRecordSource(options.store, options.gateway, options.currentAppId, clock, options.sourceGuard);
    const authorizer = new PurchaseLifecycleServerAuthorizer(options.access, source, options.environment, options.currentAppId);
    const worker = new PurchaseLifecycleDeliveryService(options.store, authorizer, options.gateway, clock, options.attachmentBaseUrl, options.receiptUploadReady, options.paymentUploadReady);
    this.runtime = new PurchaseLifecycleRuntime(worker, { verify: () => this.verify() }, options.reportFailure, options.intervalMs);
  }

  /** This admission gate must not be used as a worker-health indicator in drain mode. */
  isReady(): boolean { return this.mode === 'new' && this.runtime.isReady(); }
  isProcessing(): boolean { return this.mode !== 'off' && this.runtime.isReady(); }

  start(mode: LifecycleRuntimeMode): Promise<void> {
    return this.serialize(async () => {
      if (mode !== 'off' && mode !== 'drain' && mode !== 'new') throw new Error('采购卡片运行模式无效');
      if (this.mode !== 'off') throw new Error('采购卡片运行器已启动');
      if (mode === 'off') {
        const status = await this.existingWork();
        if (status !== 'clear') throw new Error(status === 'pending' ? '存在采购卡片任务，需要继续处理或人工核对' : '采购卡片任务状态无法核对');
        return;
      }
      await this.runtime.start(true);
      this.mode = mode;
    });
  }

  /** Stopping only pauses processing; pending or unknown work is explicitly returned. */
  async stop(): Promise<LifecycleStopStatus> {
    let status: LifecycleStopStatus = 'unknown';
    await this.serialize(async () => {
      await this.runtime.stop();
      this.mode = 'off';
      status = await this.existingWork();
      if (status !== 'clear') {
        try { this.options.reportFailure(status === 'pending' ? 'PURCHASE_LIFECYCLE_WORK_PENDING' : 'PURCHASE_LIFECYCLE_WORK_UNKNOWN'); } catch { /* reporting cannot stop shutdown */ }
      }
    });
    return status;
  }

  private async existingWork(): Promise<LifecycleStopStatus> {
    try {
      if (typeof this.options.checks?.hasExistingWork !== 'function') return 'unknown';
      const result: unknown = await this.options.checks.hasExistingWork();
      return result === true ? 'pending' : result === false ? 'clear' : 'unknown';
    } catch { return 'unknown'; }
  }

  private async verify(): Promise<boolean> {
    try {
      const appId = this.options.currentAppId();
      if (!/^cli_[A-Za-z0-9_-]+$/.test(appId)) return false;
      const checks = this.options.checks;
      const names: Array<keyof Omit<LifecycleRuntimeChecks, 'hasExistingWork'>> = ['writerFence', 'applicationRecovery', 'callbacksAndMessages', 'attachmentsAndPayments', 'identityAndAuthorization', 'rollbackProtection', 'deliveryAndReconciliation'];
      for (const name of names) if (typeof checks?.[name] !== 'function' || await checks[name]() !== true) return false;
      if (await this.existingWork() === 'unknown') return false;
      return this.options.currentAppId() === appId;
    } catch { return false; }
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.transition.then(action, action);
    this.transition = next.catch(() => undefined);
    return next;
  }
}
