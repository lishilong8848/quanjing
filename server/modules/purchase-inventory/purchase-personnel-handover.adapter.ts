import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthorityDuty } from '../../../shared/personnel-authority.interface';
import type { HandoverAdapter, HandoverContext, PendingDuty, PreflightResult, TransferReceipt, TransferResult } from '../../../shared/personnel-handover.interface';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import { authorityDutyMatchesTarget } from '../../common/access/personnel-authority.duties';
import { parsePurchaseManagerBatchApprovalCardContext } from './purchase-manager-batch-approval-card';
import { PurchaseManagerApprovalService } from './purchase-manager-approval.service';
import { PurchaseWorkflowStore, managerBatchDeliveries, managerBatchCardView, type PurchaseManagerApprovalBatchEntry, type PurchaseManagerBatchHandover } from './purchase-workflow.store';
import type { PurchaseManagerApprovalCardEntry } from './purchase-workflow.store';
import { parsePurchaseManagerApprovalCardContext } from './purchase-manager-approval-card';
import { singleManagerCardVersion, singleManagerReceiptVersion, singleManagerAcceptedVersion } from './purchase-single-handover';
import { confirmedPersonnelDutyTransferVersion } from '../../common/access/personnel-duty-transfer.receipt';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import { purchaseAuthorityTarget, type PurchaseAuthorityTarget } from './purchase-authority-target';
import { purchaseExecutorVersion, purchaseExecutorReceiptVersion } from './purchase-executor-handover';
import { resolvePurchaseStage, normalizeMethod } from './purchase-workflow.rules';
import type { PurchaseManagerApprovalBatchItemEntry } from './purchase-workflow.store';
import { PurchaseWorkflowService } from './purchase-workflow.service';
import { legacyApprovalVersion, legacyApprovalReceiptVersion, legacyApprovalAcceptedVersion } from './purchase-legacy-approval-handover';
import { handoverPersonAccounts } from '../../common/access/personnel-handover.authority';
import { PurchaseWorkflowReceiptTaskService } from './purchase-workflow-receipt-task.service';
import type { PersonnelRecoveryActor, PersonnelRecoveryRequest } from '../../../shared/personnel-task-recovery.interface';

@Injectable()
export class PurchasePersonnelHandoverAdapter implements HandoverAdapter {
  readonly module = 'purchase' as const;
  constructor(private readonly store: PurchaseWorkflowStore, private readonly configuration: AccessConfigurationService, private readonly workflow: PurchaseManagerApprovalService, private readonly gateway?: PurchaseWorkflowGateway, private readonly legacyWorkflow?: PurchaseWorkflowService, private readonly receiptTasks?:PurchaseWorkflowReceiptTaskService) {}
  listRecoveryTasks(){if(!this.receiptTasks)throw new ServiceUnavailableException('签收恢复端口未就绪');return this.receiptTasks.listRecoveryTasks();}
  previewRecoveryTask(input:PersonnelRecoveryRequest){if(!this.receiptTasks)throw new ServiceUnavailableException('签收恢复端口未就绪');return this.receiptTasks.previewRecoveryTask(input);}
  recoverTask(input:PersonnelRecoveryRequest,actor:PersonnelRecoveryActor,authorize:()=>void){if(!this.receiptTasks)throw new ServiceUnavailableException('签收恢复端口未就绪');return this.receiptTasks.recoverTask(input,actor,authorize);}

