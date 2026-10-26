import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthorityDuty } from '../../../shared/personnel-authority.interface';
import type { HandoverAdapter, HandoverContext, PendingDuty, PreflightResult, TransferReceipt, TransferResult } from '../../../shared/personnel-handover.interface';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import { authorityDutyMatchesTarget } from '../../common/access/personnel-authority.duties';
import { InventoryOutboundApprovalStore } from './inventory-outbound-approval.store';
import { InventoryOutboundApprovalService } from './inventory-outbound-approval.service';
import type { InventoryOutboundApprovalEntry } from './inventory-outbound-approval.types';
import { inventoryManagerNotificationGeneration, inventoryManagerNotificationRecipients, inventoryManagerNotificationState } from './inventory-manager-notification-route';
import {confirmedPersonnelDutyTransferVersion} from '../../common/access/personnel-duty-transfer.receipt';

@Injectable()
export class InventoryPersonnelHandoverAdapter implements HandoverAdapter {
  readonly module = 'inventory' as const;
  constructor(
    private readonly store: InventoryOutboundApprovalStore,
    private readonly configuration: AccessConfigurationService,
    private readonly workflow: InventoryOutboundApprovalService,
  ) {}

  async listPending(context: HandoverContext): Promise<PendingDuty[]> {
    if (!this.workflow.isEnabled()) throw new ServiceUnavailableException('出库审批工作流未启用');
    const result: PendingDuty[] = [];
    for (const entry of await this.store.listEntries()) {
      if (entry.personnelHandover || !context.from.openId) continue;
      const notificationDuty = this.duty(context, entry, 'warehouse_notify');
      if (notificationDuty && inventoryManagerNotificationRecipients(entry).some(person => person.openId === context.from.openId)) {
        const generation = inventoryManagerNotificationGeneration(entry);
        const state = inventoryManagerNotificationState(entry, context.from.openId);
        result.push({ key: this.notificationKey(entry, generation), module: 'inventory', recordId: entry.snapshot.recordId,
          title: `${entry.snapshot.applicantName} · ${entry.snapshot.itemName}`, dutyRecordId: notificationDuty.recordId,
          phase: state === 'reconcile' ? 'reconcile' : 'notification', stageKey: 'warehouse_notify',
          version: `${entry.snapshot.version}.${generation}`, status: state === 'terminal' ? 'terminal' : 'pending',
          recipients: inventoryManagerNotificationRecipients(entry).map(({ openId, name }) => ({ openId, name })) });
      }
      const duty = this.duty(context, entry); if (!duty) continue;
      this.assertIndependentNotificationCovered(entry, context);
      if (!entry.snapshot.approvers.some(person => person.openId === context.from.openId)) continue;
      const uncertain = entry.decision ? unfinishedDecision(entry) : entry.registration.status !== 'ready' || entry.approvalCards.some(card => card.status === 'running' || card.status === 'error' && card.attemptCount > 0);
      result.push({ key: this.itemKey(entry), module: 'inventory', recordId: entry.snapshot.recordId,
        title: `${entry.snapshot.applicantName} · ${entry.snapshot.itemName}`, dutyRecordId: duty.recordId,
        phase: uncertain ? 'reconcile' : 'approval', stageKey: 'approval', version: String(entry.snapshot.version),
        status: entry.decision && !uncertain ? 'terminal' : 'pending', recipients: entry.snapshot.approvers });
    }
    return result;
  }

  async preflight(context: HandoverContext, item: PendingDuty, mutationId?:string): Promise<PreflightResult> {
    try {
      if (item.stageKey === 'warehouse_notify') return await this.preflightNotification(context, item, mutationId);
      this.assertTarget(context); const entry = await this.entry(item.recordId, Number(item.version)); this.assertItem(context, item, entry);
      if (entry.personnelHandover) return this.matchesPrior(context,item,entry,mutationId) ? {ready:true} : {ready:false,reason:'原出库交接回执或人员不一致，请恢复原交接'};
      this.assertIndependentNotificationCovered(entry, context);
      if (entry.decision) return { ready: false, alreadyCompleted:true, reason: '原出库审批已合法受理，保留原决定与历史' };
      if (entry.snapshot.applicantOpenId === context.to.openId) return { ready: false, reason: '接任人不能审批自己的出库申请' };
      if (entry.registration.status !== 'ready' || entry.approvalCards.some(card => card.status === 'running' || card.status === 'error' && card.attemptCount > 0)) return { ready: false, reason: '原出库审批投递尚未确认，请先恢复原任务' };
      return { ready: true };
    } catch { return { ready: false, reason: '出库人员、职责或版本已变化，请核对后重试' }; }
  }

