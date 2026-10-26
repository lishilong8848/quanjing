import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthorityDuty } from '../../../shared/personnel-authority.interface';
import type { PurchasePendingInboundItem } from '../../../shared/inventory-management.interface';
import type { HandoverAdapter, HandoverContext, PendingDuty, PreflightResult, TransferReceipt, TransferResult } from '../../../shared/personnel-handover.interface';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import { authorityDutyMatchesTarget } from '../../common/access/personnel-authority.duties';
import { handoverPersonAccounts } from '../../common/access/personnel-handover.authority';
import { confirmedPersonnelDutyTransferVersion } from '../../common/access/personnel-duty-transfer.receipt';
import { PurchaseWorkflowStore } from '../purchase-inventory/purchase-workflow.store';
import { InventoryInboundTaskLedgerStore } from './inventory-inbound-task-ledger.store';
import { PurchaseInboundConfirmationService } from './purchase-inbound-confirmation.service';
import type { InboundResponsibilityHandoverInput } from './inventory-inbound-responsibility';

@Injectable()
export class InventoryInboundHandoverAdapter implements HandoverAdapter {
  readonly module = 'inventory' as const;
  constructor(
    private readonly ledger: InventoryInboundTaskLedgerStore,
    private readonly pending: PurchaseInboundConfirmationService,
    private readonly notices: PurchaseWorkflowStore,
    private readonly configuration: AccessConfigurationService,
  ) {}

  async listPending(context: HandoverContext): Promise<PendingDuty[]> {
    if (!context.from.openId) return [];
    const [{ items }, plans, notifications, acceptedRecordIds] = await Promise.all([
      this.pending.listPending(), this.ledger.purchaseResponsibilities(),
      this.notices.listNotifications({ kind: 'warehouse_inbound', recipientOpenId: context.from.openId }),
      this.ledger.acceptedPurchaseTaskRecordIds(),
    ]);
    const result: PendingDuty[] = [];
    for (const row of items) {
      const duty = this.duty(context, row); if (!duty) continue;
      const plan = plans[row.executionRecordId];
      if (plan && (plan.target.personRecordId !== context.from.recordId || plan.target.openId !== context.from.openId)) continue;
      const uncertain = notifications.some(value => value.recordId === row.executionRecordId && (value.status === 'processing' || value.status === 'manual_reconciliation' || value.sendOutcome === 'unknown' || value.sendOutcome === 'manual_reconciliation'));
      const generation = plan?.generation || 1, hash = this.fingerprint(row);
      result.push({ key: this.key(row.executionRecordId, generation, hash), module: 'inventory', recordId: row.executionRecordId,
        title: `${row.requestCode} · ${row.itemName}`, dutyRecordId: duty.recordId, phase: uncertain ? 'reconcile' : 'execution',
        stageKey: 'purchase_inbound', status: acceptedRecordIds.includes(row.executionRecordId) ? 'terminal' : 'pending',
        version: `${generation}.${hash}`, recipients: [{ openId: context.from.openId, name: context.from.name }] });
    }
    return result;
  }

  async preflight(context: HandoverContext, item: PendingDuty, mutationId?: string): Promise<PreflightResult> {
    try {
      this.assertItem(context, item);
      const prior = (await this.ledger.purchaseResponsibility(item.recordId))?.handovers.find(value => value.mutationId === mutationId);
      if (prior) { this.assertPrior(context, item, prior); return { ready: true }; }
      await this.fresh(context, item);
      if (await this.ledger.hasAcceptedPurchaseTask(item.recordId)) return { ready: false, alreadyCompleted: true, reason: '原入库任务已合法受理，保留原执行' };
      const notices = await this.notices.listNotifications({ recordId: item.recordId, kind: 'warehouse_inbound', recipientOpenId: context.from.openId });
      if (notices.some(value => value.status === 'processing' || value.sendOutcome === 'unknown' || value.sendOutcome === 'manual_reconciliation' || value.status === 'manual_reconciliation')) return { ready: false, reason: '原待入库提醒尚需核对，请恢复原任务' };
      return { ready: true };
    } catch { return { ready: false, reason: '入库人员、职责或采购记录已变化，请重新核对' }; }
  }