  async listPending(context: HandoverContext): Promise<PendingDuty[]> {
    this.assertEnabled(); await this.assertSupportedScope(context);
    const items: PendingDuty[] = [];
    for (const id of await this.store.listManagerApprovalBatchIds()) {
      if (!context.duties.some(duty => duty.kind === 'purchase_manager')) break;
      const canonicalBatch = await this.batch(id);
      if (!managerBatchDeliveries(canonicalBatch).some(delivery => delivery.recipientOpenId === context.from.openId)) continue;
      const batch = managerBatchCardView(canonicalBatch, context.from.openId!);
      const duty = await this.duty(context, batch); if (!duty) continue;
      const uncertain = batch.items.some(item => item.status === 'manual_reconciliation') || !batch.cardContext || !batch.messageId;
      items.push({ key: this.itemKey(id), module: 'purchase', recordId: id, title: `采购申请 · ${id}`, dutyRecordId: duty.recordId,
        phase: uncertain ? 'reconcile' : 'approval', stageKey: 'manager_batch', version: String(batch.revision),
        status: batch.items.some(item => item.status === 'processing') ? 'in_progress' : batch.items.some(item => item.status === 'pending') || uncertain ? 'pending' : 'terminal',
        recipients: [{ name: context.from.name, openId: batch.recipientOpenId }] });
    }
    const single=await this.store.singleManagerHandoverSnapshot();
    for(const card of single.cards){
      if(card.recipientOpenId!==context.from.openId||card.personnelHandover)continue;
      const duty=this.singleDuty(context,card);if(!duty)continue;
      const action=single.actions.find(value=>value.recordId===card.executionRecordId&&value.status!=='failed');
      const unknown=card.state==='manual_reconciliation'||single.notifications.some(task=>task.recordId===card.executionRecordId&&task.recipientOpenId===card.recipientOpenId&&task.status!=='completed');
      items.push({key:this.singleKey(card.executionRecordId,card.recipientOpenId),module:'purchase',recordId:card.executionRecordId,title:`采购申请 · ${parsePurchaseManagerApprovalCardContext(card.cardContext).title}`,dutyRecordId:duty.recordId,stageKey:'single_manager',phase:unknown?'reconcile':'approval',version:singleManagerCardVersion(card),status:card.state==='resolved'?'terminal':action?'in_progress':'pending',recipients:[{openId:card.recipientOpenId,name:context.from.name}]});
    }
    if (context.duties.some(duty => ['purchase_executor', 'building_executor'].includes(duty.kind))) {
      const snapshot = await this.store.executorHandoverSnapshot();
      for (const batch of snapshot.batches) for (const entry of batch.items) {
        if (entry.status !== 'approved' || entry.purchaserOpenId !== context.from.openId || entry.executorHandover && !entry.executorHandover.ready) continue;
        const record = await this.gateway!.getExecutionRecordAsApp(entry.executionRecordId), scope = purchaseAuthorityTarget(record);
        if (!scope) throw new ConflictException('采购原明细楼栋或专业无法确定，请核对后预览');
        if (scope.building !== parsePurchaseManagerBatchApprovalCardContext(batch.cardContext).building || entry.authorityTarget && JSON.stringify(entry.authorityTarget) !== JSON.stringify(scope)) throw new ConflictException('采购原批次与明细范围不一致，请核对');
        const duty = this.executorDuty(context, entry, scope); if (!duty) continue;
        if (resolvePurchaseStage(record.status) !== 'ordering' || record.purchaseCompleted) continue;
        const accepted = this.executorAccepted(snapshot, entry.executionRecordId);
        items.push({ key: this.executorKey(batch.approvalBatchId, entry.executionRecordId), module: 'purchase', recordId: entry.executionRecordId,
          title: `采购执行 · ${record.itemName}`, dutyRecordId: duty.recordId, phase: 'execution', stageKey: duty.kind,
          version: purchaseExecutorVersion(batch.approvalBatchId, entry, scope), status: accepted ? 'in_progress' : 'pending', recipients: [{ openId: context.from.openId!, name: context.from.name }] });
      }
    }
    if (context.duties.some(duty => duty.kind === 'purchase_approver')) {
      const sources = await this.store.listNotifications({ kind: 'approval_requested', recipientOpenId: context.from.openId });
      const actions = await this.store.listCardActions();
      for (const source of sources) {
        if (source.approvalHandover) continue;
        const record = await this.gateway!.getExecutionRecordAsApp(source.recordId), scope = purchaseAuthorityTarget(record);
        if (!scope) throw new ConflictException('采购原审批范围不明确');
        const duty = this.legacyDuty(context, scope); if (!duty || resolvePurchaseStage(record.status) !== 'application') continue;
        const action = actions.find(row => row.recordId === source.recordId), uncertain = source.status !== 'completed' || !source.messageId || action?.status === 'failed';
        items.push({ key: this.legacyKey(source.recordId, source.recipientOpenId), module: 'purchase', recordId: source.recordId, title: `采购审批 · ${record.itemName}`,
          dutyRecordId: duty.recordId, phase: uncertain ? 'reconcile' : 'approval', stageKey: 'legacy_approver', version: legacyApprovalVersion(source, scope),
          status: action && action.status !== 'failed' ? 'in_progress' : 'pending', recipients: [{ openId: source.recipientOpenId, name: context.from.name }] });
      }
    }
    const webReceipts = await this.store.listNotifications({ kind: 'web_receipt_command' });
    if (webReceipts.length) {
      const owners = new Set(handoverPersonAccounts(this.configuration.snapshot(), context.from).map(account => account.id));
      owners.add(context.from.id);
      for (const task of webReceipts) {
        const payload = task.webReceipt;
        if (!payload || !owners.has(payload.ownerId) || task.status === 'completed') continue;
        const duty = context.duties.find(row => ['purchase_manager', 'purchase_approver', 'purchase_executor', 'building_executor', 'building_supervisor', 'professional_supervisor', 'professional_engineer'].includes(row.kind) && row.personnelIds.includes(context.from.id) && authorityDutyMatchesTarget(row, payload.scope));
        if (!duty) continue;
        items.push({ key: `purchase:web-receipt:${payload.taskId}`, module: 'purchase', recordId: task.recordId, title: '已受理网页签收', dutyRecordId: duty.recordId,
          phase: task.status === 'failed' || task.status === 'manual_reconciliation' ? 'reconcile' : 'execution', stageKey: 'web_receipt', version: payload.fingerprint, status: 'in_progress', recipients: [{ openId: payload.actor.openId, name: payload.actor.name }] });
      }
    }
    return items;
  }

