import { parsePurchaseAttachmentLocation } from '../../client/src/pages/PurchaseLifecycleAttachment/location';
import { getPostLoginPath } from '../../client/src/access/access-policy';

describe('purchase attachment location', () => {
  const query = '?batchId=purchase-batch-1&recordId=rec_1&generation=2&purpose=comparison&index=0';
  it('accepts only document identification and a positive generation', () => {
    expect(parsePurchaseAttachmentLocation(query)).toEqual({ batchId: 'purchase-batch-1', recordId: 'rec_1', generation: 2, purpose: 'comparison', index: 0 });
  });
  it.each([`${query}&recipient=ou_other`, `${query}&ticket=secret`, `${query}&generation=1`, query.replace('generation=2', 'generation=0'), query.replace('index=0', 'index=20')])('rejects ambiguous or sensitive locations', value => {
    expect(parsePurchaseAttachmentLocation(value)).toBeNull();
  });
  it('retains a validated attachment URL after login even for authenticated guest-role Feishu accounts', () => {
    const path = `/purchase-lifecycle-attachment${query}`;
    expect(getPostLoginPath('guest', path, ['/nantong-base'])).toBe(path);
    expect(getPostLoginPath('editor', `${path}&recipient=ou_other`, ['/nantong-base'])).toBe('/nantong-base');
  });
});