  async acceptTransfer(context: HandoverContext, item: PendingDuty, mutationId: string): Promise<TransferReceipt> {
    this.assertItem(context, item);
    const prior = (await this.ledger.purchaseResponsibility(item.recordId))?.handovers.find(value => value.mutationId === mutationId);
    const { generation, hash } = this.version(item.version);
    if (prior) this.assertPrior(context, item, prior); else await this.fresh(context, item);
    const state = this.configuration.snapshot();
    const person = (value: HandoverContext['from']) => ({ personRecordId: value.recordId, openId: value.openId!, name: value.name,
      accountIds: handoverPersonAccounts(state, value).map(account => account.id).sort() });
    const input: InboundResponsibilityHandoverInput = prior ? {
      recordId: prior.recordId, expectedGeneration: prior.expectedGeneration, recordFingerprint: prior.recordFingerprint,
      mutationId: prior.mutationId, dutyRecordId: prior.dutyRecordId, source: prior.source, target: prior.target,
    } : { recordId: item.recordId, expectedGeneration: generation,
      recordFingerprint: hash, mutationId, dutyRecordId: item.dutyRecordId, source: person(context.from), target: person(context.to) };
    const accepted = await this.ledger.handoverPurchaseResponsibility(input);
    if (accepted.status === 'accepted') await this.notices.acceptWarehouseInboundHandover({ recordId: item.recordId, expectedGeneration: generation, mutationId,
      dutyRecordId: input.dutyRecordId, sourcePersonRecordId: input.source.personRecordId, sourceOpenId: input.source.openId,
      target: { personRecordId: input.target.personRecordId, openId: input.target.openId, name: input.target.name } });
    return { itemKey: item.key, module: 'inventory', recordId: item.recordId, mutationId, version: `${accepted.generation}.${hash}`, status: accepted.status };
  }

  async reconcile(context: HandoverContext, receipt: TransferReceipt, options?: {retryFailed?:boolean}): Promise<TransferResult> {
    const error: TransferResult = { status: 'error', error: '入库交接回执或人员状态不一致，请恢复原批次' };
    try {
      this.assertTarget(context);
      const { generation, hash } = this.version(receipt.version), sourceGeneration = receipt.status === 'accepted' ? generation - 1 : generation;
      if (receipt.module !== 'inventory' || receipt.itemKey !== this.key(receipt.recordId, sourceGeneration, hash)) return error;
      if (receipt.status === 'already_completed') return await this.ledger.hasAcceptedPurchaseTask(receipt.recordId) ? { status: 'success' } : error;
      const prior = (await this.ledger.purchaseResponsibility(receipt.recordId))?.handovers.find(value => value.mutationId === receipt.mutationId);
      if (!prior || prior.expectedGeneration !== sourceGeneration || prior.recordFingerprint !== hash || prior.source.personRecordId !== context.from.recordId ||
        prior.source.openId !== context.from.openId || prior.target.personRecordId !== context.to.recordId || prior.target.openId !== context.to.openId ||
        !context.duties.some(duty => duty.recordId === prior.dutyRecordId && duty.kind === 'warehouse_approver')) return error;
      const job = await this.notices.findWarehouseInboundHandover(receipt.mutationId);
      if (!job || job.recordId !== prior.recordId || job.expectedGeneration !== sourceGeneration || job.target.personRecordId !== context.to.recordId || job.target.openId !== context.to.openId || job.dutyRecordId !== prior.dutyRecordId || job.sourceOpenId !== context.from.openId || job.sourcePersonRecordId !== context.from.recordId) return error;
      if(options?.retryFailed){
        await this.notices.retryWarehouseInboundHandover(receipt.mutationId,()=>{
          this.assertTarget(context);
          confirmedPersonnelDutyTransferVersion(context,{key:receipt.itemKey,module:'inventory',recordId:receipt.recordId,title:'入库交接',dutyRecordId:prior.dutyRecordId,stageKey:'purchase_inbound',phase:'execution',status:'pending',version:`${sourceGeneration}.${hash}`,recipients:[{openId:context.from.openId!,name:context.from.name}]},receipt.mutationId);
        });
        return this.reconcile(context,receipt);
      }
      if (job.status === 'failed') return { status: 'error', error: '待入库提醒旧卡或新投递尚未完成，请恢复原任务' };
      if (job.status !== 'completed' || !job.deliveryDisposition) return { status: 'syncing' };
      return { status: 'success' };
    } catch { return error; }
  }

