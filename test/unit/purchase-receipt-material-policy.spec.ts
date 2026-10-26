import {
  isSelfPurchaseMethod,
  mergeReceiptAttachmentTokens,
  receiptMaterialRequirement,
} from '../../server/modules/purchase-inventory/purchase-receipt-material-policy';

describe('purchase receipt material policy', () => {
  it.each(['需求自采', '需求自采（楼内）', '园区自采-紧急', '  自采  '])(
    'requires an invoice whenever the method contains 自采: %s',
    (method) => {
      expect(isSelfPurchaseMethod(method)).toBe(true);
      expect(receiptMaterialRequirement(method)).toEqual({
        requiresReceiptPhoto: true,
        requiresInvoice: true,
      });
    },
  );

  it.each(['综合采购', '框架采购', '', undefined])(
    'only requires a receipt photo for non-self-purchase method: %s',
    (method) => {
      expect(isSelfPurchaseMethod(method)).toBe(false);
      expect(receiptMaterialRequirement(method)).toEqual({
        requiresReceiptPhoto: true,
        requiresInvoice: false,
      });
    },
  );

  it('merges receipt photos and invoices into one stable deduplicated list', () => {
    expect(
      mergeReceiptAttachmentTokens(
        ['photo-2', 'photo-1', 'photo-2'],
        ['invoice-1', 'photo-1'],
      ),
    ).toEqual(['photo-2', 'photo-1', 'invoice-1']);
  });
});
