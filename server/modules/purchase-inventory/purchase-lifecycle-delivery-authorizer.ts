import { purchaseCurrentDutyMembers } from './purchase-duty-members';
import { createHash } from 'node:crypto';
import { canPerformBusinessAction } from '../../../shared/business-permissions';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { PurchaseWorkflowRecord, PurchaseWorkflowStage } from '../../../shared/purchase-workflow.interface';
import type { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { additionalReadonlyCardTargets } from '../../common/feishu-card-copy/targets';
import { readEnv } from '../../common/config/external-services.config';
import { purchaseLifecycleAuthorizationFingerprint } from './purchase-lifecycle-authorization-fingerprint';
import { assertPurchaseInboundExecutionScope } from '../inventory-management/inventory-access-policy';
import { purchaseAuthorityTarget } from './purchase-authority-target';
import { resolvePurchaseLifecycleStage, type PurchaseLifecycleAction, type PurchaseLifecycleItem, type PurchaseLifecycleItemGrant, type PurchaseLifecycleOverallProgress } from './purchase-lifecycle-projection';
import type { PurchaseLifecycleDeliveryAuthorizer, PurchaseLifecycleDeliveryGrant, PurchaseLifecycleFormViewKind, PurchaseLifecycleFormPresentation } from './purchase-lifecycle-delivery.service';
import type { PurchaseLifecycleManagerAction } from './purchase-lifecycle-card';
import type { PurchaseReplicaIdentity } from './purchase-lifecycle-replica';
import type { PurchaseManagerApprovalBatchEntry } from './purchase-workflow.store';

/** Local snapshot validity and direct remote readback are separate; neither is a remote CAS. */
export interface PurchaseLifecycleTrustedRecordSource {
  load(identity: PurchaseReplicaIdentity, includeComparison: (batch: PurchaseManagerApprovalBatchEntry, record: PurchaseWorkflowRecord) => boolean): Promise<{
    version: string;
    batchFingerprint: string;
    records: PurchaseWorkflowRecord[];
    comparisonImages?: Record<string, ReadonlyArray<{ imageKey: string; alt: string }>>;
    comparisonCounts?: Record<string, number>;
  }>;
  isLocallyValid(version: string): boolean;
  verifyLatest(version: string): Promise<boolean>;
}

type Access = Pick<AccessConfigurationService, 'snapshot' | 'feishuPrincipal' | 'currentDutyRoutePeople' | 'isCurrentReadonlyCardRecipient'> & Partial<Pick<AccessConfigurationService, 'currentDutyMembers'>>;
type CardCopyEnvironment = Record<string, string | undefined> & Partial<Pick<NodeJS.ProcessEnv, 'FEISHU_APP_ID' | 'FEISHU_CARD_READONLY_COPY_ENABLED' | 'FEISHU_CARD_READONLY_COPY_APP_ID' | 'FEISHU_CARD_READONLY_COPY_OPEN_ID' | 'FEISHU_CARD_READONLY_COPY_NAME' | 'FEISHU_CARD_READONLY_COPY_ADDITIONAL_RECIPIENTS'>>;
const ALL_STAGES: PurchaseWorkflowStage[] = ['application', 'approval', 'ordering', 'receipt', 'inbound', 'completed', 'terminated', 'unknown'];
const deny = (): never => { throw new Error('采购卡片授权或数据来源无法核对'); };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function observerName(identity: PurchaseReplicaIdentity, env: CardCopyEnvironment, currentAppId: string): string | undefined {
  if (env.FEISHU_CARD_READONLY_COPY_ENABLED !== 'true' || currentAppId !== identity.appId || env.FEISHU_CARD_READONLY_COPY_APP_ID?.trim() !== identity.appId) return undefined;
  const primary = { name: env.FEISHU_CARD_READONLY_COPY_NAME?.trim() || '', openId: env.FEISHU_CARD_READONLY_COPY_OPEN_ID?.trim() || '' };
  const configured = [primary, ...additionalReadonlyCardTargets(env.FEISHU_CARD_READONLY_COPY_ADDITIONAL_RECIPIENTS)];
  const matches = configured.filter(row => row.openId === identity.recipientOpenId);
  if (!matches.length) return undefined;
  if (matches.length !== 1 || !['李世龙', '刘小杏'].includes(matches[0]!.name) ||
    configured.filter(row => row.name === matches[0]!.name).length !== 1) return deny();
  return matches[0]!.name;
}

function withinDuty(access: Access, kind: 'purchase_manager' | 'purchase_executor' | 'building_executor' | 'warehouse_approver', target: { building: string; specialty?: string }, openId: string): boolean {
  const people = purchaseCurrentDutyMembers(access, kind, target);
  if (people === null) return false;
  if (!Array.isArray(people)) return deny();
  return people.filter(person => person?.openId === openId).length === 1;
}

function permitted(principal: AccessPrincipal | null, module: 'purchase' | 'inventory', action: 'read' | 'approve' | 'order' | 'receive' | 'confirm', target: { building: string; specialty?: string }): boolean {
  return !!principal && canPerformBusinessAction(principal, { module, action, ...target });
}

function itemView(record: PurchaseWorkflowRecord, images: ReadonlyArray<{ imageKey: string; alt: string }>, comparisonCount = 0, platformRejected = false): PurchaseLifecycleItem {
  if (!Number.isSafeInteger(comparisonCount) || comparisonCount < 0 || comparisonCount > 5 ||
    (record.paymentAttachmentTokens?.length || 0) > 20 || record.receiptPhotoTokens.length > 20 || record.invoiceTokens.length > 20) return deny();
  const safe = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const time = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : '';
  const stage = resolvePurchaseLifecycleStage(record.status);
  const overallProgress: PurchaseLifecycleOverallProgress = stage === 'application' ? 'pending_approval' : stage === 'approval' ? 'pending_warehouse' :
    stage === 'ordering' ? 'pending_order' : stage === 'receipt' && record.purchaseCompleted === true ? 'ordered' :
    stage === 'inbound' && record.purchaseCompleted === true && record.receiptConfirmed === true ? 'received' :
    stage === 'completed' && record.purchaseCompleted === true && record.receiptConfirmed === true ? 'inbounded' : stage === 'terminated' ? 'terminated' : 'unknown';
  const rejected = stage === 'terminated' && (!!record.rejectionReason || platformRejected);
  const approvalResult = rejected ? (platformRejected ? '平台驳回' : '已驳回') : record.approvalCompleted === true ? '已审批' : '尚未确认';
  const orderResult = record.purchaseCompleted === true ? '已下单' : ['receipt', 'inbound', 'completed'].includes(stage) ? '待核对' : '尚未确认';
  const receiptResult = record.receiptConfirmed === true ? '已签收' : ['inbound', 'completed'].includes(stage) ? '待核对' : '尚未确认';
  // 库房确认 also occurs during approval; it alone cannot prove inventory inbound.
  const inboundResult = stage === 'completed' ? (record.purchaseCompleted === true && record.receiptConfirmed === true ? '已入库' : '待核对') : stage === 'inbound' ? '待入库' : '尚未确认';
  return { recordId: record.recordId, status: record.status, overallProgress, stages: [
    { stage: 'application', fields: [
      { label: '采购单号', value: safe(record.requestCode) }, { label: '物品', value: safe(record.itemName) },
      { label: '规格', value: safe(record.specification) }, { label: '申请人', value: safe(record.requesterName) },
      { label: '申请数量', value: `${safe(record.requestedQuantity)} ${safe(record.unit)}`.trim() },
      { label: '申请单价', value: safe(record.unitPrice) }, { label: '需求', value: safe(record.requirementSummary) },
      { label: '采购形式', value: safe(record.procurementForm) }, { label: '单一采购原因', value: safe(record.singleReason) },
      { label: '供应商', value: safe(record.supplier) }, { label: '期望交付', value: time(record.expectedDeliveryDate) },
      { label: '申请时间', value: time(record.createdAt) }, { label: '备注', value: safe(record.note) },
    ], images: images.map(row => ({ imageKey: row.imageKey, alt: row.alt })), attachments: Array.from({ length: comparisonCount }, (_, index) => ({ purpose: 'comparison' as const, index })) },
    { stage: 'approval', fields: [{ label: '审批结果', value: approvalResult }, { label: '采购方式', value: safe(record.purchaseMethod) }, { label: '驳回原因', value: safe(record.rejectionReason) }] },
    { stage: 'ordering', fields: [{ label: '下单结果', value: orderResult }, { label: '采购人', value: safe(record.purchaserName) }, { label: '实际数量', value: safe(record.actualQuantity) }, { label: '实际金额', value: safe(record.actualAmount) },
      { label: '数量差异', value: safe(record.quantityDifference) }, { label: '金额差异', value: safe(record.amountDifference) }, { label: '付款附件数', value: String(record.paymentAttachmentTokens?.length || 0) }], attachments: (record.paymentAttachmentTokens || []).map((_, index) => ({ purpose: 'payment' as const, index })) },
    { stage: 'receipt', fields: [{ label: '签收结果', value: receiptResult }, { label: '签收人', value: safe(record.signer) }, { label: '签收时间', value: time(record.receiptTime) },
      { label: '签收照片数', value: String(record.receiptPhotoTokens.length) }, { label: '发票数', value: String(record.invoiceTokens.length) }], attachments: [...record.receiptPhotoTokens.map((_, index) => ({ purpose: 'receipt' as const, index })), ...record.invoiceTokens.map((_, index) => ({ purpose: 'invoice' as const, index }))] },
    { stage: 'inbound', fields: [{ label: '入库结果', value: inboundResult }, { label: '楼栋', value: safe(record.building) }, { label: '库位', value: safe(record.location) }, { label: '物品编码', value: safe(record.sku) }] },
  ] };
}

/** Not registered or scheduled: requires a real source with a strong synchronous version fence. */
export class PurchaseLifecycleServerAuthorizer implements PurchaseLifecycleDeliveryAuthorizer {
  constructor(private readonly access: Access, private readonly source: PurchaseLifecycleTrustedRecordSource, private readonly env: () => CardCopyEnvironment = () => process.env,
    private readonly currentAppId: () => string = () => readEnv('FEISHU_APP_ID')) {}

  async prepare(identity: PurchaseReplicaIdentity): Promise<PurchaseLifecycleDeliveryGrant> {
    if (!/^cli_[A-Za-z0-9_-]+$/.test(identity.appId) || !/^ou_[A-Za-z0-9_-]+$/.test(identity.recipientOpenId) ||
      this.currentAppId() !== identity.appId) return deny();
    const observer = observerName(identity, this.env(), this.currentAppId());
    const fingerprint = createHash('sha256').update(`${identity.appId}\0${identity.recipientOpenId}`).digest('hex');
    if (observer && !this.access.isCurrentReadonlyCardRecipient({ appId: identity.appId, identityHash: fingerprint, name: observer })) return deny();
    const currentPrincipal = this.access.feishuPrincipal(identity.recipientOpenId, identity.appId);
    const principal = currentPrincipal && !currentPrincipal.requiresPasswordChange ? currentPrincipal : null;
    if (!principal && !observer) return deny();
    const principalHash = hash(currentPrincipal);
    const revision = this.access.snapshot().revision;
    const loaded = await this.source.load(identity, (batch, record) => {
      const target = purchaseAuthorityTarget(record);
      if (!target || batch.approvalBatchId !== identity.batchId || batch.flowVersion !== 'lifecycle_v1') return false;
      return !!observer || (!!principal && permitted(principal, 'purchase', 'read', target) &&
        (batch.managerDeliveries || []).some(row => row.recipientOpenId === identity.recipientOpenId) &&
        withinDuty(this.access, 'purchase_manager', target, identity.recipientOpenId));
    });
    if (!loaded || typeof loaded.version !== 'string' || !loaded.version || typeof loaded.batchFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(loaded.batchFingerprint) || !Array.isArray(loaded.records) || !loaded.records.length || loaded.records.length > 20) return deny();
    const snapshot = structuredClone(loaded);
    const assertCurrent = () => {
      const fresh = this.access.feishuPrincipal(identity.recipientOpenId, identity.appId);
      const sourceCurrent: unknown = this.source.isLocallyValid(snapshot.version);
      if (sourceCurrent instanceof Promise) void sourceCurrent.catch(() => undefined);
      if ((!observer && (!fresh || fresh.requiresPasswordChange)) || hash(fresh) !== principalHash || this.access.snapshot().revision !== revision ||
        this.currentAppId() !== identity.appId || sourceCurrent !== true || observerName(identity, this.env(), this.currentAppId()) !== observer ||
        (observer && !this.access.isCurrentReadonlyCardRecipient({ appId: identity.appId, identityHash: fingerprint, name: observer }))) deny();
    };
    const validateBatch = (batch: PurchaseManagerApprovalBatchEntry) => {
      assertCurrent();
      if (batch.flowVersion !== 'lifecycle_v1' || batch.approvalBatchId !== identity.batchId || hash(batch) !== snapshot.batchFingerprint ||
        batch.recordIds.length !== snapshot.records.length || new Set(batch.recordIds).size !== batch.recordIds.length ||
        new Set(snapshot.records.map(row => row.recordId)).size !== snapshot.records.length ||
        snapshot.records.some(row => !batch.recordIds.includes(row.recordId)) || batch.items.length !== batch.recordIds.length ||
        batch.items.some(item => batch.recordIds.filter(id => id === item.executionRecordId).length !== 1) ||
        new Set(batch.items.map(item => item.executionRecordId)).size !== batch.recordIds.length) deny();
    };
    return {
      assertCurrent,
      verifyLatest: async () => {
        assertCurrent();
        if (await this.source.verifyLatest(snapshot.version) !== true) deny();
        assertCurrent();
      },
      authorizeBatch: batch => validateBatch(batch),
      authorizationFingerprint: batch => {
        validateBatch(batch);
        return purchaseLifecycleAuthorizationFingerprint(this.access, identity, batch, this.env(), this.currentAppId());
      },
      project: batch => {
        validateBatch(batch);
        const grants: PurchaseLifecycleItemGrant[] = [];
        const items: PurchaseLifecycleItem[] = [];
        const formPresentations: Record<string, Partial<Record<PurchaseLifecycleFormViewKind, PurchaseLifecycleFormPresentation>>> = {};
        for (const record of snapshot.records) {
          const target = purchaseAuthorityTarget(record);
          const batchItem = batch.items.find(item => item.executionRecordId === record.recordId);
          if (!target || !batchItem || (batchItem.authorityTarget && (batchItem.authorityTarget.building !== target.building || batchItem.authorityTarget.specialty !== target.specialty))) return deny();
          const purchaseRead = permitted(principal, 'purchase', 'read', target);
          const inventoryRead = permitted(principal, 'inventory', 'read', target);
          const manager = purchaseRead && (batch.managerDeliveries || []).filter(row => row.recipientOpenId === identity.recipientOpenId).length === 1 && withinDuty(this.access, 'purchase_manager', target, identity.recipientOpenId);
          const purchaser = purchaseRead && batchItem.status === 'approved' && ['comprehensive', 'building_self'].includes(batchItem.choice) && batchItem.purchaserOpenId === identity.recipientOpenId && record.purchaserOpenId === identity.recipientOpenId &&
            withinDuty(this.access, batchItem.choice === 'building_self' ? 'building_executor' : 'purchase_executor', target, identity.recipientOpenId);
          const requester = purchaseRead && batch.requesterOpenId === identity.recipientOpenId && record.requesterOpenId === identity.recipientOpenId;
          const warehouse = inventoryRead && withinDuty(this.access, 'warehouse_approver', target, identity.recipientOpenId);
          const stages = new Set<PurchaseWorkflowStage>();
          if (manager || requester) stages.add('application');
          if (manager) stages.add('approval');
          if (purchaser) stages.add('ordering');
          if (requester) stages.add('receipt');
          if (warehouse) stages.add('inbound');
          const actions: PurchaseLifecycleAction[] = [];
          const stage = resolvePurchaseLifecycleStage(record.status);
          if (manager && ['awaiting_delivery', 'active', 'reject_editing'].includes(batch.state) && batchItem.status === 'pending' && stage === 'application' && permitted(principal, 'purchase', 'approve', target)) actions.push('approve');
          if (purchaser && stage === 'ordering' && permitted(principal, 'purchase', 'order', target)) actions.push('order');
          if (requester && batchItem.status === 'approved' && stage === 'receipt' && permitted(principal, 'purchase', 'receive', target)) actions.push('receive');
          if (principal && warehouse && batchItem.status === 'approved' && stage === 'inbound' && permitted(principal, 'inventory', 'confirm', target)) {
            try { assertPurchaseInboundExecutionScope(principal, target.building); actions.push('inbound'); } catch { /* No inbound action outside scope. */ }
          }
          const images = manager || observer ? snapshot.comparisonImages?.[record.recordId] || [] : [];
          items.push(itemView(record, images, manager || observer ? snapshot.comparisonCounts?.[record.recordId] || 0 : 0,
            batchItem.status === 'rejected' && batchItem.decisionSource === 'platform'));
          grants.push({ recordId: record.recordId, visibleStages: observer ? ALL_STAGES : [...stages], allowedActions: actions, showOverallProgress: stages.size > 0 || !!observer });
          const forms: Partial<Record<PurchaseLifecycleFormViewKind, PurchaseLifecycleFormPresentation>> = {};
          if (actions.includes('approve')) forms.reject = {};
          if (actions.includes('order')) forms.order = {
            ...(typeof record.actualQuantity === 'number' && Number.isFinite(record.actualQuantity) ? { actualQuantity: record.actualQuantity } : {}),
            ...(typeof record.actualAmount === 'number' && Number.isFinite(record.actualAmount) ? { actualAmount: record.actualAmount } : {}),
          };
          if (actions.includes('receive')) {
            if (!Array.isArray(batchItem.receiptPhotoTokens) || !Array.isArray(batchItem.invoiceTokens) || !['building_self', 'comprehensive'].includes(batchItem.choice)) return deny();
            forms.receipt = {
            signerOpenId: record.signerOpenId || record.requesterOpenId,
            ...(typeof record.receiptTime === 'number' && Number.isFinite(record.receiptTime) && !Number.isNaN(new Date(record.receiptTime).getTime()) ? { receiptTime: new Date(record.receiptTime).toISOString() } : {}),
            purchaseMethod: batchItem.choice === 'building_self' ? '需求自采' : '综合采购', receiptPhotoCount: batchItem.receiptPhotoTokens.length, invoiceCount: batchItem.invoiceTokens.length,
          };
          }
          if (Object.keys(forms).length) formPresentations[record.recordId] = forms;
        }
        const pending = batch.items.filter(item => item.status === 'pending').map(item => item.executionRecordId);
        const authorized = grants.filter(grant => grant.allowedActions.includes('approve')).map(grant => grant.recordId);
        const buildings = new Set(snapshot.records.map(record => purchaseAuthorityTarget(record)?.building));
        const hasBusinessAction = grants.some(grant => grant.allowedActions.length > 0);
        const viewer = observer && !hasBusinessAction ? { kind: 'observer' as const } : { kind: 'participant' as const, grants };
        return {
          items, viewer, formPresentations,
          ...(pending.length && buildings.size === 1 ? { batchApprovalProof: { pendingRecordIds: pending, authorizedPendingRecordIds: authorized, building: [...buildings][0]! } } : {}),
          resolveCallback: (recordId: string, action: PurchaseLifecycleAction) => action === 'order' || action === 'receive' ? ({ version: 4, workflowType: 'purchase_batch_fulfillment', role: action === 'order' ? 'purchaser' : 'requester', action: action === 'order' ? 'open_order' : 'open_receipt', approvalBatchId: batch.approvalBatchId, executionRecordId: recordId }) : undefined,
          resolveManagerCallback: (action: PurchaseLifecycleManagerAction, recordId?: string) => ({ version: 3, action, approvalBatchId: batch.approvalBatchId, ...(recordId ? { executionRecordId: recordId } : {}) }),
        };
      },
    };
  }
}
