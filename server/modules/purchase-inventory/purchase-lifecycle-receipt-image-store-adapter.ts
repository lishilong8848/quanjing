import type { LifecycleReceiptImageStore } from './purchase-lifecycle-receipt-image-coordinator';
import type { PurchaseWorkflowStore } from './purchase-workflow.store';

/** No independent state or lock: every operation uses the purchase ledger. */
export function createLifecycleReceiptImageStoreAdapter(store: Pick<PurchaseWorkflowStore,
  'acceptVerifiedLifecycleReceiptImage' | 'claimLifecycleReceiptImageUpload' | 'releaseLifecycleReceiptImageBeforeDispatch' |
  'dispatchLifecycleReceiptImageUpload' | 'recordLifecycleReceiptImageUploaded' | 'markLifecycleReceiptImageUploadUncertain' | 'commitLifecycleReceiptImageUploaded'>): LifecycleReceiptImageStore {
  return {
    acceptVerified: (snapshot, authorize) => store.acceptVerifiedLifecycleReceiptImage(snapshot,(batch,item,intent)=>authorize({batch,item,intent})),
    claimUpload: (id, authorize) => store.claimLifecycleReceiptImageUpload(id,authorize),
    releaseBeforeDispatch: (id, token) => store.releaseLifecycleReceiptImageBeforeDispatch(id,token),
    markUploadDispatched: (id, token, authorize) => store.dispatchLifecycleReceiptImageUpload(id,token,authorize),
    recordUploaded: (id, token, file) => store.recordLifecycleReceiptImageUploaded(id,token,file),
    markUploadUncertain: (id, token) => store.markLifecycleReceiptImageUploadUncertain(id,token),
    commitUploaded: (id, token, authorize) => store.commitLifecycleReceiptImageUploaded(id,token,authorize),
  };
}