  async preflight(context: HandoverContext, item: PendingDuty, mutationId?: string): Promise<PreflightResult> {
    if (item.stageKey === 'legacy_approver') {
      try {
        this.assertTarget(context); await this.assertSupportedScope(context);
        const { source } = await this.legacyEntry(context, item, mutationId);
        if (mutationId && source.approvalHandover?.mutationId === mutationId) return { ready: true };
        const action = (await this.store.listCardActions({ recordId: item.recordId }))[0];
        if (action) return { ready: false, ...(action.status === 'failed' ? {} : { alreadyCompleted: true }), reason: '原采购审批已受理，保留或恢复原动作' };
        return { ready: true };
      } catch { return { ready: false, reason: '采购原审批人员、范围或投递凭据已变化，请更新交接清单' }; }
    }
    if (['purchase_executor', 'building_executor'].includes(item.stageKey)) {
      try {
        this.assertTarget(context); await this.assertSupportedScope(context);
        const { entry } = await this.executorEntry(context, item, mutationId);
        if (mutationId && entry.executorHandover?.mutationId === mutationId) return { ready: true };
        if (this.executorAccepted(await this.store.executorHandoverSnapshot(), item.recordId)) return { ready: false, alreadyCompleted: true, reason: '原采购下单已受理，保留原执行' };
        return { ready: true };
      } catch { return { ready: false, reason: '采购原执行人、范围或明细状态已变化，请更新交接清单' }; }
    }
    if(item.stageKey==='single_manager'){
      try{
        this.assertTarget(context);await this.assertSupportedScope(context);
        const snapshot=await this.store.singleManagerHandoverSnapshot(),card=this.singleCard(context,item,snapshot.cards),prior=card.personnelHandover;
        if(prior)return{ready:!!mutationId&&prior.mutationId===mutationId&&prior.sourceVersion===item.version&&prior.sourcePersonRecordId===context.from.recordId&&prior.targetOpenId===context.to.openId&&prior.targetPersonRecordId===context.to.recordId};
        if(snapshot.actions.some(value=>value.recordId===item.recordId&&value.status!=='failed'))return{ready:false,alreadyCompleted:true,reason:'原采购审批已受理，保留原执行'};
        return{ready:singleManagerCardVersion(card)===item.version&&['initial','reject_editing'].includes(card.state)&&!snapshot.notifications.some(task=>task.recordId===item.recordId&&task.recipientOpenId===context.from.openId&&task.status!=='completed'),reason:'原采购审批卡正在同步或已变化，请更新交接清单'};
      }catch{return{ready:false,reason:'采购单条职责、人员或原卡已变化，请核对后重试'};}
    }
    try {
      this.assertTarget(context); await this.assertSupportedScope(context); const batch = await this.batch(item.recordId);
      const prior = mutationId ? (await this.store.listPersonnelHandovers()).find(job => job.mutationId === mutationId) : undefined;
      await this.assertItem(context, item, batch, prior);
      if (prior) return this.sameIdentity(context, prior) ? { ready: true } : { ready: false, reason: '采购原交接人员不一致，请恢复原批次' };
      if (batch.revision !== Number(item.version)) return { ready: false, reason: '采购批次已变化，请重新预览' };
      if (batch.requesterOpenId === context.to.openId) return { ready: false, reason: '接任人不能审批自己的采购申请' };
      if (managerBatchDeliveries(batch).some(delivery => delivery.recipientOpenId === context.to.openId)) return { ready: false, reason: '接任人已持有该批次审批卡，请选择其他接任人' };
      if (!['active', 'reject_editing'].includes(batch.state) || batch.items.some(row => ['processing', 'manual_reconciliation'].includes(row.status))) return { ready: false, reason: '原采购处理或外部结果尚未明确，请保持原执行或先对账' };
      return { ready: true };
    } catch { return { ready: false, reason: '采购人员、职责或原审批阶段已变化，请核对后重试' }; }
  }

