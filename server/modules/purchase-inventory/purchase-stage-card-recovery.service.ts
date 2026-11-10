import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { cancelHotfixInitialization, currentHotfixActivation, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { readEnv } from '../../common/config/external-services.config';
import { purchaseLifecycleNewApplicationsEnabled } from './purchase-lifecycle-composition';
import { PurchaseManagerApprovalService } from './purchase-manager-approval.service';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import { PurchaseWorkflowStore } from './purchase-workflow.store';

/** Reconcile existing delivered cards using the application's single ledger writer. */
@Injectable()
export class PurchaseStageCardRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PurchaseStageCardRecoveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private stopped = false;
  private readonly reported = new Set<string>();

  constructor(
    private readonly store: PurchaseWorkflowStore,
    private readonly gateway: PurchaseWorkflowGateway,
    private readonly manager: PurchaseManagerApprovalService,
  ) {}

  async onModuleInit(): Promise<void> {
    await runHotfixInitialization(this, () => {
      // The activation gate is still initializing while this callback runs.
      // Register the worker here and verify acceptance again on each poll.
      if (this.timer || !this.configured()) return;
      this.timer = setInterval(() => { void this.runPending(); }, 30_000);
      this.timer.unref?.();
      void this.runPending();
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await cancelHotfixInitialization(this);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
  }

  private configured(): boolean {
    return !this.stopped && process.env.NODE_ENV === 'production' &&
      !/^(?:1|true|on|yes)$/iu.test(process.env.NANTONG_HOTFIX_SMOKE_MODE || '') &&
      !purchaseLifecycleNewApplicationsEnabled() && this.manager.isEnabled();
  }

  private enabled(): boolean {
    return this.configured() && currentHotfixActivation().isAcceptingNewWork();
  }

  runPending(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.enabled()) return Promise.resolve();
    this.pending = this.recover().catch(() => {
      this.report('scan');
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async recover(): Promise<void> {
    const appId = readEnv('FEISHU_APP_ID');
    const candidates = await this.store.listLifecycleStageCardTransitionCandidates();
    for (const candidate of candidates) {
      if (!this.enabled() || readEnv('FEISHU_APP_ID') !== appId) return;
      try {
        if (candidate.appId !== appId) throw new Error('采购应用身份已变化');
        const verifiedAt = Date.now();
        for (const replica of candidate.replicas) {
          await this.gateway.readLifecycleCardForStageTransition(appId, replica.messageId, replica.sentAtMs);
        }
        const source = await this.gateway.readRecordsForStageTransition(appId, candidate.recordIds);
        if (!this.enabled() || readEnv('FEISHU_APP_ID') !== appId) return;
        await this.store.transitionLifecycleBatchToStageCards({ ...candidate, ...source, verifiedAt });
        this.reported.delete(candidate.approvalBatchId);
      } catch {
        this.report(candidate.approvalBatchId);
      }
    }
    const retirements = await this.store.listStageCardRetirementTargets();
    for (const target of retirements) {
      if (!this.enabled() || target.appId !== appId || readEnv('FEISHU_APP_ID') !== appId) return;
      try {
        await this.gateway.readLifecycleCardForStageTransition(appId, target.messageId, target.sentAtMs);
        await this.gateway.updateLifecycleCard(target.messageId, {
          schema: '2.0',
          config: { update_multi: true, enable_forward: false },
          header: { template: 'grey', title: { tag: 'plain_text', content: '采购已恢复分阶段办理' } },
          body: { elements: [{ tag: 'markdown', content: '此全流程卡片已结束。审批、下单、签收和入库将使用各环节独立卡片，已有办理结果已保留。' }] },
        }, appId);
        await this.store.markStageCardReplicaRetired(target.approvalBatchId, appId, target.messageId);
        this.reported.delete(target.messageId);
      } catch {
        this.report(target.messageId);
      }
    }
    if (this.enabled() && readEnv('FEISHU_APP_ID') === appId) {
      await this.manager.requeueFailedMigratedOrderCards(appId);
    }
  }

  private report(key: string): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.logger.warn(`采购分阶段卡片恢复待核对，保留原状态等待重试：${key}`);
  }
}
