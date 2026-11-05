import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { ManagedAccount } from '../../shared/access-configuration.interface';
import { createPurchasePlatformIdentityVerifier } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';

const person: AccessPrincipal = { accountId: 'person', authorizationVersion: 3, role: 'guest', purchaseBuilding: null,
  effectiveAuthorization: { mode: 'independent', baseline: { nativeRole: null, pages: [], rules: [
    { id: 'scope', module: 'purchase', effect: 'allow', actions: ['approve', 'create', 'order', 'receive'], buildings: ['C楼'], specialties: ['电气'] },
  ] }, overrides: { rules: [], allowPages: [], denyPages: [] } } };
const account = (overrides: Partial<ManagedAccount> = {}): ManagedAccount => ({ id: 'person', kind: 'local', name: '合成人员', role: 'guest', building: null, enabled: true, deleted: false, version: 3, source: 'configuration', loginMethod: 'personnel-password', personnelActive: true, personnelAppId: 'cli_test', ...overrides });
const admin: AccessPrincipal = { accountId: 'admin', authorizationVersion: 7, role: 'admin', purchaseBuilding: null };
const adminAccount = (): ManagedAccount => ({ id: 'admin', kind: 'local', name: '管理员', role: 'admin', building: null, enabled: true, deleted: false, version: 7, source: 'default' });
const record = { status: '审批通过（待下单）', building: 'C楼', specialty: '电气' };

function fixture(impersonation = false) {
  let time = 1000, validSession = true, target = structuredClone(person), currentAdmin: AccessPrincipal | undefined = structuredClone(admin), accounts = [account(), adminAccount()];
  const marked: AccessPrincipal = { ...target, ...(impersonation ? { impersonation: { actorAccountId: 'admin', actorName: '管理员', targetName: '人员', expiresAt: 10000 } } : {}) };
  const ports = {
    readSignedSession: jest.fn(() => validSession ? { principal: structuredClone(marked), principalFingerprint: 'x'.repeat(43), expiresAt: 10000 } : { principal: { role: 'guest' as const, purchaseBuilding: null }, principalFingerprint: null, expiresAt: null }),
    snapshot: jest.fn(() => ({ appId: 'cli_test', accounts: structuredClone(accounts) })),
    currentPrincipal: jest.fn((id: string, version: number) => id === 'person' && version === target.authorizationVersion ? structuredClone(target) : id === 'admin' && currentAdmin && version === currentAdmin.authorizationVersion ? structuredClone(currentAdmin) : undefined),
  };
  return { verifier: createPurchasePlatformIdentityVerifier(ports, () => time), ports,
    expire: () => { time = 10000; }, stop: () => { validSession = false; }, revokeTarget: () => { target.authorizationVersion = 4; },
    revokeAdmin: () => { currentAdmin = undefined; }, disallowAction: () => { target.effectiveAuthorization!.baseline.rules[0]!.actions = ['approve']; },
    setAccounts: (next: ManagedAccount[]) => { accounts = next; } };
}
describe('isolated platform identity proof', () => {
  it('uses a real account identity without inventing a Feishu identifier and rejects copied proofs', () => {
    const f = fixture(), proof = f.verifier.verify('sensitive-session-token');
    expect(proof).toEqual({ source: 'platform', actorAccountId: 'person', actorAuthorizationVersion: 3, subjectAccountId: 'person', subjectAuthorizationVersion: 3, actorDisplayName: '合成人员', subjectDisplayName: '合成人员', sessionFamilyFingerprint: 'x'.repeat(43), expiresAt: 10000 });
    expect(JSON.stringify(proof)).not.toContain('sensitive-session-token'); expect(Object.isFrozen(proof)).toBe(true);
    expect(() => f.verifier.assertCurrent(proof, 'order', record)).not.toThrow();
    expect(() => f.verifier.assertCurrent({ ...proof }, 'order', record)).toThrow();
  });
  it('keeps administrator actor and target authorization versions distinct', () => {
    const f = fixture(true), proof = f.verifier.verify('synthetic-token');
    expect(proof).toMatchObject({ source: 'impersonation', actorAccountId: 'admin', actorAuthorizationVersion: 7, actorDisplayName: '管理员', subjectAccountId: 'person', subjectAuthorizationVersion: 3, subjectDisplayName: '合成人员' });
    expect(proof.actorFeishuOpenId).toBeUndefined(); expect(() => f.verifier.assertCurrent(proof, 'order', record)).not.toThrow();
  });
  it.each(['stop', 'expire', 'target', 'admin', 'action'] as const)('rejects changed %s during use', reason => {
    const f = fixture(true), proof = f.verifier.verify('synthetic-token');
    if (reason === 'stop') f.stop(); if (reason === 'expire') f.expire(); if (reason === 'target') f.revokeTarget();
    if (reason === 'admin') f.revokeAdmin(); if (reason === 'action') f.disallowAction();
    expect(() => f.verifier.assertCurrent(proof, 'order', record)).toThrow();
  });
  it.each([{ ...record, building: 'A楼' }, { ...record, specialty: '暖通' }, { ...record, status: '下单完成（待签收）' }])('rejects out of scope and wrong stage', item => {
    const f = fixture(), proof = f.verifier.verify('synthetic-token'); expect(() => f.verifier.assertCurrent(proof, 'order', item)).toThrow();
  });
  it('requires create permission and warehouse-confirmation stage for platform start', () => {
    const f = fixture(), proof = f.verifier.verify('synthetic-token');
    const start = { ...record, status: '审批通过（待库房确认）' };
    expect(() => f.verifier.assertCurrent(proof, 'start', start)).not.toThrow();
    expect(() => f.verifier.assertCurrent(proof, 'start', record)).toThrow();
    expect(() => f.verifier.assertCurrent(proof, 'start', { ...start, building: 'A楼' })).toThrow();
    f.disallowAction(); expect(() => f.verifier.assertCurrent(proof, 'start', start)).toThrow();
  });
  it('rejects ambiguous, departed, and wrong-app account snapshots', () => {
    for (const rows of [[account(), account()], [account({ personnelActive: false })], [account({ personnelAppId: 'cli_other' })]]) {
      const f = fixture(); f.setAccounts(rows); expect(() => f.verifier.verify('synthetic-token')).toThrow();
    }
  });
  it('rejects shared local subjects rather than inventing a personal actor', () => {
    for (const isImpersonation of [false, true]) {
      const f = fixture(isImpersonation); f.setAccounts([account({ loginMethod: undefined }), adminAccount()]);
      expect(() => f.verifier.verify('synthetic-token')).toThrow();
    }
  });
  it.each(['', '  有空格  ', '伪造\n名字', '\u202e非法'])('rejects unsafe account display names', name => {
    const f = fixture(); f.setAccounts([account({ name }), adminAccount()]); expect(() => f.verifier.verify('synthetic-token')).toThrow();
  });
  it('does not carry the subject Feishu openId as an impersonating administrator identity', () => {
    const f = fixture(true); f.setAccounts([account({ kind: 'feishu', loginMethod: undefined, appId: 'cli_test', openId: 'ou_target' }), adminAccount()]);
    expect(f.verifier.verify('synthetic-token').actorFeishuOpenId).toBeUndefined();
  });
  it('rejects if the signed session stops or changes while the account snapshot is read', () => {
    const f = fixture(true);
    const first = f.ports.readSignedSession();
    f.ports.readSignedSession.mockReturnValueOnce(first).mockReturnValueOnce({ ...first, principalFingerprint: 'y'.repeat(43) });
    expect(() => f.verifier.verify('synthetic-token')).toThrow();
  });
});
