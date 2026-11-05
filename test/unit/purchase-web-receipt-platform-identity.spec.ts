import { normalizeWebReceiptCommand, webReceiptFingerprint, webReceiptHash, type PurchaseWebReceiptCommand } from '../../server/modules/purchase-inventory/purchase-web-receipt-command';
import type { PurchasePlatformIdentityProof } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';

const identity: PurchasePlatformIdentityProof = { source: 'impersonation', actorAccountId: 'admin', actorDisplayName: '管理员', actorAuthorizationVersion: 2, subjectAccountId: 'employee', subjectDisplayName: '员工', subjectAuthorizationVersion: 3, sessionFamilyFingerprint: 'x'.repeat(43), expiresAt: 1999999999999 };
function command(platformIdentity?: PurchasePlatformIdentityProof): PurchaseWebReceiptCommand {
  const appId = 'cli_synthetic', ownerId = 'synthetic-owner', mutationId = 'synthetic-mutation';
  const result: PurchaseWebReceiptCommand = { recordId: 'recSynthetic', taskId: `purchase-receipt-${webReceiptHash([appId, ownerId, mutationId])}`, ownerId, appId, mutationId, fingerprint: '', actor: { openId: platformIdentity ? platformIdentity.actorFeishuOpenId || '' : 'ou_operator', name: platformIdentity?.actorDisplayName || '办理人', positions: [], buildings: [] }, scope: { building: 'C楼', specialty: '电气' }, input: { signer: '收货人', signerOpenId: 'ou_signer', receiptTime: 1790000000000, note: '' }, files: [{ name: 'receipt.jpg', mime: 'image/jpeg', size: 1, sha256: 'a'.repeat(64), group: 'receiptPhotos', token: '', uploadStartedAt: '' }], notificationWarnings: [], filesRemoved: false, ...(platformIdentity ? { platformIdentity } : {}) };
  result.fingerprint = webReceiptFingerprint(result);
  return result;
}

describe('网页签收持久身份结构（不代替受理时认证）', () => {
  it('保留旧签收命令指纹及飞书身份规则', () => {
    const row = command();
    expect(normalizeWebReceiptCommand(row)).toEqual(row);
    expect(row.fingerprint).toBe(webReceiptHash([row.recordId, row.ownerId, row.appId, row.mutationId, row.actor, row.scope, row.input, row.files.map(({ token: _token, uploadStartedAt: _startedAt, ...file }) => file)]));
    expect(() => normalizeWebReceiptCommand({ ...row, actor: { ...row.actor, openId: '' } })).toThrow();
  });
  it('无飞书身份可记录实际代登录管理员和授权主体，不把签收人当操作人', () => {
    const row = command(identity), saved = normalizeWebReceiptCommand(row);
    expect(saved.actor.openId).toBe('');
    expect(saved.platformIdentity).toEqual(identity);
    expect(saved.input.signerOpenId).toBe('ou_signer');
    expect(JSON.stringify(saved)).not.toContain('accessToken');
  });
  it('拒绝伪造操作人、修改身份、令牌或无效身份字段', () => {
    const row = command(identity);
    expect(() => normalizeWebReceiptCommand({ ...row, actor: { ...row.actor, openId: 'ou_signer' } })).toThrow();
    expect(() => normalizeWebReceiptCommand({ ...row, platformIdentity: { ...identity, actorAccountId: 'other' } })).toThrow();
    expect(() => normalizeWebReceiptCommand({ ...row, platformIdentity: { ...identity, cookie: 'fake' } })).toThrow();
    expect(() => command({ ...identity, source: 'platform' })).toThrow();
  });
});