  async acceptTransfer(context: HandoverContext, item: PendingDuty, mutationId: string): Promise<TransferReceipt> {
    if (item.stageKey === 'warehouse_notify') return this.acceptNotification(context, item, mutationId);
    this.assertTarget(context); const entry = await this.entry(item.recordId, Number(item.version)); this.assertItem(context, item, entry);
    const prior = entry.personnelHandover;
    if (prior && !this.matchesPrior(context,item,entry,mutationId)) throw new ConflictException('出库交接人员回执不一致');
    if (!prior) this.assertIndependentNotificationCovered(entry, context, true);
    const result = await this.store.acceptPendingHandover({ recordId: item.recordId, expectedVersion: Number(item.version), mutationId,
      dutyRecordId: item.dutyRecordId, sourcePersonRecordId: context.from.recordId, sourceOpenId: context.from.openId!,
      target: prior?.target ?? { personRecordId: context.to.recordId, openId: context.to.openId!, name: context.to.name } });
    return { itemKey: item.key, mutationId, module: 'inventory', recordId: item.recordId, version: String(result.version), status: result.status };
  }

  async reconcile(context: HandoverContext, receipt: TransferReceipt, options?:{retryFailed?:boolean}): Promise<TransferResult> {
    if (receipt.itemKey.includes(':0-notification:')) return this.reconcileNotification(context, receipt,options);
    const failed: TransferResult = { status: 'error', error: '出库交接回执或人员状态不一致，请核对后恢复' };
    if (receipt.module !== 'inventory' || !Number.isSafeInteger(Number(receipt.version))) return failed;
    const sourceVersion = receipt.status === 'accepted' ? Number(receipt.version) - 1 : Number(receipt.version);
    const previous = await this.store.find(receipt.recordId, sourceVersion);
    if (!previous || receipt.itemKey !== this.itemKey(previous)) return failed;
    if (receipt.status === 'already_completed') return previous.decision && previous.snapshot.approvers.some(person => person.openId === context.from.openId) ? { status: 'success' } : failed;
    const handover = previous.personnelHandover;
    if (!handover || handover.mutationId !== receipt.mutationId || handover.sourcePersonRecordId !== context.from.recordId ||
      handover.sourceOpenId !== context.from.openId || handover.target.personRecordId !== context.to.recordId || handover.target.openId !== context.to.openId ||
      handover.targetVersion !== Number(receipt.version)) return failed;
    try { this.assertTarget(context); if (this.duty(context, previous)?.recordId !== handover.dutyRecordId) return failed; } catch { return failed; }
    const next = await this.store.find(receipt.recordId, handover.targetVersion); if (!next) return failed;
    if(options?.retryFailed){
      try{
        await this.store.retryHandoverWork(receipt.recordId,sourceVersion,receipt.mutationId,()=>{
          this.assertTarget(context);confirmedPersonnelDutyTransferVersion(context,{key:receipt.itemKey,module:'inventory',recordId:receipt.recordId,title:'出库交接',dutyRecordId:handover.dutyRecordId,stageKey:'approval',phase:'approval',status:'pending',version:String(sourceVersion),recipients:[{openId:context.from.openId!,name:context.from.name}]},receipt.mutationId);
        });
        return this.reconcile(context,receipt);
      }catch{return failed;}
    }
    if (next.registration.lastError || previous.cardPatches.some(patch => patch.status === 'error') || next.approvalCards.some(card => card.status === 'error')) return { status: 'error', error: '出库旧卡、外部状态或新负责人投递尚未完成，请恢复原任务' };
    if (previous.cardPatches.some(patch => patch.status !== 'completed') || next.registration.status !== 'ready') return { status: 'syncing' };
    return next.decision || next.approvalCards.every(card => card.status === 'completed' && Boolean(card.messageId)) ? { status: 'success' } : { status: 'syncing' };
  }

