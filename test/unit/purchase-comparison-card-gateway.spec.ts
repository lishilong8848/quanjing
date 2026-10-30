import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapExecutionRecord, PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { PurchaseComparisonCardAssetsStore } from '../../server/modules/purchase-inventory/purchase-comparison-card-assets.store';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXeoAAAAASUVORK5CYII=', 'base64');
const raw = (id: string) => ({ record_id: id, fields: { '采购编码': 'CG-SYNTHETIC', '采购流程': '未开始（待审批）', '申请楼栋': 'H楼',
  '需求人': [{ id: 'ou_synthetic', name: '合成人员' }], '是否满足三家比价（线下）': '是', '三方比价依据（邮件/报价单）': [1, 2, 3].map(i => ({ file_token: `synthetic_file_${i}`, name: `${i}.png`, type: 'image/png', size: png.length })) } });
describe('采购比价批量取源网关', () => {
  let directory: string, gateway: PurchaseWorkflowGateway, post: jest.Mock, get: jest.Mock;
  const env = { ...process.env };
  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_synthetic'; process.env.FEISHU_PURCHASE_INVENTORY_SOURCE_URL = 'https://vnet.feishu.cn/base/appSynthetic';
    directory = mkdtempSync(join(tmpdir(), 'purchase-comparison-gateway-'));
    let image = 0;
    post = jest.fn(async (url: string) => url.endsWith('/batch_get') ? { data: { code: 0, data: { records: [raw('recOne'), raw('recTwo')], absent_record_ids: [], forbidden_record_ids: [] } } }
      : { data: { code: 0, data: { image_key: `img_synthetic_${++image}` } } });
    get = jest.fn(async () => ({ data: png, headers: { 'content-type': 'image/png' } }));
    gateway = new PurchaseWorkflowGateway({ axiosRef: { post, get } } as never);
    (gateway as any).comparisonCardAssets = new PurchaseComparisonCardAssetsStore(join(directory, 'assets.json'));
    jest.spyOn(gateway as any, 'config').mockReturnValue({ appToken: 'appSynthetic', executionTableId: 'tblSynthetic' });
    jest.spyOn(gateway as any, 'getTenantAccessToken').mockResolvedValue('synthetic-token');
  });
  afterEach(() => { jest.restoreAllMocks(); process.env = { ...env }; rmSync(directory, { recursive: true, force: true }); });

  it('一批只做一次记录batch_get，两条同附件只上传3次且分别绑定原记录', async () => {
    const result = await gateway.prepareManagerComparisonBatchEvidence([mapExecutionRecord(raw('recOne')), mapExecutionRecord(raw('recTwo'))]);
    expect(result.map(item => item.recordId)).toEqual(['recOne', 'recTwo']);
    expect(result[0].attachments).toEqual(result[1].attachments);
    expect(post.mock.calls.filter(call => String(call[0]).endsWith('/batch_get'))).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[0][1]).toEqual({ record_ids: ['recOne', 'recTwo'] });
    expect(post.mock.calls[0][2]).toMatchObject({ timeout: 10000, maxRedirects: 0 });
    expect(JSON.stringify(result)).not.toContain('synthetic_file_');
  });

  it.each([
    { records: [raw('recOne'), raw('recStranger')] },
    { records: [raw('recOne'), raw('recOne')] },
    { records: [raw('recOne')] },
    { records: [raw('recOne'), raw('recTwo')], forbidden_record_ids: ['recTwo'] },
  ])('缺失、重复、跨记录或禁止取源均不下载图片 %#', async data => {
    post.mockResolvedValueOnce({ data: { code: 0, data } });
    await expect(gateway.prepareManagerComparisonBatchEvidence([mapExecutionRecord(raw('recOne')), mapExecutionRecord(raw('recTwo'))])).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('非三方记录在读取网络前被拒绝', async () => {
    await expect(gateway.prepareManagerComparisonBatchEvidence([{ ...mapExecutionRecord(raw('recOne')), procurementForm: '单一采购' }])).rejects.toThrow('范围无效');
    expect(post).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
});
