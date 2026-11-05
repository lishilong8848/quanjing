jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const method = () => (value: unknown, context?: { kind?: string }) => typeof context === 'object' && context?.kind === 'method' ? value : undefined;
  return { ...actual, Post: method, SetMetadata: method, Req: () => () => undefined, Body: () => () => undefined, Res: () => () => undefined };
});
import { PurchaseLifecycleAttachmentAccessService } from '../../server/modules/purchase-inventory/purchase-lifecycle-attachment-access.service';
import { PurchaseLifecycleAttachmentAccessController } from '../../server/modules/purchase-inventory/purchase-lifecycle-attachment-access.controller';

describe('purchase lifecycle attachment session access', () => {
  const appId = 'cli_test', openId = 'ou_person', accountId = 'feishu-account';
  const principal = { role: 'admin' as const, purchaseBuilding: null, accountId, authorizationVersion: 1 };
  const request = { batchId: 'purchase-batch-1', recordId: 'rec_one', messageId: 'om_card', purpose: 'comparison' as const, index: 0 };
  let revision: number, authorized: boolean, current: any, accounts: any[];
  const access = { snapshot: jest.fn(), currentPrincipal: jest.fn() };
  const store = { verifyLifecycleCallback: jest.fn(), getLifecycleOutbox: jest.fn() };
  const grant = { assertCurrent: jest.fn(), verifyLatest: jest.fn(), authorizeBatch: jest.fn(), project: jest.fn() };
  const authorizer = { prepare: jest.fn() };
  const gateway = { identifyLifecycleAttachment: jest.fn(), downloadLifecycleAttachment: jest.fn() };
  const make = () => new PurchaseLifecycleAttachmentAccessService(access as any, store as any, authorizer as any, gateway as any, 'test-secret-with-at-least-thirty-two-bytes', () => appId, () => 1793750400000);
  beforeEach(() => {
    revision = 1; authorized = true; current = { ...principal };
    accounts = [{ id: accountId, kind: 'feishu', appId, openId, enabled: true, deleted: false }];
    access.snapshot.mockReset().mockImplementation(() => ({ appId, revision, accounts }));
    access.currentPrincipal.mockReset().mockImplementation(() => current);
    grant.assertCurrent.mockReset(); grant.verifyLatest.mockReset().mockResolvedValue(undefined); grant.authorizeBatch.mockReset();
    grant.project.mockReset().mockImplementation(() => ({ items: [{ recordId: 'rec_one', status: '未开始（待审批）', stages: [{ stage: 'application', fields: [{ label: '物品', value: '样品' }] }] }],
      viewer: { kind: 'participant', grants: authorized ? [{ recordId: 'rec_one', visibleStages: ['application'], allowedActions: [] }] : [] } }));
    authorizer.prepare.mockReset().mockResolvedValue(grant);
    store.verifyLifecycleCallback.mockReset().mockImplementation(async (identity, message, check) => {
      if (identity.recipientOpenId !== openId || identity.batchId !== request.batchId || message !== request.messageId) throw new Error('binding');
      check({ approvalBatchId: request.batchId }, { appliedRevision: 1 });
    });
    store.getLifecycleOutbox.mockReset().mockResolvedValue({ replica: { state: 'delivered', generation: 2, messageId: request.messageId } });
    gateway.identifyLifecycleAttachment.mockReset().mockResolvedValue('fake-internal-file-token');
    gateway.downloadLifecycleAttachment.mockReset().mockResolvedValue({ data: Buffer.from('%PDF-test'), contentType: 'application/pdf' });
  });

  it('derives the recipient from the current session and rechecks authorization on issue and download', async () => {
    const service = make();
    const ticket = await service.issue(principal, request);
    expect(ticket).not.toContain('fake-internal-file-token');
    const result = await service.read(principal, ticket);
    expect(result).toMatchObject({ data: Buffer.from('%PDF-test'), contentType: 'application/pdf', disposition: 'attachment', noSniff: true });
    expect(store.verifyLifecycleCallback).toHaveBeenCalledWith({ appId, batchId: request.batchId, recipientOpenId: openId }, request.messageId, expect.any(Function));
    expect(authorizer.prepare).toHaveBeenCalledTimes(4);
  });

  it('rejects foreign message, revoked scope and stale or shared sessions', async () => {
    const service = make();
    await expect(service.issue(principal, { ...request, messageId: 'om_other' })).rejects.toThrow();
    const ticket = await service.issue(principal, request);
    authorized = false;
    await expect(service.read(principal, ticket)).rejects.toThrow();
    expect(gateway.downloadLifecycleAttachment).not.toHaveBeenCalled();
    current = undefined;
    await expect(service.read(principal, ticket)).rejects.toThrow();
    current = { ...principal }; accounts = [{ id: accountId, kind: 'local', enabled: true, deleted: false }];
    await expect(service.read(principal, ticket)).rejects.toThrow();
    await expect(service.issue({ ...principal, impersonation: { actorAccountId: 'other', actorName: 'x', targetName: 'y', expiresAt: 1 } }, request)).rejects.toThrow();
  });

  it('rejects a request for a different attachment stage or a different recipient session', async () => {
    const service = make();
    await expect(service.issue(principal, { ...request, purpose: 'payment' })).rejects.toThrow();
    const ticket = await service.issue(principal, request);
    accounts[0].openId = 'ou_other';
    await expect(service.read(principal, ticket)).rejects.toThrow();
    expect(gateway.downloadLifecycleAttachment).not.toHaveBeenCalled();
  });

  it('derives the recipient and current card message from the session and rejects stale generations or added identities', async () => {
    const service = make();
    const input = { batchId: request.batchId, recordId: request.recordId, purpose: request.purpose, index: 0, generation: 2 };
    expect(await service.issueCurrent(principal, input)).toBeTruthy();
    expect(store.getLifecycleOutbox).toHaveBeenCalledWith({ appId, batchId: request.batchId, recipientOpenId: openId });
    await expect(service.issueCurrent(principal, { ...input, generation: 1 })).rejects.toThrow();
    await expect(service.issueCurrent(principal, { ...input, recipientOpenId: 'ou_other' } as any)).rejects.toThrow();
    store.getLifecycleOutbox.mockResolvedValueOnce({ replica: { state: 'send_unknown', generation: 2, messageId: request.messageId } });
    await expect(service.issueCurrent(principal, input)).rejects.toThrow();
  });

  it('uses the server request principal and forces no-store download headers', async () => {
    const old = process.env.PUBLIC_BASE_URL; process.env.PUBLIC_BASE_URL = 'https://platform.example';
    try {
      const service = make();
      const session = { cookieName: 'test_session', readSessionIdentity: jest.fn((cookie: string) => cookie === 'valid' ? { principal, expiresAt: Date.now() + 60_000, principalFingerprint: 'authenticated' } : { principal: { role: 'guest' }, expiresAt: null, principalFingerprint: null }) };
      const controller = new PurchaseLifecycleAttachmentAccessController(service as any, session as any, { isReady: () => true });
      const req = { headers: { cookie: 'test_session=valid', origin: 'https://platform.example' } } as any;
      const issued = await controller.issue(req, request);
      const response = { set: jest.fn(), send: jest.fn() };
      await controller.download(req, issued, response as any);
      expect(response.set).toHaveBeenCalledWith(expect.objectContaining({ 'Content-Disposition': 'attachment; filename="purchase-attachment.pdf"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }));
      expect(response.send).toHaveBeenCalledWith(Buffer.from('%PDF-test'));
      for (const [contentType, extension] of [['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['application/octet-stream', 'bin']] as const) {
        jest.spyOn(service, 'read').mockResolvedValueOnce({ data: Buffer.from('mock'), contentType, disposition: 'attachment', noSniff: true });
        await controller.download(req, issued, response as any);
        expect(response.set).toHaveBeenLastCalledWith(expect.objectContaining({ 'Content-Disposition': `attachment; filename="purchase-attachment.${extension}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }));
      }
      await expect(controller.download(req, { ticket: issued.ticket, token: 'bad' } as any, response as any)).rejects.toThrow();
      await expect(controller.download({ headers: { cookie: 'test_session=invalid', origin: 'https://platform.example' } } as any, issued, response as any)).rejects.toThrow();
      await expect(controller.download({ headers: { cookie: 'test_session=valid', origin: 'https://evil.example' } } as any, issued, response as any)).rejects.toThrow();
      await expect(controller.download({ headers: { cookie: 'test_session=valid', origin: 'https://platform.example', 'sec-fetch-site': 'cross-site' } } as any, issued, response as any)).rejects.toThrow();
      const disabled = new PurchaseLifecycleAttachmentAccessController(service as any, session as any);
      await expect(disabled.issueCurrent(req, { batchId: request.batchId, recordId: request.recordId, purpose: request.purpose, index: 0, generation: 2 })).rejects.toThrow('暂不可用');
      const asyncReady = new PurchaseLifecycleAttachmentAccessController(service as any, session as any, { isReady: (() => Promise.reject(new Error('not ready'))) as any });
      await expect(asyncReady.issueCurrent(req, { batchId: request.batchId, recordId: request.recordId, purpose: request.purpose, index: 0, generation: 2 })).rejects.toThrow('暂不可用');
      await expect(controller.issueCurrent({ headers: { cookie: 'test_session=valid' } } as any, { batchId: request.batchId, recordId: request.recordId, purpose: request.purpose, index: 0, generation: 2 })).rejects.toThrow();
    } finally { if (old === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = old; }
  });
});
