import type { LifecyclePaymentPerFileStorePort } from './purchase-lifecycle-payment-upload-per-file';
import type { LifecyclePaymentUploadIdentity, LifecyclePaymentUploadSelector } from './purchase-lifecycle-payment-upload-isolated';
import type { PurchaseManagerApprovalBatchEntry, PurchaseManagerApprovalBatchItemEntry, PurchaseWorkflowStore } from './purchase-workflow.store';
import type { PurchaseReplica } from './purchase-lifecycle-replica';
import { ForbiddenException } from '@nestjs/common';
import type { LifecyclePaymentRecordReader } from './purchase-lifecycle-payment-upload-store-adapter';
import type { PurchaseLifecycleDeliveryAuthorizer } from './purchase-lifecycle-delivery.service';
import { purchaseAuthorityTarget } from './purchase-authority-target';
import { projectPurchaseLifecycle, resolvePurchaseLifecycleStage } from './purchase-lifecycle-projection';
import type { LifecyclePaymentUploadRequest } from './purchase-lifecycle-payment-upload';

type CurrentPaymentAuthority=(identity:LifecyclePaymentUploadIdentity,selector:LifecyclePaymentUploadSelector,batch:PurchaseManagerApprovalBatchEntry,replica:PurchaseReplica,item:PurchaseManagerApprovalBatchItemEntry)=>void;

/** Unregistered adapter. The supplied authority must read the current trusted
 * principal and actual purchasing duty synchronously inside the ledger lock. */
export function createLifecyclePaymentPerFileStoreAdapter(store:PurchaseWorkflowStore,authorize:CurrentPaymentAuthority):LifecyclePaymentPerFileStorePort {
  if (!store || typeof authorize!=='function') throw new Error('采购付款附件安全授权未就绪');
  const check=(identity:LifecyclePaymentUploadIdentity,selector:LifecyclePaymentUploadSelector)=>(batch:PurchaseManagerApprovalBatchEntry,replica:PurchaseReplica,item:PurchaseManagerApprovalBatchItemEntry)=>authorize(identity,selector,batch,replica,item);
  return {
    reserve:(identity,selector,request)=>store.reserveLifecyclePaymentPerFile(identity,selector,request,check(identity,selector)),
    beginFile:(identity,selector,request,key,index,attemptId)=>store.beginLifecyclePaymentPerFile(identity,selector,request,key,index,attemptId,check(identity,selector)),
    confirmFile:(key,index,attemptId,token)=>store.confirmLifecyclePaymentPerFile(key,index,attemptId,token),
    markFileUncertain:(key,index,attemptId)=>store.markLifecyclePaymentPerFileUncertain(key,index,attemptId),
    commit:(identity,selector,request,key)=>store.commitLifecyclePaymentPerFile(identity,selector,request,key,check(identity,selector)),
  };
}

/** Remote reads finish before the transaction; the captured grant and actual
 * signed identity are rechecked synchronously inside the existing ledger lock. */
export class LifecyclePaymentPerFileStoreAdapter implements LifecyclePaymentPerFileStorePort {
  constructor(private readonly store:PurchaseWorkflowStore, private readonly authorizer:PurchaseLifecycleDeliveryAuthorizer, private readonly records:LifecyclePaymentRecordReader) {}
  private async authorize(identity:LifecyclePaymentUploadIdentity,selector:LifecyclePaymentUploadSelector) {
    identity.assertCurrent();
    await this.store.verifyLifecycleReceiptImageSource(identity.appId,identity.uploadSourceFingerprint || '');
    identity.assertCurrent();
    const source=structuredClone(await this.records.getExecutionRecordAsApp(selector.executionRecordId)),target=purchaseAuthorityTarget(source);
    if (!source || source.recordId!==selector.executionRecordId || source.approvalBatchId!==selector.approvalBatchId || source.purchaserOpenId!==identity.openId || resolvePurchaseLifecycleStage(source.status)!=='ordering' || !target || (source.specialty?.trim() && !target.specialty)) throw new ForbiddenException('采购付款远端记录已变化');
    const grant=await this.authorizer.prepare({appId:identity.appId,batchId:selector.approvalBatchId,recipientOpenId:identity.openId});
    await grant.verifyLatest();identity.assertCurrent();
    return (batch:PurchaseManagerApprovalBatchEntry,replica:PurchaseReplica,item:PurchaseManagerApprovalBatchItemEntry)=>{
      identity.assertCurrent();grant.assertCurrent();grant.authorizeBatch(batch,replica.appliedRevision);
      if (!item.authorityTarget || item.authorityTarget.building!==target.building || item.authorityTarget.specialty!==target.specialty) throw new ForbiddenException('采购付款楼栋或专业已变化');
      const projection=grant.project(batch,replica.appliedRevision),items=projectPurchaseLifecycle(projection.items,projection.viewer).filter(row=>row.recordId===selector.executionRecordId);
      if (items.length!==1 || !items[0]!.actions.includes('order')) throw new ForbiddenException('采购付款权限或职责已变化');
    };
  }
  async reserve(identity:LifecyclePaymentUploadIdentity,selector:LifecyclePaymentUploadSelector,request:LifecyclePaymentUploadRequest) {
    return this.store.reserveLifecyclePaymentPerFile(identity,selector,request,await this.authorize(identity,selector));
  }
  async beginFile(identity:LifecyclePaymentUploadIdentity,selector:LifecyclePaymentUploadSelector,request:LifecyclePaymentUploadRequest,key:string,index:number,attemptId:string) {
    return this.store.beginLifecyclePaymentPerFile(identity,selector,request,key,index,attemptId,await this.authorize(identity,selector));
  }
  confirmFile(key:string,index:number,attemptId:string,token:string) { return this.store.confirmLifecyclePaymentPerFile(key,index,attemptId,token); }
  markFileUncertain(key:string,index:number,attemptId:string) { return this.store.markLifecyclePaymentPerFileUncertain(key,index,attemptId); }
  async commit(identity:LifecyclePaymentUploadIdentity,selector:LifecyclePaymentUploadSelector,request:LifecyclePaymentUploadRequest,key:string) {
    return this.store.commitLifecyclePaymentPerFile(identity,selector,request,key,await this.authorize(identity,selector));
  }
}
