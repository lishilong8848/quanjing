export interface PurchaseReceiptMaterialRequirement {
  requiresReceiptPhoto: true;
  requiresInvoice: boolean;
}

export function isSelfPurchaseMethod(value: unknown): boolean {
  return clean(value).includes('自采');
}

export function receiptMaterialRequirement(
  purchaseMethod: unknown,
): PurchaseReceiptMaterialRequirement {
  return {
    requiresReceiptPhoto: true,
    requiresInvoice: isSelfPurchaseMethod(purchaseMethod),
  };
}

export function mergeReceiptAttachmentTokens(
  receiptPhotoTokens: readonly string[],
  invoiceTokens: readonly string[],
): string[] {
  return [
    ...new Set(
      [...receiptPhotoTokens, ...invoiceTokens].map(clean).filter(Boolean),
    ),
  ];
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
