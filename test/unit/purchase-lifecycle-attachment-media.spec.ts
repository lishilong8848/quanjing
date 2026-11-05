jest.mock('../../server/common/config/external-services.config', () => {
  const original = jest.requireActual('../../server/common/config/external-services.config');
  return { ...original, readEnv: (name: string) => name === 'FEISHU_APP_ID' ? 'cli_test' : '' };
});
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { resolveLifecycleAttachmentFromRecord } from '../../server/modules/purchase-inventory/purchase-lifecycle-attachment-media';
import type { PurchaseLifecycleAttachmentSelector } from '../../server/modules/purchase-inventory/purchase-lifecycle-attachment-view';

describe('purchase lifecycle controlled attachment source', () => {
  const target: PurchaseLifecycleAttachmentSelector = { appId: 'cli_test', batchId: 'purchase-batch-test', recordId: 'recOne', recipientOpenId: 'ou_person', messageId: 'om_card', purpose: 'payment', index: 0 };
  const data = Buffer.from('%PDF-example');
  const token = 'fake_file_token';
  const permission = { bitablePerm: { tableId: 'tblABC', attachments: { fldABC: { recOne: [token] } } } };
  const official = `https://open.feishu.cn/open-apis/drive/v1/medias/${token}/download?extra=${encodeURIComponent(JSON.stringify(permission))}`;
  const attachment = () => ({ file_token: token, size: data.length, type: 'application/pdf', name: 'test.pdf', url: official });
  const raw = () => ({ record_id: 'recOne', fields: { '付款截屏（显示付款金额）': [attachment()] } });
  const get = jest.fn();
  let gateway: PurchaseWorkflowGateway;
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ data, headers: { 'content-type': 'application/pdf' } });
    gateway = new PurchaseWorkflowGateway({ axiosRef: { get } } as any);
    (gateway as any).config = () => ({ executionTableId: 'tblABC' });
    (gateway as any).readExecutionRecordAsApp = jest.fn(async () => raw());
    (gateway as any).getTenantAccessToken = async () => 'fake-tenant-token';
  });
  it('rereads the exact record and downloads only the official media endpoint with validated extra', async () => {
    expect(await gateway.identifyLifecycleAttachment(target)).toBe(token);
    const result = await gateway.downloadLifecycleAttachment(target, token);
    expect(result).toEqual({ data, contentType: 'application/pdf' });
    const [url, config] = get.mock.calls[0];
    expect(url).toBe(`https://open.feishu.cn/open-apis/drive/v1/medias/${token}/download`);
    expect(JSON.parse(config.params.extra)).toEqual(permission);
    expect(config.maxRedirects).toBe(0);
    expect(config.maxContentLength).toBe(20 * 1024 * 1024);
    expect((gateway as any).readExecutionRecordAsApp).toHaveBeenCalledTimes(2);
  });
  it('rejects changed identity or attachment, malformed extra, wrong record, type and size', async () => {
    await expect(gateway.identifyLifecycleAttachment({ ...target, appId: 'cli_wrong' })).rejects.toThrow();
    await expect(gateway.downloadLifecycleAttachment(target, 'other')).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    const bad = raw(); bad.fields['付款截屏（显示付款金额）'][0].url = `https://evil.example/open-apis/drive/v1/medias/${token}/download?extra=anything`;
    expect(() => resolveLifecycleAttachmentFromRecord(bad as any, 'tblABC', target)).toThrow();
    expect(() => resolveLifecycleAttachmentFromRecord({ ...raw(), record_id: 'other' } as any, 'tblABC', target)).toThrow();
    expect(() => resolveLifecycleAttachmentFromRecord(raw() as any, 'tblABC', { ...target, index: 2 })).toThrow();
    const invalidSize = raw(); invalidSize.fields['付款截屏（显示付款金额）'][0].size = 21 * 1024 * 1024;
    expect(() => resolveLifecycleAttachmentFromRecord(invalidSize as any, 'tblABC', target)).toThrow();
    get.mockResolvedValueOnce({ data: Buffer.from('not-pdf---!'), headers: { 'content-type': 'application/pdf' } });
    await expect(gateway.downloadLifecycleAttachment(target, token)).rejects.toThrow();
  });
  it('never guesses invoice identity from the combined receipt attachment field', () => {
    const combined = { record_id: 'recOne', fields: { '签收附件': [attachment()] } } as any;
    expect(() => resolveLifecycleAttachmentFromRecord(combined, 'tblABC', { ...target, purpose: 'invoice' })).toThrow();
    expect(resolveLifecycleAttachmentFromRecord(combined, 'tblABC', { ...target, purpose: 'receipt' }).fileToken).toBe(token);
  });
});
