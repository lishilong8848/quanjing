import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Optional, ServiceUnavailableException, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { PurchaseOnlineApprovalAcceptedResponse, PurchaseOnlineApprovalRequest, PurchaseOnlineApprovalTaskStatusResponse } from '../../../shared/purchase-inventory.interface';
import type { PurchaseWorkflowSession } from './purchase-workflow.service';
import type { PurchaseWorkflowStore } from './purchase-workflow.store';
import type { PlatformLegacyApprovalWorkerGateway } from './purchase-platform-legacy-approval-worker';
import { createPlatformLegacyApprovalWorker } from './purchase-platform-legacy-approval-worker';
import { isSelectablePlatformLegacyPurchaseMethod } from './purchase-platform-legacy-approval-policy';
import { readEnv } from '../../common/config/external-services.config';
import { cancelHotfixInitialization, currentHotfixActivation, runHotfixInitialization } from '../../common/hotfix-runtime-activation';

export const PURCHASE_PLATFORM_APPROVAL_RUNTIME = 'PURCHASE_PLATFORM_APPROVAL_RUNTIME';
/** The real source gateway (app-token reads/writes + empty-cell permission check). */
export const PURCHASE_PLATFORM_APPROVAL_SOURCE = 'PURCHASE_PLATFORM_APPROVAL_SOURCE';
/** Explicit recovery switch. Absent/invalid options mean "never scan in background". */
export const PURCHASE_PLATFORM_RECOVERY_OPTIONS = 'PURCHASE_PLATFORM_RECOVERY_OPTIONS';
export interface PlatformLegacyApprovalSource extends PlatformLegacyApprovalWorkerGateway { sourceIdentity(): { appId: string; sourceFingerprint: string } }
export type PlatformLegacyApprovalRecoveryOptions = { enabled?: boolean; intervalMs?: number };

function sourceProblem(source: unknown): string | undefined {
  const candidate = source as PlatformLegacyApprovalSource | undefined;
  const identity = candidate && typeof candidate.sourceIdentity === 'function' ? candidate.sourceIdentity() : undefined;
  if (!identity || !/^cli_[A-Za-z0-9_-]{1,120}$/.test(identity.appId || '') || !/^[a-f0-9]{64}$/.test(identity.sourceFingerprint || '')) return '采购审批数据源身份不完整';
  if (typeof source !== 'object' || source === null || typeof candidate!.verifyMarker !== 'function' || typeof candidate!.readSnapshot !== 'function' || typeof candidate!.writeDecision !== 'function') return '采购审批持久账本网关缺少读写能力';
  return undefined;
}

/** Only a healthy source may back a durable runtime: a broken gateway would make
 * queued web approvals silently unrecoverable. */
export function createPurchasePlatformApprovalRuntime(store: PurchaseWorkflowStore, source: PlatformLegacyApprovalSource, recoveryOptions: PlatformLegacyApprovalRecoveryOptions = {}): PurchasePlatformApprovalRuntime {
  const problem = sourceProblem(source);
  if (problem) throw new ServiceUnavailableException(problem);
  const { enabled, intervalMs } = recoveryOptions || {};
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new ServiceUnavailableException('采购审批恢复配置无效');
  if (intervalMs !== undefined && (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3_600_000)) throw new ServiceUnavailableException('采购审批恢复间隔无效');
  if (store === undefined || store === null) throw new ServiceUnavailableException('采购审批持久账本不可用');
  return new PurchasePlatformApprovalRuntime(store, source, recoveryOptions);
}

/** Recovery starts only when the caller explicitly enables it after readiness
 * checks; there are no implicit background writes after a restart. */
