import { purchaseLifecycleAuthorizationFingerprint as fingerprint } from '../../server/modules/purchase-inventory/purchase-lifecycle-authorization-fingerprint';

describe('lifecycle synchronous authorization fingerprint', () => {
  const identity = { appId: 'cli_test', batchId: 'purchase-batch-1', recipientOpenId: 'ou_user' };
  let revision: number, principal: any, duty: any, active: boolean, batch: any, appId: string;
  const access: any = { snapshot: () => ({ appId, revision }), feishuPrincipal: () => principal,
    currentDutyRoutePeople: (kind: string) => duty(kind), isCurrentReadonlyCardRecipient: () => active };
  beforeEach(() => {
    revision = 1; appId = identity.appId; principal = { role: 'editor', buildings: ['A楼'] }; active = true;
    duty = (kind: string) => kind === 'purchase_manager' ? [{ openId: 'ou_user' }] : [];
    batch = { flowVersion: 'lifecycle_v1', lifecycleAppId: identity.appId, approvalBatchId: identity.batchId, requesterOpenId: 'ou_requester', state: 'active',
      recordIds: ['rec1'], lifecycleAuthorityTargets: [{ recordId: 'rec1', target: { building: 'A楼' } }],
      items: [{ executionRecordId: 'rec1', status: 'pending', choice: '', purchaserOpenId: '' }], managerDeliveries: [{ recipientOpenId: 'ou_user' }] };
  });
  it('changes when roles, scope, duty, record assignment or configuration revision changes', () => {
    const before = fingerprint(access, identity, batch, {}, appId);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    principal = { ...principal, buildings: ['B楼'] };
    expect(fingerprint(access, identity, batch, {}, appId)).not.toBe(before);
    principal = { role: 'editor', buildings: ['A楼'] };
    duty = () => [];
    expect(fingerprint(access, identity, batch, {}, appId)).not.toBe(before);
    duty = (kind: string) => kind === 'purchase_manager' ? [{ openId: 'ou_user' }] : [];
    batch.items[0].status = 'approved';
    expect(fingerprint(access, identity, batch, {}, appId)).not.toBe(before);
    batch.items[0].status = 'pending'; revision++;
    expect(fingerprint(access, identity, batch, {}, appId)).not.toBe(before);
  });
  it('rejects ambiguous records, missing scope, stale app identity and unresolved async duties', () => {
    batch.lifecycleAuthorityTargets = [];
    expect(() => fingerprint(access, identity, batch, {}, appId)).toThrow();
    batch.lifecycleAuthorityTargets = [{ recordId: 'rec1', target: { building: 'A楼' } }];
    expect(() => fingerprint(access, identity, batch, {}, 'cli_other')).toThrow();
    duty = () => Promise.reject(new Error('unavailable'));
    expect(() => fingerprint(access, identity, batch, {}, appId)).toThrow();
  });
  it('rejects an authorization configuration changing during the synchronous snapshot', () => {
    duty = () => { revision += 1; return []; };
    expect(() => fingerprint(access, identity, batch, {}, appId)).toThrow();
  });
  it('accepts a configured active observer without principal and revokes it on identity change', () => {
    principal = null;
    const env = { FEISHU_CARD_READONLY_COPY_ENABLED: 'true', FEISHU_CARD_READONLY_COPY_APP_ID: appId,
      FEISHU_CARD_READONLY_COPY_OPEN_ID: identity.recipientOpenId, FEISHU_CARD_READONLY_COPY_NAME: '李世龙' };
    expect(fingerprint(access, identity, batch, env, appId)).toMatch(/^[a-f0-9]{64}$/);
    active = false;
    expect(() => fingerprint(access, identity, batch, env, appId)).toThrow();
  });
});
