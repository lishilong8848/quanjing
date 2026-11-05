import { ForbiddenException } from '@nestjs/common';
import type { PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';
import { purchaseAuthorityTarget } from './purchase-authority-target';
import { projectPurchaseLifecycle, resolvePurchaseLifecycleStage } from './purchase-lifecycle-projection';
import type { PurchaseLifecycleDeliveryAuthorizer } from './purchase-lifecycle-delivery.service';
import type { LifecyclePaymentUploadEntry, LifecyclePaymentUploadRequest } from './purchase-lifecycle-payment-upload';
import type { LifecyclePaymentUploadIdentity, LifecyclePaymentUploadSelector, LifecyclePaymentUploadStorePort } from './purchase-lifecycle-payment-upload-isolated';
import { PurchaseWorkflowStore, type LifecyclePaymentUploadLockedAuthorization } from './purchase-workflow.store';

/** Trusted application read port; callers provide the real gateway only after separate activation. */
export interface LifecyclePaymentRecordReader { getExecutionRecordAsApp(recordId: string): Promise<PurchaseWorkflowRecord> }

/** Deliberately not registered; all remote reads complete before entering the ledger lock. */
export class LifecyclePaymentUploadStoreAdapter implements LifecyclePaymentUploadStorePort {
  constructor(private readonly store: PurchaseWorkflowStore, private readonly authorizer: PurchaseLifecycleDeliveryAuthorizer, private readonly records: LifecyclePaymentRecordReader) {}

  private async authorize(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector): Promise<LifecyclePaymentUploadLockedAuthorization> {
    if (!identity || typeof identity.assertCurrent !== 'function' || !this.authorizer || typeof this.authorizer.prepare !== 'function' || !this.records || typeof this.records.getExecutionRecordAsApp !== 'function') throw new ForbiddenException('采购付款授权来源不可用');
    identity.assertCurrent();
    await this.store.verifyLifecycleReceiptImageSource(identity.appId,identity.uploadSourceFingerprint || '');
    identity.assertCurrent();
    const source = structuredClone(await this.records.getExecutionRecordAsApp(selector.executionRecordId));
    if (!source || typeof source !== 'object') throw new ForbiddenException('采购付款远端记录已变化');
    const target = purchaseAuthorityTarget(source);
    if (source.recordId !== selector.executionRecordId || source.approvalBatchId !== selector.approvalBatchId || source.purchaserOpenId !== identity.openId || resolvePurchaseLifecycleStage(source.status) !== 'ordering' || !target || (typeof source.specialty === 'string' && !!source.specialty.trim() && !target.specialty)) throw new ForbiddenException('采购付款远端记录已变化');
    const grant = await this.authorizer.prepare({ appId: identity.appId, batchId: selector.approvalBatchId, recipientOpenId: identity.openId });
    if (!grant || typeof grant.verifyLatest !== 'function' || typeof grant.assertCurrent !== 'function' || typeof grant.authorizeBatch !== 'function' || typeof grant.project !== 'function') throw new ForbiddenException('采购付款授权来源不可用');
    await grant.verifyLatest();
    identity.assertCurrent();
    return (batch, replica, item) => {
      identity.assertCurrent(); grant.assertCurrent(); grant.authorizeBatch(batch, replica.appliedRevision);
      if (!item.authorityTarget || item.authorityTarget.building !== target.building || item.authorityTarget.specialty !== target.specialty) throw new ForbiddenException('采购付款楼栋或专业已变化');
      const projection = grant.project(batch, replica.appliedRevision);
      const matching = projectPurchaseLifecycle(projection.items, projection.viewer).filter(row => row.recordId === selector.executionRecordId);
      if (matching.length !== 1 || !matching[0]!.actions.includes('order')) throw new ForbiddenException('采购付款权限或职责已变化');
    };
  }

  async reserve(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest) {
    return this.store.reserveLifecyclePaymentUpload(identity, selector, request, await this.authorize(identity, selector));
  }
  async begin(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest, entry: LifecyclePaymentUploadEntry, attemptId: string) {
    return this.store.beginLifecyclePaymentUpload(identity, selector, request, entry, attemptId, await this.authorize(identity, selector));
  }
  async recordConfirmed(entry: LifecyclePaymentUploadEntry, attemptId: string, tokens: string[]) {
    return this.store.recordConfirmedLifecyclePaymentUpload(entry, attemptId, tokens);
  }
  async markUncertain(entry: LifecyclePaymentUploadEntry, attemptId: string) {
    return this.store.markUncertainLifecyclePaymentUpload(entry, attemptId);
  }
  async commit(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest, entry: LifecyclePaymentUploadEntry) {
    return this.store.commitLifecyclePaymentUpload(identity, selector, request, entry, await this.authorize(identity, selector));
  }
  async status(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, requestId: string) {
    return this.store.lifecyclePaymentUploadStatus(identity, selector, requestId);
  }
  async cancel(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, requestId: string) {
    return this.store.cancelUnsentLifecyclePaymentUpload(identity, selector, requestId);
  }
}