  private assertTarget(context: HandoverContext): void {
    if (!context.to.active || !context.from.openId || !context.to.openId || context.from.id === context.to.id || context.from.openId === context.to.openId || context.from.recordId === context.to.recordId) throw new ConflictException('入库交接身份无效');
    assertFeishuBusinessIdentity(this.configuration, context.to.openId);
  }
  private assertItem(context: HandoverContext, item: PendingDuty): void {
    this.assertTarget(context); const { generation, hash } = this.version(item.version);
    if (item.module !== 'inventory' || item.phase !== 'execution' || item.status !== 'pending' || item.stageKey !== 'purchase_inbound' ||
      item.key !== this.key(item.recordId, generation, hash) || item.recipients.length !== 1 || item.recipients[0].openId !== context.from.openId ||
      !context.duties.some(value => value.recordId === item.dutyRecordId && value.kind === 'warehouse_approver')) throw new ConflictException('入库交接清单无效');
  }
  private assertPrior(context: HandoverContext, item: PendingDuty, prior: InboundResponsibilityHandoverInput): void {
    const { generation, hash } = this.version(item.version);
    if (prior.recordId !== item.recordId || prior.expectedGeneration !== generation || prior.recordFingerprint !== hash || prior.dutyRecordId !== item.dutyRecordId ||
      prior.source.personRecordId !== context.from.recordId || prior.source.openId !== context.from.openId || prior.target.personRecordId !== context.to.recordId || prior.target.openId !== context.to.openId) throw new ConflictException('入库原交接人员或载荷不一致');
  }
  private async fresh(context: HandoverContext, item: PendingDuty): Promise<void> {
    const row = (await this.pending.listPending()).items.find(value => value.executionRecordId === item.recordId);
    const { generation, hash } = this.version(item.version), plan = await this.ledger.purchaseResponsibility(item.recordId);
    if (!row || this.fingerprint(row) !== hash || (plan?.generation || 1) !== generation || this.duty(context, row)?.recordId !== item.dutyRecordId ||
      plan && (plan.target.personRecordId !== context.from.recordId || plan.target.openId !== context.from.openId)) throw new ConflictException('入库责任或采购记录已变化');
  }
  private duty(context: HandoverContext, row: PurchasePendingInboundItem): AuthorityDuty | undefined {
    const matches = context.duties.filter(value => value.kind === 'warehouse_approver' && (value.personnelIds.includes(context.from.id) || value.personnelIds.includes(context.to.id)) && authorityDutyMatchesTarget(value, { building: row.building, ...(row.specialty ? { specialty: row.specialty } : {}) }));
    if (matches.length > 1) throw new ConflictException('待入库匹配多个库房职责，请先核对'); return matches[0];
  }
  private fingerprint(row: PurchasePendingInboundItem): string {
    return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'responsibilityGeneration').sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
  }
  private version(value: string): { generation: number; hash: string } {
    if (!/^[1-9]\d*\.[a-f0-9]{64}$/.test(value)) throw new ConflictException('入库责任版本无效');
    const [generation, hash] = value.split('.'); if (!Number.isSafeInteger(Number(generation))) throw new ConflictException('入库责任版本无效'); return { generation: Number(generation), hash };
  }
  private key(recordId: string, generation: number, hash: string): string { return `inventory:${recordId}:purchase_inbound:${generation}:${hash}`; }
}
