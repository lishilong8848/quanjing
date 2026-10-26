import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PersonnelRecoveryActor, PersonnelRecoveryRequest } from '../../../shared/personnel-task-recovery.interface';
import { ContractExpiryDispositionService } from './contract-expiry-disposition.service';
import { createHash } from 'node:crypto';
import type { AuthorityDuty } from '../../../shared/personnel-authority.interface';
import type { HandoverAdapter, HandoverContext, PendingDuty, PreflightResult, TransferReceipt, TransferResult } from '../../../shared/personnel-handover.interface';
import { authorityDutyMatchesTarget } from '../../common/access/personnel-authority.duties';
import { confirmedPersonnelDutyTransferVersion } from '../../common/access/personnel-duty-transfer.receipt';
import { feishuIdentityFingerprint } from '../../common/access/feishu-access-approved-grants';
import { ContractWorkflowService, contractNotificationBlocked, contractPaymentDigestBlocked } from './contract-workflow.service';
import { ContractWorkflowStore } from './contract-workflow.store';

@Injectable()
export class ContractPersonnelHandoverAdapter implements HandoverAdapter {
  readonly module = 'contracts' as const;
  constructor(private readonly store: ContractWorkflowStore, private readonly workflow: ContractWorkflowService, private readonly disposition?: ContractExpiryDispositionService) {}

  listRecoveryTasks(){if(!this.disposition)throw new ServiceUnavailableException('合同恢复端口未就绪');return this.disposition.listRecoveryTasks();}
  previewRecoveryTask(input:PersonnelRecoveryRequest){if(!this.disposition)throw new ServiceUnavailableException('合同恢复端口未就绪');return this.disposition.previewRecoveryTask(input);}
  recoverTask(input:PersonnelRecoveryRequest,actor:PersonnelRecoveryActor,authorize:()=>void){if(!this.disposition)throw new ServiceUnavailableException('合同恢复端口未就绪');return this.disposition.recoverTask(input,actor,authorize);}

  async listPending(context: HandoverContext): Promise<PendingDuty[]> {
    return this.listItems(context, false);
  }

  private async listItems(context: HandoverContext, includeTerminal: boolean): Promise<PendingDuty[]> {
    this.assertIdentity(context);
    const duties = this.duties(context), items: PendingDuty[] = [];
    // Contract and payment records stay in Base. Their handling rights follow the one configuration transaction.
    for (const duty of duties.filter(row => row.kind === 'contract_action')) items.push(this.authorityItem(context, duty));
    const actionDuties = duties.filter(row => row.kind === 'contract_action');
    if (actionDuties.length) {
      const appId = process.env.FEISHU_APP_ID?.trim() || '';
      const sourceAccounts = [context.from.id, `feishu-${feishuIdentityFingerprint(appId, context.from.openId!)}`];
      for (const entry of await this.store.listDispositionTasks()) {
        if (!sourceAccounts.includes(entry.principal?.accountId || '') || entry.task.status === 'completed' || entry.task.status === 'failed' && !entry.uncertain) continue;
        if (entry.appId !== appId) throw new ConflictException('原合同处置所属飞书应用已变化');
        const duty = actionDuties.find(row => row.buildings === null && row.specialties === null);
        if (!duty) throw new ConflictException('原合同处置缺少岗位范围，请先核对已受理任务');
        const item = this.item(context, duty, 'disposition', entry.task.id, entry.fingerprint, 'in_progress');
        if (entry.uncertain) item.phase = 'reconcile';
        items.push(item);
      }
    }
    if (!duties.some(duty => duty.kind === 'contract_notify')) return items;
    for (const job of await this.store.listRoleNotifications()) {
      if (job.completedAt && !includeTerminal) continue;
      if (job.appId !== process.env.FEISHU_APP_ID?.trim()) {
        if (job.completedAt) continue;
        throw new ConflictException('原合同通知所属飞书应用已变化');
      }
      const duty = this.notificationDuty(context, job.specialty);
      if (duty) items.push(this.item(context, duty, 'role_notification', job.key, job.fingerprint, job.completedAt ? 'terminal' : 'pending'));
    }
    for (const job of await this.store.listPaymentDigests()) {
      if (job.completedAt && !includeTerminal) continue;
      if (job.appId !== process.env.FEISHU_APP_ID?.trim()) {
        if (job.completedAt) continue;
        throw new ConflictException('原付款提醒所属飞书应用已变化');
      }
      const relevant = new Map<string, AuthorityDuty>();
      for (const candidate of job.candidates) {
        const duty = this.notificationDuty(context, candidate.record.specialty || undefined);
        if (duty) relevant.set(duty.recordId, duty);
      }
      for (const duty of relevant.values()) items.push(this.item(context, duty, 'payment_digest', job.key, job.fingerprint, job.completedAt ? 'terminal' : 'pending'));
    }
    return items;
  }

  async preflight(context: HandoverContext, item: PendingDuty, mutationId?: string): Promise<PreflightResult> {
    try {
      this.assertIdentity(context); await this.assertItem(context, item);
      if (mutationId) this.receiptVersion(context, item, mutationId);
      return { ready: true };
    } catch { return { ready: false, reason: '合同职责、通知内容或岗位交接回执已变化，请重新核对' }; }
  }

