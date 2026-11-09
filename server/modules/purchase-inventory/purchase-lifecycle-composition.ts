import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { currentHotfixActivation } from '../../common/hotfix-runtime-activation';
import { readEnv } from '../../common/config/external-services.config';
import { PURCHASE_LEDGER_CAPABILITY } from './purchase-ledger-capability';
import capabilities from '../../common/purchase-runtime-capabilities.json';
import { PurchaseWorkflowStore } from './purchase-workflow.store';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import { PurchaseManagerApprovalService } from './purchase-manager-approval.service';
import { PurchaseLifecycleCardTransport } from './purchase-lifecycle-card-transport';
import { PurchaseLifecycleReceiptImageRuntime } from './purchase-lifecycle-receipt-image-runtime';
import { PurchaseLifecycleReceiptPrepareRuntime } from './purchase-lifecycle-receipt-prepare-runtime';
import { PurchaseLifecycleIsolatedFactory } from './purchase-lifecycle-isolated-factory';
import { PURCHASE_PLATFORM_APPROVAL_RUNTIME, PurchasePlatformApprovalRuntime } from './purchase-platform-approval-runtime';
import { lifecyclePaymentUploadSourceFingerprint } from './purchase-lifecycle-payment-upload-gateway';
import { FeishuCardActionConsumer } from './feishu-card-action.consumer';

export function purchaseLifecycleNewApplicationsEnabled(): boolean {
  // This release routes every new application through separate stage cards.
  // Keep the lifecycle runtime available to safely finish existing work.
  return false;
}

/** The single owner starts only after the release is active and the existing
 * shared connection is ready. No constructor, bootstrap hook or HTTP read sends
 * cards. Disabling admission keeps already accepted lifecycle work recoverable. */
