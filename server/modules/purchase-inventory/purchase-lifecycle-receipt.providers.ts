import type { Provider } from '@nestjs/common';
import { PurchaseLifecycleCardTransport } from './purchase-lifecycle-card-transport';
import { PurchaseLifecycleReceiptImageRuntime, PURCHASE_LIFECYCLE_RECEIPT_IMAGE_RUNTIME_OPTIONS } from './purchase-lifecycle-receipt-image-runtime';
import { PurchaseLifecycleReceiptPrepareRuntime } from './purchase-lifecycle-receipt-prepare-runtime';
import { PurchaseWorkflowStore } from './purchase-workflow.store';
import { PURCHASE_LIFECYCLE_RECEIPT_PREPARE_RUNTIME } from './purchase-manager-approval.service';

/** Composition must verify startup capability, then await image.start(), then
 * call prepare.startRecovery(). These providers never start another connection. */
export const PURCHASE_LIFECYCLE_RECEIPT_PROVIDERS:Provider[]=[
  PurchaseLifecycleCardTransport,
  // Only the composition owner calls start, after deciding new or drain mode.
  {provide:PURCHASE_LIFECYCLE_RECEIPT_IMAGE_RUNTIME_OPTIONS,useFactory:()=>({enabled:()=>true})},
  PurchaseLifecycleReceiptImageRuntime,
  {provide:PurchaseLifecycleReceiptPrepareRuntime,inject:[PurchaseWorkflowStore,PurchaseLifecycleReceiptImageRuntime],
    useFactory:(store:PurchaseWorkflowStore,image:PurchaseLifecycleReceiptImageRuntime)=>new PurchaseLifecycleReceiptPrepareRuntime(store,image.privateChatVerifier,(input,batch,item)=>image.assertPreparationAuthority(input,batch,item),{enabled:false})},
  {provide:PURCHASE_LIFECYCLE_RECEIPT_PREPARE_RUNTIME,useExisting:PurchaseLifecycleReceiptPrepareRuntime},
];
