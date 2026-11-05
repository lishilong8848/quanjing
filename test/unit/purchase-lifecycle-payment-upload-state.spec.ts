import { finishPaymentAttempt, parsePaymentPending, parsePaymentTarget, paymentPendingKey, reservePaymentAttempt, validatePaymentFiles } from '../../client/src/pages/PurchaseLifecyclePaymentUpload/state';
import { getPostLoginPath } from '../../client/src/access/access-policy';

describe('isolated lifecycle payment upload client state', () => {
  const target = { approvalBatchId: 'purchase-batch-1', executionRecordId: 'rec_1', generation: 2 }, account = 'account-one';
  const requestId = 'e1d8270c-e38d-4a77-bac1-0ac3d34d9001';
  let values: Map<string, string>, storage: Storage;
  beforeEach(() => {
    values = new Map();
    storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } } as Storage;
  });
  it('accepts document identifiers only and rejects identity, ticket, ambiguous and malformed inputs', () => {
    const query = '?approvalBatchId=purchase-batch-1&executionRecordId=rec_1&generation=2';
    expect(parsePaymentTarget(query)).toEqual(target);
    for (const suffix of ['&openId=ou_other', '&ticket=secret', '&generation=3']) expect(parsePaymentTarget(query + suffix)).toBeNull();
    expect(parsePaymentTarget(query.replace('generation=2', 'generation=0'))).toBeNull();
  });
  it('bounds file count, individual size and file names before reserving', () => {
    expect(validatePaymentFiles([])).toBeTruthy();
    expect(validatePaymentFiles([{ name: 'bill.png', size: 20 * 1024 * 1024 }])).toBeNull();
    expect(validatePaymentFiles([{ name: 'bill.png', size: 20 * 1024 * 1024 + 1 }])).toBeTruthy();
    expect(validatePaymentFiles([{ name: '../bad', size: 1 }])).toBeTruthy();
    expect(validatePaymentFiles(Array.from({ length: 6 }, (_, i) => ({ name: String(i), size: 1 })))).toBeTruthy();
  });
  it('returns to the validated card upload target after login without accepting injected identity selectors', () => {
    const path='/purchase-lifecycle-payment-upload?approvalBatchId=purchase-batch-1&executionRecordId=rec_1&generation=2';
    expect(getPostLoginPath('guest',path,['/nantong-base'])).toBe(path);
    expect(getPostLoginPath('guest',path+'&openId=ou_other',['/nantong-base'])).toBe('/nantong-base');
  });
  it('persists a request before sending and refuses a duplicate even after reopening or continuation', () => {
    reservePaymentAttempt(storage, account, target, requestId);
    const key = paymentPendingKey(account, target);
    expect(parsePaymentPending(storage.getItem(key), account, target)?.requestId).toBe(requestId);
    expect(() => reservePaymentAttempt(storage, account, target, '0bda3f1f-53b4-4eb2-9fd9-f9d3df86b7d3')).toThrow('待核对');
    const next = { ...target, generation: 3 };
    expect(paymentPendingKey(account, next)).toBe(key);
    expect(parsePaymentPending(storage.getItem(key), account, next)?.generation).toBe(target.generation);
    expect(() => parsePaymentPending(storage.getItem(key), account, {...target,generation:1})).toThrow();
    expect(() => finishPaymentAttempt(storage, account, target, '0bda3f1f-53b4-4eb2-9fd9-f9d3df86b7d3')).toThrow();
    finishPaymentAttempt(storage, account, target, requestId);
    expect(storage.getItem(key)).toBeNull();
  });
  it('fails closed on damaged or unavailable browser storage', () => {
    const key = paymentPendingKey(account, target);
    storage.setItem(key, '{broken');
    expect(() => parsePaymentPending(storage.getItem(key), account, target)).toThrow();
    expect(() => reservePaymentAttempt({ ...storage, getItem: () => null, setItem: () => { throw new Error('blocked'); } } as Storage, account, target, requestId)).toThrow();
  });
});
