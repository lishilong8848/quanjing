import capabilities from '../../common/purchase-runtime-capabilities.json';

export const PURCHASE_LEDGER_CAPABILITY='purchase-workflow-ledger-v1';
export const PURCHASE_STAGE_CARDS_LEDGER_CAPABILITY='purchase-stage-cards-v1';
export function validatePurchaseLedgerCapability(value:unknown): void {
  if(value!==undefined && ((value!==PURCHASE_LEDGER_CAPABILITY && value!==PURCHASE_STAGE_CARDS_LEDGER_CAPABILITY) ||
    capabilities.schemaVersion!==1 || !capabilities.capabilities.includes(PURCHASE_LEDGER_CAPABILITY) || !capabilities.capabilities.includes(value))) {
    throw new Error('当前程序不支持采购账本所需能力，禁止读取或覆盖');
  }
}
/** Called within the same lock/write as the first new-format business record. */
export function retainPurchaseLedgerCapability(ledger:Record<string,any>):void {
  validatePurchaseLedgerCapability(ledger.requiredRuntimeCapability);
  if (ledger.requiredRuntimeCapability === PURCHASE_STAGE_CARDS_LEDGER_CAPABILITY ||
    ledger.managerApprovalBatches?.some((batch: any) => batch?.stageCardTransition !== undefined)) {
    validatePurchaseLedgerCapability(PURCHASE_STAGE_CARDS_LEDGER_CAPABILITY);
    ledger.requiredRuntimeCapability = PURCHASE_STAGE_CARDS_LEDGER_CAPABILITY;
    return;
  }
  const arrays=['platformApprovalClaims','platformApprovalWork','platformLegacyApprovalClaims','lifecycleOutbox','lifecycleFormCredentials','lifecyclePaymentUploads','lifecyclePaymentBlocks'];
  const required=arrays.some(key=>Array.isArray(ledger[key])&&ledger[key].length>0) ||
    ledger.managerApprovalBatches?.some((batch:any)=>batch?.flowVersion==='lifecycle_v1') ||
    ledger.commands?.some((command:any)=>!!command?.platformIdentity) ||
    ledger.notifications?.some((notice:any)=>!!notice?.webReceipt?.platformIdentity) ||
    ledger.lifecycleReceiptPrepareQueue?.tasks?.length || ledger.lifecycleReceiptImageLedger?.tasks?.length || ledger.lifecycleReceiptImageLedger?.intents?.length || ledger.lifecycleReceiptImageSource !== undefined;
  if(required)ledger.requiredRuntimeCapability=PURCHASE_LEDGER_CAPABILITY;
}
