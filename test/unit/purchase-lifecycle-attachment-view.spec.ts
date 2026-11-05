import { PurchaseLifecycleAttachmentViewService, type PurchaseLifecycleAttachmentSelector } from '../../server/modules/purchase-inventory/purchase-lifecycle-attachment-view';

describe('purchase lifecycle attachment view', () => {
  const target: PurchaseLifecycleAttachmentSelector = { appId: 'cli_test', batchId: 'purchase-batch-test', recordId: 'rec_one', recipientOpenId: 'ou_person', messageId: 'om_card', purpose: 'invoice', index: 0 };
  const key = 'this-is-a-test-secret-with-32-or-more-bytes';
  let now: number, internalId: string, authorized: boolean;
  const authority = { assertCanView: jest.fn() };
  const source = { identify: jest.fn(), download: jest.fn() };
  const viewer = { appId: target.appId, openId: target.recipientOpenId, assertCurrent: jest.fn() };
  const make = () => new PurchaseLifecycleAttachmentViewService(key, authority, source, () => now);
  beforeEach(() => {
    now = Date.UTC(2026, 10, 4); internalId = 'SECRET_FILE_TOKEN'; authorized = true;
    viewer.assertCurrent.mockReset();
    authority.assertCanView.mockReset().mockImplementation(async () => { if (!authorized) throw new Error('secret inner error'); });
    source.identify.mockReset().mockImplementation(async () => internalId);
    source.download.mockReset().mockResolvedValue({ data: Buffer.from('file bytes'), contentType: 'application/pdf' });
  });

  it('binds all identities and attachment context without exposing internal tokens', async () => {
    const service = make(), ticket = await service.issue(target, viewer);
    expect(ticket).not.toContain(internalId);
    const decoded = Buffer.from(ticket.split('.')[0], 'base64url').toString('utf8');
    expect(decoded).not.toContain(internalId);
    const payload = JSON.parse(decoded);
    expect(payload).toMatchObject({ ...target, version: 1 });
    const result = await service.read(ticket, viewer);
    expect(result).toMatchObject({ data: Buffer.from('file bytes'), contentType: 'application/pdf', disposition: 'attachment', noSniff: true });
    expect(JSON.stringify(result)).not.toContain(internalId);
    expect(authority.assertCanView).toHaveBeenCalledTimes(4);
    expect(source.identify).toHaveBeenCalledTimes(3);
  });

  it('rejects tampering, expiration, identity mismatch, and weak signing secrets', async () => {
    const service = make(), ticket = await service.issue(target, viewer);
    const [payload, signature] = ticket.split('.');
    await expect(service.read(`${payload}.${signature.slice(0, -1)}x`, viewer)).rejects.toThrow();
    await expect(service.read(ticket, { ...viewer, openId: 'ou_other' })).rejects.toThrow();
    await expect(service.read(ticket, { ...viewer, appId: 'cli_other' })).rejects.toThrow();
    now += 10 * 60_000 + 1;
    await expect(service.read(ticket, viewer)).rejects.toThrow();
    expect(source.download).not.toHaveBeenCalled();
    expect(() => new PurchaseLifecycleAttachmentViewService('short', authority, source)).toThrow();
  });

  it('refuses revocation before or during download and never exposes underlying errors', async () => {
    const service = make(), ticket = await service.issue(target, viewer);
    authorized = false;
    await expect(service.read(ticket, viewer)).rejects.toThrow('采购附件查看凭据或权限无效');
    expect(source.download).not.toHaveBeenCalled();
    authorized = true;
    source.download.mockImplementationOnce(async () => { authorized = false; return { data: Buffer.from('x'), contentType: 'application/pdf' }; });
    await expect(service.read(ticket, viewer)).rejects.toThrow('采购附件查看凭据或权限无效');
  });

  it('rejects an attachment that changed at the same index before or during download', async () => {
    const service = make(), ticket = await service.issue(target, viewer);
    internalId = 'OTHER_FILE_TOKEN';
    await expect(service.read(ticket, viewer)).rejects.toThrow();
    expect(source.download).not.toHaveBeenCalled();
    internalId = 'SECRET_FILE_TOKEN';
    source.download.mockImplementationOnce(async () => { internalId = 'OTHER_FILE_TOKEN'; return { data: Buffer.from('x'), contentType: 'application/pdf' }; });
    await expect(service.read(ticket, viewer)).rejects.toThrow();
  });

  it('rejects untrusted types, oversized files, invalid scope, and async session checks', async () => {
    const service = make(), ticket = await service.issue(target, viewer);
    source.download.mockResolvedValueOnce({ data: Buffer.from('<script>'), contentType: 'text/html' });
    await expect(service.read(ticket, viewer)).rejects.toThrow();
    source.download.mockResolvedValueOnce({ data: Buffer.alloc(20 * 1024 * 1024 + 1), contentType: 'application/pdf' });
    await expect(service.read(ticket, viewer)).rejects.toThrow();
    await expect(service.issue({ ...target, messageId: 'bad' }, viewer)).rejects.toThrow();
    await expect(service.issue({ ...target, index: -1 }, viewer)).rejects.toThrow();
    await expect(service.read(ticket, { ...viewer, assertCurrent: (() => Promise.resolve()) as unknown as () => void })).rejects.toThrow();
  });
});