  async acceptTransfer(context: HandoverContext, item: PendingDuty, mutationId: string): Promise<TransferReceipt> {
    this.assertTarget(context); await this.assertSupportedScope(context);
    if (item.stageKey === 'legacy_approver') {
      const { source, scope } = await this.legacyEntry(context, item, mutationId);
      const result = await this.store.acceptLegacyApprovalHandover({ sourceNotificationKey: source.key, recordId: item.recordId, sourceOpenId: context.from.openId!, sourcePersonRecordId: context.from.recordId,
        targetOpenId: context.to.openId!, targetPersonRecordId: context.to.recordId, mutationId, expectedVersion: item.version, scope }, () => { confirmedPersonnelDutyTransferVersion(context, item, mutationId); });
      return { itemKey: item.key, module: 'purchase', recordId: item.recordId, mutationId, status: result.status, version: result.version };
    }
    if (['purchase_executor', 'building_executor'].includes(item.stageKey)) {
      const { batch, scope, entry } = await this.executorEntry(context, item, mutationId);
      const result = await this.store.acceptExecutorHandover({ approvalBatchId: batch.approvalBatchId, recordId: item.recordId, mutationId,
        expectedVersion: item.version, sourceOpenId: context.from.openId!, sourcePersonRecordId: context.from.recordId,
        targetOpenId: context.to.openId!, targetPersonRecordId: context.to.recordId, targetName: context.to.name, choice: entry.choice === 'building_self' ? 'building_self' : 'comprehensive', scope }, () => { confirmedPersonnelDutyTransferVersion(context, item, mutationId); });
      return { itemKey: item.key, module: 'purchase', recordId: item.recordId, mutationId, version: result.version, status: result.status };
    }
    if(item.stageKey==='single_manager'){
      const snapshot=await this.store.singleManagerHandoverSnapshot();this.singleCard(context,item,snapshot.cards);
      const result=await this.store.acceptSingleManagerHandover({recordId:item.recordId,sourceOpenId:context.from.openId!,sourcePersonRecordId:context.from.recordId,targetOpenId:context.to.openId!,targetPersonRecordId:context.to.recordId,expectedVersion:item.version,mutationId},()=>{confirmedPersonnelDutyTransferVersion(context,item,mutationId);});
      return{itemKey:item.key,module:'purchase',recordId:item.recordId,mutationId,version:result.version,status:result.status};
    }
    const batch = await this.batch(item.recordId), prior = (await this.store.listPersonnelHandovers()).find(job => job.mutationId === mutationId);
    await this.assertItem(context, item, batch, prior);
    if (prior && !this.sameIdentity(context, prior)) throw new ConflictException('采购交接回执人员不一致');
    const result = await this.store.acceptManagerBatchHandover({ approvalBatchId: item.recordId, expectedRevision: Number(item.version), mutationId,
      dutyRecordId: item.dutyRecordId, sourceOpenId: context.from.openId!, sourcePersonRecordId: context.from.recordId,
      target: prior?.target ?? { personRecordId: context.to.recordId, openId: context.to.openId!, name: context.to.name } });
    return { itemKey: item.key, module: 'purchase', recordId: item.recordId, mutationId, version: String(result.revision), status: result.status };
  }

