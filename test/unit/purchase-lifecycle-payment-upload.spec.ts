import { randomUUID } from 'node:crypto';
import { beginLifecyclePaymentUpload, commitLifecyclePaymentUpload, markLifecyclePaymentUploadUncertain, planLifecyclePaymentUpload, recordLifecyclePaymentUpload, type LifecyclePaymentUploadAuthority, type LifecyclePaymentUploadRequest } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload';

const now = Date.now();
const authority: LifecyclePaymentUploadAuthority = {
  session: { accountId: 'feishu-account', authorizationVersion: 2, appId: 'cli_test', openId: 'ou_buyer', kind: 'feishu', shared: false, impersonated: false, active: true, requiresPasswordChange: false },
  origin: 'https://www.sm.sjhl.online:3001', expectedOrigin: 'https://www.sm.sjhl.online:3001', csrfVerified: true, currentAppId: 'cli_test',
  target: { flowVersion: 'lifecycle_v1', approvalBatchId: 'purchase-application-test', executionRecordId: 'rec_one', purchaserOpenId: 'ou_buyer', orderState: 'waiting', messageId: 'om_buyer', generation: 1, cardRevision: 3, desiredRevision: 3, replicaState: 'delivered', sentAtMs: now - 1000 },
};
const request: LifecyclePaymentUploadRequest = { requestId: randomUUID(), files: [{ sha256: 'a'.repeat(64), size: 1234, name: '付款凭证.png' }] };
const authorize = () => {};
const plan = (a = authority, r = request, existing = null as any, others: string[] = []) => planLifecyclePaymentUpload(a, r, existing, others, now, authorize);

describe('lifecycle payment attachment authorization and idempotency core', () => {
  it('enforces personal authenticated identity, same origin and csrf', () => {
    for (const changed of [
      { ...authority, origin: 'https://attacker.example' }, { ...authority, origin: 'null' }, { ...authority, origin: 'https://www.sm.sjhl.online:3001/path' },
      { ...authority, csrfVerified: false }, { ...authority, currentAppId: 'cli_other' },
      { ...authority, session: { ...authority.session, openId: 'ou_attacker' } },
      { ...authority, session: { ...authority.session, shared: true } }, { ...authority, session: { ...authority.session, impersonated: true } },
      { ...authority, session: { ...authority.session, active: false } }, { ...authority, session: { ...authority.session, requiresPasswordChange: true } },
    ]) expect(() => plan(changed)).toThrow();
  });

  it('enforces current buyer, business stage and delivered card revision', () => {
    for (const target of [
      { ...authority.target, purchaserOpenId: 'ou_other' }, { ...authority.target, orderState: 'completed' as const },
      { ...authority.target, replicaState: 'send_unknown' as const }, { ...authority.target, cardRevision: 2 },
      { ...authority.target, sentAtMs: now + 1 }, { ...authority.target, sentAtMs: now - 14 * 86400000 - 1 },
    ]) expect(() => plan({ ...authority, target })).toThrow();
    expect(() => planLifecyclePaymentUpload(authority, request, null, [], now, () => { throw new Error('duty revoked'); })).toThrow('duty revoked');
    expect(() => planLifecyclePaymentUpload(authority, request, null, [], now, (() => Promise.resolve()) as never)).toThrow();
  });

  it('limits files, rejects invalid digest and repeated content, and rejects cross-request duplicates', () => {
    for (const files of [[], [{ ...request.files[0]!, sha256: 'bad' }], [{ ...request.files[0]!, size: 0 }], [{ ...request.files[0]!, size: 20 * 1024 * 1024 + 1 }], [{ ...request.files[0]!, name: '../secret' }], [request.files[0]!, request.files[0]!]]) {
      expect(() => plan(authority, { ...request, files })).toThrow();
    }
    const existing = plan().entry;
    expect(() => plan(authority, { ...request, requestId: randomUUID() }, null, existing.contentKeys)).toThrow();
    const anotherRecord = { ...authority, target: { ...authority.target, executionRecordId: 'rec_two' } };
    expect(plan(anotherRecord, { ...request, requestId: randomUUID() }, null, existing.contentKeys).kind).toBe('new');
  });

  it('detects a reused request ID for changed target, file or authenticated account', () => {
    const existing = plan().entry;
    expect(() => plan(authority, { ...request, files: [{ ...request.files[0]!, sha256: 'b'.repeat(64) }] }, existing)).toThrow();
    expect(() => plan({ ...authority, target: { ...authority.target, executionRecordId: 'rec_two' } }, request, existing)).toThrow();
    expect(() => plan({ ...authority, session: { ...authority.session, accountId: 'other-account' } }, request, existing)).toThrow();
    expect(plan(authority, request, existing).kind).toBe('start');
  });

  it('does not retry an in-flight or unknown external upload', () => {
    const prepared = plan().entry, attempt = randomUUID();
    const dispatching = beginLifecyclePaymentUpload(prepared, attempt);
    expect(plan(authority, request, dispatching).kind).toBe('manual_reconciliation');
    expect(() => beginLifecyclePaymentUpload(dispatching, randomUUID())).toThrow();
    const unknown = markLifecyclePaymentUploadUncertain(dispatching, attempt);
    expect(plan(authority, request, unknown).kind).toBe('manual_reconciliation');
    expect(() => recordLifecyclePaymentUpload(unknown, attempt, ['file_token'])).toThrow();
  });

  it('persists a confirmed upload as evidence, then requires fresh authorization before commit', () => {
    const attempt = randomUUID(), dispatching = beginLifecyclePaymentUpload(plan().entry, attempt);
    expect(() => recordLifecyclePaymentUpload(dispatching, randomUUID(), ['file_token'])).toThrow();
    const uploaded = recordLifecyclePaymentUpload(dispatching, attempt, ['file_token']);
    expect(plan(authority, request, uploaded).kind).toBe('commit');
    expect(() => commitLifecyclePaymentUpload(authority, request, uploaded, [], now, () => { throw new Error('permission revoked'); })).toThrow('permission revoked');
    expect(uploaded.status).toBe('uploaded');
    const committed = commitLifecyclePaymentUpload(authority, request, uploaded, [], now, authorize);
    expect(plan(authority, request, committed).kind).toBe('replay');
    expect(() => commitLifecyclePaymentUpload(authority, request, committed, [], now, authorize)).toThrow();
  });
});