  async acceptTransfer(context: HandoverContext, item: PendingDuty, mutationId: string): Promise<TransferReceipt> {
    this.assertIdentity(context); await this.assertItem(context, item);
    const version = this.receiptVersion(context, item, mutationId);
    return { module: 'contracts', itemKey: item.key, recordId: item.recordId, mutationId, version, status: 'accepted' };
  }

  async reconcile(context: HandoverContext, receipt: TransferReceipt, options?: { retryFailed?: boolean }): Promise<TransferResult> {
    try {
      this.assertIdentity(context);
      const item = await this.findItem(context, receipt);
      if (!item || receipt.module !== 'contracts' || this.receiptVersion(context, item, receipt.mutationId) !== receipt.version) throw new ConflictException();
      if (item.stageKey === 'current_authority') return { status: 'success' };
      const authorizeRetry = options?.retryFailed ? () => { this.assertIdentity(context); if(this.receiptVersion(context, item, receipt.mutationId)!==receipt.version)throw new ConflictException('合同恢复岗位回执已变化'); } : undefined;
      if (item.stageKey === 'role_notification') {
        await this.workflow.flushRoleNotifications(item.recordId,authorizeRetry);
        const job = await this.store.getRoleNotification(item.recordId);
        if (!job || job.fingerprint !== item.version) throw new ConflictException();
        return job.completedAt ? { status: 'success' } : contractNotificationBlocked(job) ? { status: 'error', error: '原合同通知回执未确认，请恢复未完成步骤；超出去重保护时间须先核对飞书消息' } : { status: 'syncing' };
      }
      await this.workflow.flushPaymentDigests(authorizeRetry,item.recordId);
      const job = (await this.store.listPaymentDigests()).find(row => row.key === item.recordId);
      if (!job || job.fingerprint !== item.version) throw new ConflictException();
      return job.completedAt ? { status: 'success' } : contractPaymentDigestBlocked(job,await this.store.processedKeys()) ? { status: 'error', error: '原付款通知回执未确认，请恢复未完成步骤；超出去重保护时间须先核对飞书消息' } : { status: 'syncing' };
    } catch { return { status: 'error', error: '合同原通知或当前岗位回执未核对完成，请恢复原交接批次' }; }
  }

  private async assertItem(context: HandoverContext, item: PendingDuty): Promise<void> {
    const current = await this.findItem(context, { recordId: item.recordId, itemKey: item.key });
    if (!current || item.module !== 'contracts' || current.key !== item.key || current.dutyRecordId !== item.dutyRecordId || current.version !== item.version || current.stageKey !== item.stageKey ||
      item.phase !== current.phase || item.status !== 'pending' || JSON.stringify(current.recipients) !== JSON.stringify(item.recipients)) throw new ConflictException('合同交接内容已变化');
  }
  private async findItem(context: HandoverContext, receipt: Pick<TransferReceipt, 'itemKey' | 'recordId'>): Promise<PendingDuty | undefined> {
    return (await this.listItems(context, true)).find(item => item.key === receipt.itemKey && item.recordId === receipt.recordId);
  }
  private duties(context: HandoverContext): AuthorityDuty[] {
    return context.duties.filter(duty => ['contract_action', 'contract_notify'].includes(duty.kind) && (duty.personnelIds.includes(context.from.id) || duty.personnelIds.includes(context.to.id)));
  }
  private notificationDuty(context: HandoverContext, specialty?: string): AuthorityDuty | undefined {
    const duties = this.duties(context).filter(duty => duty.kind === 'contract_notify');
    if (duties.some(duty => duty.buildings !== null)) throw new ConflictException('历史合同通知未维护楼栋，请先核对通知职责范围');
    const matches = duties.filter(duty => authorityDutyMatchesTarget(duty, specialty ? { specialty } : {}));
    if (matches.length > 1) throw new ConflictException('合同通知匹配多个职责，请先合并重叠范围');
    return matches[0];
  }
  private authorityItem(context: HandoverContext, duty: AuthorityDuty): PendingDuty {
    if (!authorityDutyMatchesTarget(duty, { ...(duty.buildings ? { building: duty.buildings } : {}), ...(duty.specialties ? { specialty: duty.specialties } : {}) })) throw new ConflictException('合同办理职责当前未生效');
    return this.item(context, duty, 'current_authority', duty.recordId, hash([duty.recordId, duty.kind, duty.version, duty.buildings, duty.specialties]), 'pending');
  }
  private item(context: HandoverContext, duty: AuthorityDuty, stageKey: string, recordId: string, version: string, status: PendingDuty['status']): PendingDuty {
    return { key: `contracts:${stageKey}:${recordId}:${duty.recordId}`, module: 'contracts', recordId, dutyRecordId: duty.recordId,
      title: stageKey === 'current_authority' ? `${duty.name} · 合同与付款办理` : stageKey === 'payment_digest' ? '付款提醒' : '合同通知',
      phase: stageKey === 'current_authority' ? 'execution' : 'notification', stageKey, version, status, recipients: [{ name: context.from.name, openId: context.from.openId! }] };
  }
  private receiptVersion(context: HandoverContext, item: PendingDuty, mutationId: string): string {
    return confirmedPersonnelDutyTransferVersion(context, item, mutationId);
  }
  private assertIdentity(context: HandoverContext): void {
    if (!context.to.active || !context.from.openId || !context.to.openId || context.from.id === context.to.id || context.from.openId === context.to.openId) throw new ConflictException('合同交接人员身份无效');
  }
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