  async reconcile(context: HandoverContext, receipt: TransferReceipt, options?: {retryFailed?:boolean}): Promise<TransferResult> {
    const failed: TransferResult = { status: 'error', error: '采购交接人员或正式回执不一致，请核对后恢复' };
    if (receipt.itemKey === this.legacyKey(receipt.recordId, context.from.openId || '')) {
      try {
        this.assertTarget(context);
        const sources = (await this.store.listNotifications({ kind: 'approval_requested', recordId: receipt.recordId, recipientOpenId: context.from.openId })).filter(row => row.approvalHandover?.mutationId === receipt.mutationId || receipt.status === 'already_completed' && !row.approvalHandover);
        if (sources.length !== 1 || receipt.module !== 'purchase') return failed;
        const source = sources[0], marker = source.approvalHandover, scope = source.approvalAuthority?.scope || purchaseAuthorityTarget(await this.gateway!.getExecutionRecordAsApp(receipt.recordId));
        const duty = scope && this.legacyDuty(context, scope); if (!duty) return failed;
        confirmedPersonnelDutyTransferVersion(context, { key: receipt.itemKey, module: 'purchase', recordId: receipt.recordId, title: '采购审批交接', dutyRecordId: duty.recordId,
          phase: 'approval', stageKey: 'legacy_approver', status: 'pending', version: marker?.sourceVersion || receipt.version, recipients: [{ openId: context.from.openId!, name: context.from.name }] }, receipt.mutationId);
        const actions = await this.store.listCardActions({ recordId: receipt.recordId });
        if (receipt.status === 'already_completed') return actions.some(action => action.status !== 'failed' && legacyApprovalAcceptedVersion(source, action) === receipt.version) ? { status: 'success' } : failed;
        if (receipt.status !== 'accepted' || !marker || marker.sourcePersonRecordId !== context.from.recordId || marker.targetPersonRecordId !== context.to.recordId || marker.targetOpenId !== context.to.openId || legacyApprovalReceiptVersion(source) !== receipt.version) return failed;
        if (options?.retryFailed) {
          await this.store.retryFailedNotifications([marker.terminalNotificationKey, marker.targetNotificationKey], () => {
            this.assertTarget(context);
            confirmedPersonnelDutyTransferVersion(context, { key: receipt.itemKey, module: 'purchase', recordId: receipt.recordId, title: '采购审批交接', dutyRecordId: duty.recordId, phase: 'approval', stageKey: 'legacy_approver', status: 'pending', version: marker.sourceVersion, recipients: [{openId:context.from.openId!,name:context.from.name}] }, receipt.mutationId);
          });
          return this.reconcile(context, receipt);
        }
        const all = await this.store.listNotifications({ recordId: receipt.recordId }), notices = [marker.terminalNotificationKey, marker.targetNotificationKey].map(key => all.find(row => row.key === key));
        if (notices.some(row => !row || row.lastError || ['failed', 'manual_reconciliation'].includes(row.status))) return { status: 'error', error: '采购原审批卡或现任新卡尚未恢复' };
        if (!notices.every(row => row!.status === 'completed')) return { status: 'syncing' };
        return notices[1]!.messageId || actions.some(action => action.status === 'completed' && !!action.completedAt) ? { status: 'success' } : failed;
      } catch { return failed; }
    }
    if (receipt.itemKey.includes(':executor:')) {
      try {
        this.assertTarget(context);
        const snapshot = await this.store.executorHandoverSnapshot();
        const batch = snapshot.batches.find(row => this.executorKey(row.approvalBatchId, receipt.recordId) === receipt.itemKey);
        const entry = batch?.items.find(row => row.executionRecordId === receipt.recordId), marker = entry?.executorHandover;
        if (!batch || !entry || receipt.module !== 'purchase') return failed;
        const scope = marker?.scope || purchaseAuthorityTarget(await this.gateway!.getExecutionRecordAsApp(receipt.recordId));
        const duty = scope && this.executorDuty(context, entry, scope); if (!duty || !scope) return failed;
        const item: PendingDuty = { key: receipt.itemKey, module: 'purchase', recordId: receipt.recordId, title: '采购执行交接', dutyRecordId: duty.recordId,
          stageKey: duty.kind, phase: 'execution', status: 'pending', version: marker?.sourceVersion || receipt.version, recipients: [{ openId: context.from.openId!, name: context.from.name }] };
        confirmedPersonnelDutyTransferVersion(context, item, receipt.mutationId);
        if (receipt.status === 'already_completed') return this.executorAccepted(snapshot, receipt.recordId) && purchaseExecutorVersion(batch.approvalBatchId, entry, scope) === receipt.version ? { status: 'success' } : failed;
        if (receipt.status !== 'accepted' || !marker || marker.mutationId !== receipt.mutationId || marker.sourcePersonRecordId !== context.from.recordId || marker.sourceOpenId !== context.from.openId ||
          marker.targetPersonRecordId !== context.to.recordId || marker.targetOpenId !== context.to.openId || purchaseExecutorReceiptVersion(marker) !== receipt.version) return failed;
        if (options?.retryFailed) {
          const keys=[marker.notificationKey,marker.targetNotificationKey,marker.refreshNotificationKey].filter(key=>snapshot.notifications.some(task=>task.key===key));
          await this.store.retryFailedNotifications(keys,()=>{this.assertTarget(context);confirmedPersonnelDutyTransferVersion(context,item,receipt.mutationId);});
          return this.reconcile(context,receipt);
        }
        const task = snapshot.notifications.find(row => row.key === marker.notificationKey);
        if (!task && !marker.ready || task && (task.lastError || ['failed', 'manual_reconciliation'].includes(task.status))) return { status: 'error', error: '采购负责人交接尚未恢复，请恢复原任务' };
        if (!marker.ready || task && task.status !== 'completed') return { status: 'syncing' };
        const notices = [marker.targetNotificationKey, marker.refreshNotificationKey].map(key => snapshot.notifications.find(row => row.key === key));
        if (notices.some(row => !row || row.lastError || ['failed', 'manual_reconciliation'].includes(row.status))) return { status: 'error', error: '采购原卡或现任卡投递尚未恢复' };
        return notices.every(row => row!.status === 'completed') && notices[0]!.messageId ? { status: 'success' } : { status: 'syncing' };
      } catch { return failed; }
    }
    if(receipt.itemKey===this.singleKey(receipt.recordId,context.from.openId||'')){
      try{
        this.assertTarget(context);if(receipt.module!=='purchase')return failed;
        const snapshot=await this.store.singleManagerHandoverSnapshot(),card=snapshot.cards.find(value=>value.executionRecordId===receipt.recordId&&value.recipientOpenId===context.from.openId);
        const duty=card&&this.singleDuty(context,card);if(!card||!duty)return failed;
        confirmedPersonnelDutyTransferVersion(context,{key:receipt.itemKey,module:'purchase',recordId:receipt.recordId,title:'采购审批交接',dutyRecordId:duty.recordId,stageKey:'single_manager',phase:'approval',status:'pending',version:card.personnelHandover?.sourceVersion||receipt.version,recipients:[{openId:context.from.openId!,name:context.from.name}]},receipt.mutationId);
        if(receipt.status==='already_completed')return snapshot.actions.some(action=>action.recordId===receipt.recordId&&action.status!=='failed'&&singleManagerAcceptedVersion(card,action)===receipt.version)?{status:'success'}:failed;
        const prior=card.personnelHandover;
        if(receipt.status!=='accepted'||!prior||singleManagerReceiptVersion(card)!==receipt.version||prior.mutationId!==receipt.mutationId||prior.sourcePersonRecordId!==context.from.recordId||prior.targetPersonRecordId!==context.to.recordId||prior.targetOpenId!==context.to.openId)return failed;
        if (options?.retryFailed) {
          await this.store.retryFailedNotifications([prior.terminalNotificationKey,prior.targetNotificationKey],()=>{
            this.assertTarget(context);
            confirmedPersonnelDutyTransferVersion(context,{key:receipt.itemKey,module:'purchase',recordId:receipt.recordId,title:'采购审批交接',dutyRecordId:duty.recordId,stageKey:'single_manager',phase:'approval',status:'pending',version:prior.sourceVersion,recipients:[{openId:context.from.openId!,name:context.from.name}]},receipt.mutationId);
          });
          return this.reconcile(context,receipt);
        }
        const notices=[prior.terminalNotificationKey,prior.targetNotificationKey].map(key=>snapshot.notifications.find(task=>task.key===key));
        if(notices.some(task=>!task||task.status==='failed'||task.status==='manual_reconciliation'||task.lastError))return{status:'error',error:'采购原卡或现任新卡尚未恢复，请核对原投递'};
        if(notices.some(task=>task!.status!=='completed'))return{status:'syncing'};
        const delivered=snapshot.cards.find(value=>value.executionRecordId===receipt.recordId&&value.recipientOpenId===context.to.openId&&value.sourceNotificationKey===prior.targetNotificationKey&&value.messageId===notices[1]!.messageId);
        return delivered?{status:'success'}:failed;
      }catch{return failed;}
    }
    if (receipt.module !== 'purchase' || receipt.itemKey !== this.itemKey(receipt.recordId)) return failed;
    const job = (await this.store.listPersonnelHandovers()).find(entry => entry.mutationId === receipt.mutationId);
    if (receipt.status === 'already_completed') {
      const batch = await this.batch(receipt.recordId);
      return managerBatchDeliveries(batch).some(delivery => delivery.recipientOpenId === context.from.openId) && batch.items.some(item => Boolean(item.actionEventId)) ? { status: 'success' } : failed;
    }
    if (!job || job.approvalBatchId !== receipt.recordId || String(job.targetRevision) !== receipt.version || !this.sameIdentity(context, job)) return failed;
    try { this.assertTarget(context); if ((await this.duty(context, await this.batch(receipt.recordId)))?.recordId !== job.dutyRecordId) return failed; } catch { return failed; }
    if (options?.retryFailed) {
      try {
        const notifications=await this.store.listNotifications({kind:'manager_batch_approval_requested',recipientOpenId:job.target.openId});
        const keys=notifications.filter(task=>task.businessEventId===`manager_batch_approval_requested:${job.approvalBatchId}:h-${job.mutationId.slice(-32)}`).map(task=>task.key);
        await this.store.retryFailedNotifications(keys,()=>{
          this.assertTarget(context);
          confirmedPersonnelDutyTransferVersion(context,{key:receipt.itemKey,module:'purchase',recordId:receipt.recordId,title:'采购批次交接',dutyRecordId:job.dutyRecordId,stageKey:'manager_batch',phase:'approval',status:'pending',version:String(job.expectedRevision),recipients:[{openId:context.from.openId!,name:context.from.name}]},receipt.mutationId);
        });
        return this.reconcile(context,receipt);
      } catch {return failed;}
    }
    if (job.lastError || job.deliveryError || job.status === 'failed') return { status: 'error', error: '采购旧卡、外部状态或新卡回执未完成，请恢复原任务' };
    return job.deliveryConfirmedAt && job.newMessageId ? { status: 'success' } : { status: 'syncing' };
  }