@Injectable()
export class PurchasePlatformApprovalRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly worker;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryActive = false;
  private recoveryRunning = false;
  private recoveryCursor = '';
  private recoveryGeneration = 0;
  private destroyed = false;
  constructor(readonly store: PurchaseWorkflowStore, readonly source: PlatformLegacyApprovalSource,
    @Optional() @Inject(PURCHASE_PLATFORM_RECOVERY_OPTIONS) readonly recoveryOptions: PlatformLegacyApprovalRecoveryOptions = {}) {
    this.worker = createPlatformLegacyApprovalWorker(store,{
      verifyMarker: fingerprint => source.verifyMarker(fingerprint),
      readSnapshot: (id,fingerprint) => source.readSnapshot(id,fingerprint),
      writeDecision: (id,fields,fingerprint) => { this.assertActivation(); return source.writeDecision(id,fields,fingerprint); },
    });
  }
  onApplicationBootstrap(): Promise<void> {
    return runHotfixInitialization(this, () => {
      if (this.recoveryOptions?.enabled === true) this.startRecovery(this.recoveryOptions.intervalMs);
    });
  }
  private assertActivation(): void {
    if (this.destroyed || !currentHotfixActivation().isAcceptingNewWork()) throw new ServiceUnavailableException('系统更新中，采购审批暂缓处理');
  }
  private async runWorker(eventId:string):Promise<void> { this.assertActivation(); await this.worker.run(eventId); }
  /** Explicitly enabled only by the future production provider after its readiness checks. */
  startRecovery(intervalMs = 60_000): void {
    if (this.destroyed) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3_600_000) throw new BadRequestException('采购审批恢复间隔无效');
    if (this.recoveryActive) return;
    this.recoveryActive = true;
    const generation = ++this.recoveryGeneration;
    const tick = () => {
      this.recoveryTimer = undefined;
      if (!this.recoveryActive || this.recoveryGeneration !== generation) return;
      void this.runRecoveryOnce(() => this.recoveryActive && this.recoveryGeneration === generation).catch(() => undefined).finally(() => {
        if (this.recoveryActive && this.recoveryGeneration === generation) { this.recoveryTimer = setTimeout(tick, intervalMs); this.recoveryTimer.unref?.(); }
      });
    };
    this.recoveryTimer = setTimeout(tick, 0);
    this.recoveryTimer.unref?.();
  }
  stopRecovery(): void {
    this.recoveryActive = false;
    this.recoveryGeneration++;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }
  async onModuleDestroy(): Promise<void> { this.destroyed=true;this.stopRecovery(); await cancelHotfixInitialization(this); }
  async runRecoveryOnce(shouldContinue: () => boolean = () => true): Promise<void> {
    if (this.destroyed || this.recoveryRunning || !currentHotfixActivation().isAcceptingNewWork()) return;
    this.recoveryRunning = true;
    try {
      const events = await this.store.listRecoverablePlatformLegacyApprovals(this.recoveryCursor, 20);
      if (!events.length) { this.recoveryCursor = ''; return; }
      for (const eventId of events) {
        if (!shouldContinue() || !currentHotfixActivation().isAcceptingNewWork()) return;
        this.recoveryCursor = eventId;
        // Every event is independently fenced by the persistent lease. A failure
        // must not starve other tasks or turn an unknown write into a retry.
        try { await this.runWorker(eventId); } catch { /* retain ledger state for the next scan */ }
      }
      if (events.length < 20) this.recoveryCursor = '';
    } finally { this.recoveryRunning = false; }
  }
  async accept(recordId: string, input: PurchaseOnlineApprovalRequest, session: PurchaseWorkflowSession): Promise<PurchaseOnlineApprovalAcceptedResponse> {
    this.assertActivation();
    if (!/^rec[A-Za-z0-9_-]+$/.test(recordId) || !input || Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).some(key => !['decision', 'purchaseMethod'].includes(key)) ||
      !['approved','rejected'].includes(input.decision) ||
      (input.purchaseMethod !== undefined && (input.decision !== 'approved' || !isSelectablePlatformLegacyPurchaseMethod(input.purchaseMethod)))) throw new BadRequestException('采购审批请求无效');
    const identity=session.platformProof;
    if (!identity || !session.assertPlatformProof || !session.assertPlatformPermission) throw new ForbiddenException('采购审批真实会话不可用');
    const origin=this.source.sourceIdentity();
    if (origin.appId !== readEnv('FEISHU_APP_ID') || !/^[a-f0-9]{64}$/.test(origin.sourceFingerprint)) throw new ServiceUnavailableException('采购审批数据源不可用');
    await this.source.verifyMarker(origin.sourceFingerprint);
    const snapshot=await this.source.readSnapshot(recordId,origin.sourceFingerprint);
    if (!snapshot.markerPresent) throw new ServiceUnavailableException('采购审批字段读取不完整');
    const recordMethod = snapshot.record.purchaseMethod;
    if (input.purchaseMethod !== undefined && (input.decision !== 'approved' || !isSelectablePlatformLegacyPurchaseMethod(input.purchaseMethod))) throw new ConflictException('采购方式选择与审批决定冲突');
    if (recordMethod !== '驳回' && recordMethod !== '' && !isSelectablePlatformLegacyPurchaseMethod(recordMethod)) throw new ConflictException('采购原方式不可用');
    const requestId=createHash('sha256').update(JSON.stringify(['platform-legacy-request-v1',origin.appId,recordId,identity.source,identity.actorAccountId,identity.subjectAccountId])).digest('hex');
    const claim=await this.store.claimPlatformLegacyApproval({record:snapshot.record,requestId,decision:input.decision,purchaseMethod:input.purchaseMethod,identity,appId:origin.appId,sourceFingerprint:origin.sourceFingerprint},(_proof,row,mode,appId,sourceFingerprint)=>{
      this.assertActivation();
      const current=this.source.sourceIdentity();
      if (appId !== readEnv('FEISHU_APP_ID') || current.appId !== appId || current.sourceFingerprint !== sourceFingerprint) throw new ForbiddenException('采购审批数据源已变化');
      if (mode==='new') session.assertPlatformProof!('approve',row);
      else session.assertPlatformPermission!('approve',{building:row.building,specialty:row.specialty || undefined});
      return true;
    });
    // The durable ledger remains the source of truth if this process exits.
    void this.runWorker(claim.entry.eventId).catch(()=>undefined);
    return {pending:true,taskId:claim.entry.eventId,message:'审批已受理，正在同步'};
  }
  async status(taskId:string, session:PurchaseWorkflowSession):Promise<PurchaseOnlineApprovalTaskStatusResponse> {
    const identity=session.platformProof;
    if (!identity || !session.assertPlatformPermission) throw new ForbiddenException('审批后台任务不存在或无权访问');
    const appId=readEnv('FEISHU_APP_ID');
    const status=await this.store.getPlatformLegacyApprovalStatus({eventId:taskId,appId,identity},(_proof,target,currentApp)=>{
      if (currentApp !== readEnv('FEISHU_APP_ID')) throw new ForbiddenException('审批后台任务不存在或无权访问');
      session.assertPlatformPermission!('approve',target); return true;
    });
    if (status.status==='pending' || status.status==='running') void this.runWorker(taskId).catch(()=>undefined);
    const displayed=status.status==='manual_reconciliation' ? 'failed' : status.status;
    const message=status.status==='manual_reconciliation' ? '审批结果待核对，请勿重复提交' : status.status==='completed' ? '采购审批已完成' : '审批正在同步';
    return {success:true,task:{id:taskId,recordId:status.recordId,decision:status.decision,status:displayed,message,createdAt:new Date(status.acceptedAtMs).toISOString(),...(status.completedAtMs ? {completedAt:new Date(status.completedAtMs).toISOString()} : {})}};
  }
}
