import { purchaseLifecyclePaymentUploadLink } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-link';
import { parsePaymentTarget } from '../../client/src/pages/PurchaseLifecyclePaymentUpload/state';

describe('isolated lifecycle payment upload card link', () => {
  it('uses the supplied HTTPS origin with only non-sensitive document selectors', () => {
    const link = purchaseLifecyclePaymentUploadLink('https://portal.example:3001/', 'purchase-batch-1', 'rec_1', 2);
    const parsed = new URL(link);
    expect(parsed.origin).toBe('https://portal.example:3001');
    expect(parsed.pathname).toBe('/purchase-lifecycle-payment-upload');
    expect(parsePaymentTarget(parsed.search)).toEqual({ approvalBatchId: 'purchase-batch-1', executionRecordId: 'rec_1', generation: 2 });
    expect(link).not.toMatch(/token|openId|messageId/i);
  });
  it.each(['http://portal.example/', 'https://user:secret@portal.example/', 'https://portal.example/?next=evil', 'https://portal.example/path'])('rejects an unsafe configured base', base => {
    expect(() => purchaseLifecyclePaymentUploadLink(base, 'purchase-batch-1', 'rec_1', 1)).toThrow();
  });
});