@Injectable()
export class PurchaseLifecycleComposition implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PurchaseLifecycleComposition.name);
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private factory?: PurchaseLifecycleIsolatedFactory;
  private destroyed = false;
  private lastFailure = '';
  private sourceFingerprint = '';
  constructor(
    private readonly store: PurchaseWorkflowStore,
    private readonly gateway: PurchaseWorkflowGateway,
    private readonly access: AccessConfigurationService,
    private readonly manager: PurchaseManagerApprovalService,
    private readonly transport: PurchaseLifecycleCardTransport,
    private readonly images: PurchaseLifecycleReceiptImageRuntime,
    private readonly prepare: PurchaseLifecycleReceiptPrepareRuntime,
    @Inject(PURCHASE_PLATFORM_APPROVAL_RUNTIME) private readonly approvals: PurchasePlatformApprovalRuntime,
    private readonly consumer: FeishuCardActionConsumer,
  ) {}

  onApplicationBootstrap(): void {
    if (this.timer || this.destroyed) return;
    this.timer = setInterval(() => { void this.ensureStarted(); }, 5_000);
    this.timer.unref?.();
  }
  isReady(): boolean { return purchaseLifecycleNewApplicationsEnabled() && this.isProcessing() && this.factory?.isReady() === true; }
  isProcessing(): boolean {
    return !this.destroyed && this.activationReady() && this.currentSourceMatches() &&
      this.manager.isEnabled() && this.transport.isReady() && this.images.isReady() && this.factory?.isProcessing() === true;
  }
  private activationReady(): boolean {
    return process.env.PURCHASE_LEDGER_RUNTIME_CAPABILITY === PURCHASE_LEDGER_CAPABILITY &&
      capabilities.capabilities.includes(PURCHASE_LEDGER_CAPABILITY) && currentHotfixActivation().isAcceptingNewWork();
  }
  private currentSourceMatches(): boolean {
    try { return !!this.sourceFingerprint && this.sourceFingerprint === lifecyclePaymentUploadSourceFingerprint(); } catch { return false; }
  }
  private async verifySource(): Promise<boolean> {
    if (!this.currentSourceMatches()) return false;
    await this.store.verifyLifecycleReceiptImageSource(readEnv('FEISHU_APP_ID'), this.sourceFingerprint);
    return this.currentSourceMatches();
  }
  private report(code: string): void {
    if (this.lastFailure === code) return;
    this.lastFailure = code;
    this.logger.warn(code);
  }
  async ensureStarted(): Promise<void> {
    if (this.destroyed || this.pending || this.factory || !this.activationReady()) return;
    const work = this.start(); this.pending = work;
    try { await work; } catch { this.report('PURCHASE_LIFECYCLE_START_PENDING'); }
    finally { if (this.pending === work) this.pending = undefined; }
  }
  private async start(): Promise<void> {
    const enabled = purchaseLifecycleNewApplicationsEnabled();
    if (!enabled && !await this.store.hasExistingLifecycleWork()) return;
    if (!this.manager.isEnabled()) return;
    await this.consumer.ensureConnected();
    if (this.destroyed || !this.activationReady() || !this.transport.isReady()) return;
    // Validate the link before binding any new-format ledger state.
    const base = readEnv('PUBLIC_BASE_URL', ['FEISHU_PUBLIC_BASE_URL', 'APP_PUBLIC_URL']);
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('采购卡片平台地址无效');
    const appId = readEnv('FEISHU_APP_ID');
    const snapshot = this.access.snapshot();
    if (snapshot.appId !== appId || !Number.isSafeInteger(snapshot.revision)) throw new Error('采购权限配置来源不匹配');
    this.sourceFingerprint = lifecyclePaymentUploadSourceFingerprint();
    if (this.destroyed || !this.activationReady()) return;
    await this.images.start();
    if (this.destroyed || !this.activationReady() || !await this.verifySource()) return;
    this.prepare.startRecovery();
    const factory = new PurchaseLifecycleIsolatedFactory({
      store: this.store, gateway: this.gateway, access: this.access,
      currentAppId: () => readEnv('FEISHU_APP_ID'), environment: () => ({ ...process.env, FEISHU_APP_ID: readEnv('FEISHU_APP_ID') }),
      attachmentBaseUrl: () => readEnv('PUBLIC_BASE_URL', ['FEISHU_PUBLIC_BASE_URL', 'APP_PUBLIC_URL']),
      receiptUploadReady: () => this.images.isReady(), paymentUploadReady: () => this.isProcessing(),
      sourceGuard: () => this.verifySourceOrThrow(),
      sourceFingerprint: lifecyclePaymentUploadSourceFingerprint,
      reportFailure: code => this.report(code),
      checks: {
        writerFence: () => this.verifySource(),
        applicationRecovery: async () => typeof this.store.registerManagerApprovalBatch === 'function' && typeof this.store.claimPlatformLegacyApproval === 'function' && this.approvals.store === this.store,
        callbacksAndMessages: async () => this.transport.isReady() && this.images.isReady() && this.manager.isEnabled(),
        attachmentsAndPayments: async () => this.images.isReady() && this.currentSourceMatches() && Buffer.byteLength(readEnv('FEISHU_PURCHASE_CARD_ATTACHMENT_SECRET', ['FEISHU_APP_SECRET']), 'utf8') >= 16,
        identityAndAuthorization: async () => { const current = this.access.snapshot(); return current.appId === appId && Number.isSafeInteger(current.revision) && (current.schemaVersion === 1 || current.schemaVersion === 2); },
        rollbackProtection: async () => this.activationReady(),
        deliveryAndReconciliation: async () => typeof this.gateway.sendLifecycleCard === 'function' && typeof this.gateway.updateLifecycleCard === 'function' && typeof this.store.recoverExpiredPreparedLifecycleDelivery === 'function' && typeof this.store.listPendingLifecycleDeliveries === 'function',
        hasExistingWork: () => this.store.hasExistingLifecycleWork(),
      },
    });
    try { await factory.start(enabled ? 'new' : 'drain'); }
    catch (error) { await factory.stop(); throw error; }
    if (this.destroyed) { await factory.stop(); return; }
    this.factory = factory;
    this.approvals.setLifecycleReadiness(() => this.isProcessing());
    this.lastFailure = '';
  }
  private async verifySourceOrThrow(): Promise<void> { if (!await this.verifySource()) throw new Error('采购卡片来源已变化'); }
  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    this.approvals.setLifecycleReadiness(() => false);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
    await this.factory?.stop();
    this.factory = undefined;
    this.prepare.stopRecovery();
  }
}