  private assertTarget(context: HandoverContext): void {
    if (!this.workflow.isEnabled() || !context.to.active || !context.from.openId || !context.to.openId || context.from.id === context.to.id ||
      context.from.openId === context.to.openId || !/^rec[A-Za-z0-9_]+$/u.test(context.from.recordId) || !/^rec[A-Za-z0-9_]+$/u.test(context.to.recordId)) throw new ConflictException('出库交接人员身份无效');
    assertFeishuBusinessIdentity(this.configuration, context.to.openId);
  }
  private async entry(recordId: string, version: number): Promise<InventoryOutboundApprovalEntry> {
    const entry = await this.store.find(recordId, version); if (!entry) throw new ConflictException('原出库审批版本不存在'); return entry;
  }
  private itemKey(entry: InventoryOutboundApprovalEntry): string { return `inventory:${entry.snapshot.recordId}:approval:${entry.snapshot.version}`; }
  private matchesPrior(context:HandoverContext,item:PendingDuty,entry:InventoryOutboundApprovalEntry,mutationId?:string):boolean {
    const prior=entry.personnelHandover;
    return !!prior&&prior.mutationId===mutationId&&prior.recordId===item.recordId&&prior.expectedVersion===Number(item.version)&&prior.targetVersion===Number(item.version)+1&&prior.dutyRecordId===item.dutyRecordId&&prior.sourcePersonRecordId===context.from.recordId&&prior.sourceOpenId===context.from.openId&&prior.target.personRecordId===context.to.recordId&&prior.target.openId===context.to.openId;
  }
  private assertItem(context: HandoverContext, item: PendingDuty, entry: InventoryOutboundApprovalEntry): void {
    const recipients=Array.isArray(item.recipients)?item.recipients.map(person=>person?.openId):[];
    if (item.module !== 'inventory' || item.recordId!==entry.snapshot.recordId || item.phase !== 'approval' || item.status!=='pending' || item.stageKey !== 'approval' || item.key !== this.itemKey(entry) ||
      !entry.snapshot.approvers.some(person=>person.openId===context.from.openId)||new Set(recipients).size!==recipients.length||JSON.stringify([...recipients].sort())!==JSON.stringify(entry.snapshot.approvers.map(person=>person.openId).sort())||
      item.version !== String(entry.snapshot.version) || this.duty(context, entry)?.recordId !== item.dutyRecordId) throw new ConflictException('出库交接职责或版本不一致');
  }
  private duty(context: HandoverContext, entry: InventoryOutboundApprovalEntry, kind: 'warehouse_approver' | 'warehouse_notify' = 'warehouse_approver'): AuthorityDuty | undefined {
    const matches = context.duties.filter(duty => duty.kind === kind &&
      (duty.personnelIds.includes(context.from.id) || duty.personnelIds.includes(context.to.id)) && authorityDutyMatchesTarget(duty, { building: entry.snapshot.building }));
    if (matches.length > 1) throw new ConflictException('出库审批匹配多个岗位职责，请先核对'); return matches[0];
  }
  private notificationKey(entry: InventoryOutboundApprovalEntry, generation: number): string {
    return `inventory:${entry.snapshot.recordId}:0-notification:${entry.snapshot.version}:${generation}`;
  }
  private notificationVersion(value: string): { version: number; generation: number } {
    if (!/^[1-9]\d*\.[1-9]\d*$/.test(value)) throw new ConflictException('库房知会版本无效');
    const [version, generation] = value.split('.').map(Number);
    if (!Number.isSafeInteger(version) || !Number.isSafeInteger(generation)) throw new ConflictException('库房知会版本无效');
    return { version, generation };
  }
  private assertNotificationItem(context: HandoverContext, item: PendingDuty, entry: InventoryOutboundApprovalEntry, generation: number): void {
    const historical = inventoryManagerNotificationRecipients({ snapshot: entry.snapshot,
      managerNotificationHandovers: (entry.managerNotificationHandovers || []).filter(route => route.targetGeneration <= generation) });
    const expected = historical.map(person => person.openId).sort();
    const actual = Array.isArray(item.recipients) ? item.recipients.map(person => person?.openId).sort() : [];
    if (item.module !== 'inventory' || item.recordId !== entry.snapshot.recordId || item.key !== this.notificationKey(entry, generation) ||
      item.stageKey !== 'warehouse_notify' || item.phase !== 'notification' || item.status !== 'pending' ||
      !historical.some(person => person.openId === context.from.openId) || JSON.stringify(actual) !== JSON.stringify(expected) ||
      this.duty(context, entry, 'warehouse_notify')?.recordId !== item.dutyRecordId) throw new ConflictException('库房知会职责或接收人版本不一致');
  }
  private matchesNotification(context: HandoverContext, item: PendingDuty, entry: InventoryOutboundApprovalEntry, mutationId?: string): boolean {
    const { generation } = this.notificationVersion(item.version);
    const route = entry.managerNotificationHandovers?.find(value => value.expectedGeneration === generation);
    return !!route && route.mutationId === mutationId && route.dutyRecordId === item.dutyRecordId &&
      route.sourcePersonRecordId === context.from.recordId && route.sourceOpenId === context.from.openId &&
      route.target.personRecordId === context.to.recordId && route.target.openId === context.to.openId;
  }
  private async preflightNotification(context: HandoverContext, item: PendingDuty, mutationId?: string): Promise<PreflightResult> {
    this.assertTarget(context);
    const { version, generation } = this.notificationVersion(item.version), entry = await this.entry(item.recordId, version);
    this.assertNotificationItem(context, item, entry, generation);
    if (this.matchesNotification(context, item, entry, mutationId)) return { ready: true };
    if (entry.personnelHandover || inventoryManagerNotificationGeneration(entry) !== generation) return { ready: false, reason: '库房知会职责已变化，请恢复原交接' };
    const state = inventoryManagerNotificationState(entry, context.from.openId!);
    return state === 'terminal' ? { ready: false, alreadyCompleted: true, reason: '原岗位通知已送达，保留历史' } :
      state === 'reconcile' ? { ready: false, reason: '原结果通知投递尚未确认，请先对账' } : { ready: true };
  }
  private async acceptNotification(context: HandoverContext, item: PendingDuty, mutationId: string): Promise<TransferReceipt> {
    this.assertTarget(context);
    const { version, generation } = this.notificationVersion(item.version), entry = await this.entry(item.recordId, version);
    this.assertNotificationItem(context, item, entry, generation);
    const prior = entry.managerNotificationHandovers?.find(route => route.expectedGeneration === generation);
    if (prior && !this.matchesNotification(context, item, entry, mutationId)) throw new ConflictException('库房知会交接回执人员不一致');
    const result = await this.store.acceptManagerNotificationHandover({ recordId: item.recordId, expectedVersion: version,
      expectedGeneration: generation, mutationId, dutyRecordId: item.dutyRecordId, sourcePersonRecordId: context.from.recordId,
      sourceOpenId: context.from.openId!, target: prior?.target || { personRecordId: context.to.recordId, openId: context.to.openId!, name: context.to.name } });
    return { itemKey: item.key, module: 'inventory', recordId: item.recordId, mutationId,
      version: `${version}.${result.generation}`, status: result.status };
  }
  private async reconcileNotification(context: HandoverContext, receipt: TransferReceipt,options?:{retryFailed?:boolean}): Promise<TransferResult> {
    const failed: TransferResult = { status: 'error', error: '库房知会交接回执或人员状态不一致' };
    try {
      this.assertTarget(context);
      const { version, generation } = this.notificationVersion(receipt.version), entry = await this.entry(receipt.recordId, version);
      const sourceGeneration = receipt.status === 'accepted' ? generation - 1 : generation;
      if (receipt.module !== 'inventory' || receipt.itemKey !== this.notificationKey(entry, sourceGeneration)) return failed;
      if (receipt.status === 'already_completed') return inventoryManagerNotificationState(entry, context.from.openId!) === 'terminal' ? { status: 'success' } : failed;
      const route = entry.managerNotificationHandovers?.find(value => value.mutationId === receipt.mutationId);
      if (!route || route.targetGeneration !== generation || route.expectedGeneration !== sourceGeneration ||
        route.sourcePersonRecordId !== context.from.recordId || route.sourceOpenId !== context.from.openId ||
        route.target.personRecordId !== context.to.recordId || route.target.openId !== context.to.openId ||
        this.duty(context, entry, 'warehouse_notify')?.recordId !== route.dutyRecordId) return failed;
      if (!entry.decision) return { status: 'success' };
      const work = entry.resultNotifications.find(value => value.recipientOpenId === route.target.openId) ||
        entry.cardPatches.find(value => value.recipientOpenId === route.target.openId);
      if (!work) return failed;
      if(options?.retryFailed){
        await this.store.retryHandoverWork(receipt.recordId,version,receipt.mutationId,()=>{
          this.assertTarget(context);confirmedPersonnelDutyTransferVersion(context,{key:receipt.itemKey,module:'inventory',recordId:receipt.recordId,title:'库房知会交接',dutyRecordId:route.dutyRecordId,stageKey:'manager_notification',phase:'notification',status:'pending',version:`${version}.${sourceGeneration}`,recipients:[{openId:context.from.openId!,name:context.from.name}]},receipt.mutationId);
        });
        return this.reconcileNotification(context,receipt);
      }
      return work.status === 'completed' ? { status: 'success' } : work.status === 'error' ?
        { status: 'error', error: '接任者岗位通知尚未送达，请恢复原任务' } : { status: 'syncing' };
    } catch { return failed; }
  }
  private assertIndependentNotificationCovered(entry: InventoryOutboundApprovalEntry, context: HandoverContext, requireTransferred = false): void {
    if (inventoryManagerNotificationRecipients(entry).some(person => person.openId === context.from.openId) &&
      inventoryManagerNotificationState(entry, context.from.openId!) !== 'terminal' &&
      (requireTransferred || !this.duty(context, entry, 'warehouse_notify'))) {
      throw new ConflictException('前任另有未完成的库房知会职责，须先单独转交，不能只转审批');
    }
  }
}

function unfinishedDecision(entry:InventoryOutboundApprovalEntry):boolean {
  const unfinished=(status:string)=>status!=='completed'&&status!=='cancelled';
  return entry.registration.status!=='ready'||!entry.baseSync||unfinished(entry.baseSync.status)||[...entry.approvalCards,...entry.cardPatches,...entry.resultNotifications].some(work=>unfinished(work.status));
}