  private assertEnabled(): void { if (!this.workflow.isEnabled() && !this.legacyWorkflow?.isEnabled()) throw new ServiceUnavailableException('采购审批工作流未启用'); }
  private assertTarget(context: HandoverContext): void {
    this.assertEnabled();
    if (!context.to.active || !context.from.openId || !context.to.openId || context.from.id === context.to.id || context.from.openId === context.to.openId ||
      !/^rec[A-Za-z0-9_]+$/u.test(context.from.recordId) || !/^rec[A-Za-z0-9_]+$/u.test(context.to.recordId)) throw new ConflictException('采购交接人员身份无效');
    assertFeishuBusinessIdentity(this.configuration, context.to.openId);
  }
  private async assertSupportedScope(context: HandoverContext): Promise<void> {
    if (context.duties.some(duty => duty.kind === 'purchase_approver') && (!this.gateway || !this.legacyWorkflow?.isEnabled())) throw new ServiceUnavailableException('采购原审批端口或工作流未启用');
    if (context.duties.some(duty => ['purchase_executor', 'building_executor'].includes(duty.kind)) && !this.gateway) throw new ServiceUnavailableException('采购原记录读取端口未配置');
    for (const notification of await this.store.listNotifications({ kind: 'manager_approval_requested', recipientOpenId: context.from.openId })) {
      if (!context.duties.some(duty => duty.kind === 'purchase_manager')) break;
      if (!notification.messageId && notification.status !== 'completed') throw new ServiceUnavailableException('采购旧单卡投递未完成，请先核对');
      if (!notification.messageId) continue;
    }
  }
  private sameIdentity(context: HandoverContext, job: PurchaseManagerBatchHandover): boolean {
    return job.sourcePersonRecordId === context.from.recordId && job.sourceOpenId === context.from.openId && job.target.personRecordId === context.to.recordId && job.target.openId === context.to.openId;
  }
  private executorKey(batchId: string, recordId: string): string { return `purchase:${batchId}:executor:${recordId}`; }
  private legacyKey(recordId: string, source: string): string { return `purchase:${recordId}:legacy-approver:${source}`; }
  private legacyDuty(context: HandoverContext, scope: PurchaseAuthorityTarget): AuthorityDuty | undefined {
    const matches = context.duties.filter(duty => duty.kind === 'purchase_approver' && (duty.personnelIds.includes(context.from.id) || duty.personnelIds.includes(context.to.id)) && authorityDutyMatchesTarget(duty, scope));
    if (matches.length > 1) throw new ConflictException('采购原审批匹配多个岗位，请核对'); return matches[0];
  }
  private async legacyEntry(context: HandoverContext, item: PendingDuty, mutationId?: string) {
    const sources = (await this.store.listNotifications({ kind: 'approval_requested', recordId: item.recordId, recipientOpenId: context.from.openId })).filter(row => !row.approvalHandover || row.approvalHandover.mutationId === mutationId);
    if (sources.length !== 1 || item.module !== 'purchase' || item.key !== this.legacyKey(item.recordId, context.from.openId!) || item.stageKey !== 'legacy_approver' || item.phase !== 'approval' || item.status !== 'pending' || !/^[a-f0-9]{64}$/.test(item.version) || item.recipients.length !== 1 || item.recipients[0].openId !== context.from.openId) throw new ConflictException('采购原审批交接清单无效');
    const source = sources[0], marker = source.approvalHandover, replay = !!mutationId && marker?.mutationId === mutationId;
    const record = replay ? undefined : await this.gateway!.getExecutionRecordAsApp(item.recordId), scope = replay ? source.approvalAuthority?.scope : purchaseAuthorityTarget(record!);
    if (!scope || this.legacyDuty(context, scope)?.recordId !== item.dutyRecordId || source.status !== 'completed' || !source.messageId) throw new ConflictException('采购原审批职责或回执不一致');
    if (replay) {
      if (marker!.sourceVersion !== item.version || marker!.sourcePersonRecordId !== context.from.recordId || marker!.targetPersonRecordId !== context.to.recordId || marker!.targetOpenId !== context.to.openId) throw new ConflictException('采购原审批交接人员不一致');
    } else if (resolvePurchaseStage(record!.status) !== 'application' || legacyApprovalVersion(source, scope) !== item.version) throw new ConflictException('采购原审批版本已变化');
    if (!replay) {
      const targets = (await this.store.listNotifications({ kind: 'approval_requested', recordId: item.recordId, recipientOpenId: context.to.openId })).filter(row => !row.approvalHandover);
      if (targets.length > 1 || targets.some(row => row.status !== 'completed' || !row.messageId || row.approvalAuthority && JSON.stringify(row.approvalAuthority.scope) !== JSON.stringify(scope))) throw new ConflictException('接任人原采购审批投递尚未确认');
    }
    return { source, scope };
  }
  private executorDuty(context: HandoverContext, entry: PurchaseManagerApprovalBatchItemEntry, scope: PurchaseAuthorityTarget): AuthorityDuty | undefined {
    const kind = entry.choice === 'comprehensive' ? 'purchase_executor' : entry.choice === 'building_self' ? 'building_executor' : '';
    const matches = context.duties.filter(duty => duty.kind === kind && (duty.personnelIds.includes(context.from.id) || duty.personnelIds.includes(context.to.id)) && authorityDutyMatchesTarget(duty, scope));
    if (matches.length > 1) throw new ConflictException('采购执行匹配多个岗位，请核对'); return matches[0];
  }
  private executorAccepted(snapshot: Awaited<ReturnType<PurchaseWorkflowStore['executorHandoverSnapshot']>>, recordId: string): boolean {
    return snapshot.commands.some(row => row.recordId === recordId && row.action === 'order') || snapshot.notifications.some(row => row.recordId === recordId && row.kind === 'manager_batch_order_command' && row.status !== 'failed');
  }
  private async executorEntry(context: HandoverContext, item: PendingDuty, mutationId?: string) {
    const snapshot = await this.store.executorHandoverSnapshot(), batch = snapshot.batches.find(row => this.executorKey(row.approvalBatchId, item.recordId) === item.key);
    const entry = batch?.items.find(row => row.executionRecordId === item.recordId), prior = entry?.executorHandover;
    if (!batch || !entry || item.module !== 'purchase' || item.phase !== 'execution' || item.status !== 'pending' || !/^[a-f0-9]{64}$/.test(item.version) || item.recipients.length !== 1 || item.recipients[0].openId !== context.from.openId) throw new ConflictException('采购执行原清单无效');
    const replay = !!mutationId && prior?.mutationId === mutationId;
    const record = replay ? undefined : await this.gateway!.getExecutionRecordAsApp(item.recordId), scope = replay ? prior!.scope : purchaseAuthorityTarget(record!);
    if (!scope || this.executorDuty(context, entry, scope)?.recordId !== item.dutyRecordId || item.stageKey !== (entry.choice === 'comprehensive' ? 'purchase_executor' : 'building_executor')) throw new ConflictException('采购执行岗位或范围不一致');
    if (replay) {
      if (prior!.sourceVersion !== item.version || prior!.sourceOpenId !== context.from.openId || prior!.sourcePersonRecordId !== context.from.recordId || prior!.targetOpenId !== context.to.openId || prior!.targetPersonRecordId !== context.to.recordId) throw new ConflictException('采购执行原交接人员不一致');
    } else if (entry.status !== 'approved' || entry.purchaserOpenId !== context.from.openId || record!.purchaserOpenId !== context.from.openId || resolvePurchaseStage(record!.status) !== 'ordering' || record!.purchaseCompleted ||
      normalizeMethod(record!.purchaseMethod) !== (entry.choice === 'building_self' ? '需求自采' : '综合采购') ||
      scope.building !== parsePurchaseManagerBatchApprovalCardContext(batch.cardContext).building || entry.authorityTarget && JSON.stringify(entry.authorityTarget) !== JSON.stringify(scope) || purchaseExecutorVersion(batch.approvalBatchId, entry, scope) !== item.version) throw new ConflictException('采购执行原版本已变化');
    if (!replay && snapshot.notifications.some(row => row.kind === 'manager_batch_purchase_assigned' && row.recipientOpenId === context.from.openId && row.cardContext === batch.cardContext && (row.status !== 'completed' || row.sendOutcome !== 'delivered' || !row.messageId))) throw new ConflictException('采购原执行卡投递未确认，请恢复原任务');
    return { batch, entry, scope };
  }
  private singleKey(recordId:string,source:string):string{return`purchase:${recordId}:single-manager:${source}`;}
  private singleDuty(context:HandoverContext,card:PurchaseManagerApprovalCardEntry):AuthorityDuty|undefined{
    const building=parsePurchaseManagerApprovalCardContext(card.cardContext).building,matches=context.duties.filter(duty=>duty.kind==='purchase_manager'&&(duty.personnelIds.includes(context.from.id)||duty.personnelIds.includes(context.to.id))&&authorityDutyMatchesTarget(duty,{building}));
    if(matches.length>1)throw new ConflictException('采购单条审批匹配多个职责，请核对');return matches[0];
  }
  private singleCard(context:HandoverContext,item:PendingDuty,cards:PurchaseManagerApprovalCardEntry[]):PurchaseManagerApprovalCardEntry{
    const matches=cards.filter(card=>card.executionRecordId===item.recordId&&card.recipientOpenId===context.from.openId);
    if(matches.length!==1)throw new ConflictException('采购单条原卡不唯一');const card=matches[0];
    if(item.module!=='purchase'||item.key!==this.singleKey(item.recordId,context.from.openId!)||item.stageKey!=='single_manager'||item.phase!=='approval'||item.status!=='pending'||!/^[a-f0-9]{64}$/.test(item.version)||this.singleDuty(context,card)?.recordId!==item.dutyRecordId||item.recipients.length!==1||item.recipients[0].openId!==context.from.openId)throw new ConflictException('采购单条交接清单无效');return card;
  }
  private async batch(id: string): Promise<PurchaseManagerApprovalBatchEntry> { const batch = await this.store.findManagerApprovalBatch(id); if (!batch) throw new ConflictException('原采购批次不存在'); return batch; }
  private itemKey(id: string): string { return `purchase:${id}:manager_batch`; }
  private async assertItem(context: HandoverContext, item: PendingDuty, batch: PurchaseManagerApprovalBatchEntry, prior?: PurchaseManagerBatchHandover): Promise<void> {
    if (item.module !== 'purchase' || item.key !== this.itemKey(batch.approvalBatchId) || item.stageKey !== 'manager_batch' || item.phase !== 'approval' ||
      item.status !== 'pending' || item.recordId !== batch.approvalBatchId || !Array.isArray(item.recipients) || item.recipients.length !== 1 || item.recipients[0].openId !== context.from.openId ||
      !/^[1-9]\d*$/.test(item.version) || !Number.isSafeInteger(Number(item.version)) || Number(item.version) < 1 ||
      !prior && !managerBatchDeliveries(batch).some(delivery => delivery.recipientOpenId === context.from.openId && delivery.messageId) ||
      prior && (prior.approvalBatchId !== item.recordId || prior.expectedRevision !== Number(item.version) || prior.dutyRecordId !== item.dutyRecordId) ||
      (await this.duty(context, batch))?.recordId !== item.dutyRecordId) throw new ConflictException('采购交接职责或原版本不一致');
  }
  private async duty(context: HandoverContext, batch: PurchaseManagerApprovalBatchEntry): Promise<AuthorityDuty | undefined> {
    const prior = (await this.store.listPersonnelHandovers()).find(job => job.approvalBatchId === batch.approvalBatchId && job.targetRevision === batch.revision);
    const snapshot = parsePurchaseManagerBatchApprovalCardContext(batch.cardContext || prior?.oldCardContext || '');
    const matches = context.duties.filter(duty => duty.kind === 'purchase_manager' &&
      (duty.personnelIds.includes(context.from.id) || duty.personnelIds.includes(context.to.id)) && authorityDutyMatchesTarget(duty, { building: snapshot.building }));
    if (matches.length > 1) throw new ConflictException('采购审批匹配多个职责，请先核对'); return matches[0];
  }
}
