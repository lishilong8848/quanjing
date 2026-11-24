import type { HttpService } from '@nestjs/axios';
import { FilePublicationGateway } from './file-publication.gateway';

jest.mock('../../common/feishu/bitable-direct-read', () => ({
  getTenantAccessToken: jest.fn().mockResolvedValue('test-tenant-token'),
}));

const LINK = 'https://enterprise.feishu.cn/base/appFileFixture?table=tblFileFixture';
const WIKI = 'https://enterprise.feishu.cn/wiki/wikiFileFixture?table=tblFileFixture';
const TARGET = { appToken: 'appFileFixture', tableId: 'tblFileFixture' };
const TABLE_URL = 'https://open.feishu.cn/open-apis/bitable/v1/apps/appFileFixture/tables/tblFileFixture';
const RECORD_URL = `${TABLE_URL}/records`;
const REQUEST_ID = '4382ea12-599b-442a-9ba3-4240d4e21889';
const RECORD = { record_id: 'recFixture', fields: { 资料名称: [{ text: '巡检手册', type: 'text' }], 状态: '待处理' } };
const COLUMNS = [
  { field_id: 'fldName', field_name: '资料名称', type: 1, is_primary: true },
  { field_id: 'fldStatus', field_name: '状态', type: 3, property: { options: [{ id: 'optOpen', name: '待处理', color: 0 }] } },
  { field_id: 'fldBatch', field_name: '发布批次ID', type: 1 },
  { field_id: 'fldFormula', field_name: '公式', type: 20 },
  { field_id: 'fldSpace', field_name: ' 资料来源 ', type: 1 },
];
const ok = (data: unknown) => ({ data: { code: 0, data } });

describe('file publication Bitable record management gateway', () => {
  let oldTables: string | undefined;
  let http: { get: jest.Mock; post: jest.Mock; put: jest.Mock; delete: jest.Mock };
  let gateway: FilePublicationGateway;

  beforeEach(() => {
    oldTables = process.env.FILE_PUBLICATION_TABLES_JSON;
    process.env.FILE_PUBLICATION_TABLES_JSON = JSON.stringify([
      { label: '记录台账', url: LINK }, { label: '知识库台账', url: WIKI },
    ]);
    http = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
    gateway = new FilePublicationGateway({ axiosRef: http } as unknown as HttpService);
  });

  afterEach(() => {
    if (oldTables === undefined) delete process.env.FILE_PUBLICATION_TABLES_JSON;
    else process.env.FILE_PUBLICATION_TABLES_JSON = oldTables;
  });

  it('uses the Nantong ledger when unset and honors an explicit empty allowlist', async () => {
    const link = 'https://vnet.feishu.cn/base/MliKbC3fXa8PXrsndKscmxjdn1g?table=tblzKmM9oQrtJwIw';
    expect(gateway.tables().map(table => table.link)).toEqual([LINK, WIKI]);
    await expect(gateway.getRecordSchema(link)).rejects.toThrow('尚未配置');
    delete process.env.FILE_PUBLICATION_TABLES_JSON;
    expect(gateway.tables()).toEqual([expect.objectContaining({ link })]);
    http.get.mockResolvedValueOnce(ok({ items: COLUMNS, has_more: false }));
    await expect(gateway.getRecordSchema(`${link}&view=vewFixture`)).resolves.toMatchObject({ sourceUrl: link });
    await expect(gateway.getRecordSchema(`${link}Other`)).rejects.toThrow('尚未配置');
    expect(http.get).toHaveBeenCalledTimes(1);
    process.env.FILE_PUBLICATION_TABLES_JSON = '[]';
    expect(gateway.tables()).toEqual([]);
  });

  it('reads actual fields and option labels across pages without dropping system columns', async () => {
    http.get.mockResolvedValueOnce(ok({ items: COLUMNS.slice(0, 2), has_more: true, page_token: 'fields-next' }));
    http.get.mockResolvedValueOnce(ok({ items: COLUMNS.slice(2), has_more: false }));
    await expect(gateway.getRecordSchema(`${LINK}&view=vewNotARecordScope`)).resolves.toEqual({
      ...TARGET, tableName: '记录台账', sourceUrl: LINK,
      fields: [
        { key: 'fldName', name: '资料名称', type: 1 },
        { key: 'fldStatus', name: '状态', type: 3, options: [{ id: 'optOpen', name: '待处理' }] },
        { key: 'fldBatch', name: '发布批次ID', type: 1 },
        { key: 'fldFormula', name: '公式', type: 20 },
        { key: 'fldSpace', name: ' 资料来源 ', type: 1 },
      ],
    });
    expect(http.get).toHaveBeenLastCalledWith(`${TABLE_URL}/fields`, expect.objectContaining({
      maxRedirects: 0, params: { page_size: 100, page_token: 'fields-next' },
    }));
    http.get.mockResolvedValueOnce(ok({ items: [...COLUMNS, COLUMNS[0]], has_more: false }));
    await expect(gateway.getRecordSchema(LINK)).rejects.toThrow('无法唯一识别');
    http.get.mockResolvedValueOnce(ok({ items: [...COLUMNS, { field_name: '缺少 ID', type: 1 }], has_more: false }));
    await expect(gateway.getRecordSchema(LINK)).rejects.toThrow('字段回执无效');
  });

  it('reads one bounded page and uses the same raw cells when getting a record', async () => {
    http.get.mockResolvedValueOnce(ok({ items: [RECORD], has_more: true, page_token: 'next' }));
    http.get.mockResolvedValueOnce(ok({ items: [], has_more: false }));
    http.get.mockResolvedValueOnce(ok({ record: RECORD }));
    const first = await gateway.listTableRecords(LINK, undefined, TARGET);
    await expect(gateway.listTableRecords(LINK, first.pageToken, TARGET)).resolves.toEqual({ records: [] });
    await expect(gateway.getTableRecord(LINK, RECORD.record_id, TARGET)).resolves.toEqual(first.records[0]);
    expect(first.records[0].fields).toEqual(RECORD.fields);
    expect(http.get).toHaveBeenNthCalledWith(2, RECORD_URL, expect.objectContaining({
      maxRedirects: 0, params: { page_size: 50, text_field_as_array: true, page_token: 'next' },
    }));
    http.get.mockResolvedValueOnce(ok({ items: [RECORD], has_more: true, page_token: 'next' }));
    await expect(gateway.listTableRecords(LINK, 'next', TARGET)).rejects.toThrow('分页回执无效');
    http.get.mockResolvedValueOnce(ok({ items: [RECORD, RECORD], has_more: false }));
    await expect(gateway.listTableRecords(LINK, undefined, TARGET)).rejects.toThrow('无法唯一识别');
    http.get.mockResolvedValueOnce(ok({ has_more: false, total: 0 }));
    await expect(gateway.listTableRecords(LINK, undefined, TARGET)).resolves.toEqual({ records: [], total: 0 });
    http.get.mockResolvedValueOnce(ok({ has_more: false }));
    await expect(gateway.listTableRecords(LINK, undefined, TARGET)).rejects.toThrow('分页回执无效');
  });

  it('searches by text on the source before reading successive 50-row pages', async () => {
    const allRows = Array.from({ length: 115 }, (_, index) => ({
      record_id: `recSearch${index}`,
      fields: { 资料名称: [{ text: index >= 62 ? `档案《通知》 ${index}` : '其他记录', type: 'text' }] },
    }));
    const keyword = '档案《通知》';
    http.post.mockImplementation(async (url, payload, request) => {
      expect(url).toBe(`${RECORD_URL}/search`);
      expect(payload).toEqual({ filter: { conjunction: 'or', conditions: [
        { field_name: '资料名称', operator: 'contains', value: [keyword] },
        { field_name: '说明', operator: 'contains', value: [keyword] },
      ] } });
      expect(request.params.page_size).toBe(50);
      const matches = allRows.filter(row => row.fields.资料名称[0].text.includes(keyword));
      const start = request.params.page_token === 'source-next' ? 50 : 0;
      return ok({
        items: matches.slice(start, start + 50), total: matches.length, has_more: start === 0,
        ...(start === 0 ? { page_token: 'source-next' } : {}),
      });
    });
    const search = { keyword, fieldNames: ['资料名称', '说明'] };
    const first = await gateway.listTableRecords(LINK, undefined, TARGET, search);
    expect(first.records).toHaveLength(50);
    expect(first.records[0]).toEqual({ id: 'recSearch62', fields: allRows[62].fields });
    expect(first.total).toBe(53);
    const second = await gateway.listTableRecords(LINK, first.pageToken, TARGET, search);
    expect(second.records.map(record => record.id)).toEqual(['recSearch112', 'recSearch113', 'recSearch114']);
    expect(second.pageToken).toBeUndefined();
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).toHaveBeenCalledTimes(2);
    await expect(gateway.listTableRecords(LINK.replace('tblFileFixture', 'tblUnknown'), undefined, TARGET, search)).rejects.toThrow('尚未配置');
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('treats only a confirmed missing-record response as absent', async () => {
    http.get.mockResolvedValueOnce({ data: { code: 1254043 } });
    http.get.mockRejectedValueOnce({ response: { status: 404, data: { code: 1254043 } } });
    http.get.mockRejectedValueOnce({ response: { status: 400, data: { code: 1254043 } } });
    http.get.mockRejectedValueOnce({ response: { status: 404, data: { code: 1254041 } } });
    http.get.mockRejectedValueOnce({ response: { status: 403, data: { code: 1254302 } } });
    http.get.mockResolvedValueOnce(ok({ record: { ...RECORD, record_id: 'recDifferent' } }));
    await expect(gateway.getTableRecord(LINK, RECORD.record_id)).resolves.toBeNull();
    await expect(gateway.getTableRecord(LINK, RECORD.record_id)).resolves.toBeNull();
    await expect(gateway.getTableRecord(LINK, RECORD.record_id)).resolves.toBeNull();
    await expect(gateway.getTableRecord(LINK, RECORD.record_id)).rejects.toThrow('核对台账记录失败');
    await expect(gateway.getTableRecord(LINK, RECORD.record_id)).rejects.toThrow('核对台账记录失败');
    await expect(gateway.getTableRecord(LINK, RECORD.record_id)).rejects.toThrow('台账记录回执无效');
  });

  it('sends only the submitted cells and retains consistency checks on each single-row write', async () => {
    const fields = { 状态: '已处理', 备注: null };
    const changed = { ...RECORD, fields: { ...RECORD.fields, ...fields } };
    http.post.mockResolvedValueOnce(ok({ record: RECORD }));
    http.put.mockResolvedValueOnce(ok({ record: changed }));
    http.delete.mockResolvedValueOnce(ok({ deleted: true, record_id: RECORD.record_id }));

    await expect(gateway.createTableRecord(LINK, REQUEST_ID, RECORD.fields, TARGET)).resolves.toEqual({
      id: RECORD.record_id, fields: RECORD.fields,
    });
    await expect(gateway.updateTableRecord(LINK, RECORD.record_id, fields, TARGET)).resolves.toEqual({
      id: RECORD.record_id, fields: changed.fields,
    });
    await expect(gateway.deleteTableRecord(LINK, RECORD.record_id, TARGET)).resolves.toBeUndefined();
    expect(http.post).toHaveBeenCalledWith(RECORD_URL, { fields: RECORD.fields }, expect.objectContaining({
      maxRedirects: 0, params: { client_token: REQUEST_ID, ignore_consistency_check: false },
    }));
    expect(http.put).toHaveBeenCalledWith(`${RECORD_URL}/${RECORD.record_id}`, { fields }, expect.objectContaining({
      maxRedirects: 0, params: { ignore_consistency_check: false },
    }));
    expect(http.delete).toHaveBeenCalledWith(`${RECORD_URL}/${RECORD.record_id}`, expect.objectContaining({
      maxRedirects: 0, params: { ignore_consistency_check: false },
    }));

    http.post.mockRejectedValueOnce(new Error('lost-response fixture'));
    await expect(gateway.createTableRecord(LINK, REQUEST_ID, RECORD.fields, TARGET)).rejects.toThrow('新增台账记录失败');
    expect(http.post).toHaveBeenCalledTimes(2);
    http.delete.mockResolvedValueOnce(ok({ deleted: false, record_id: RECORD.record_id }));
    await expect(gateway.deleteTableRecord(LINK, RECORD.record_id, TARGET)).rejects.toThrow('结果待核对');
    expect(http.delete).toHaveBeenCalledTimes(2);
  });

  it('distinguishes explicit field and access refusals from unknown write results', async () => {
    http.put.mockResolvedValueOnce({ data: { code: 1254045 } });
    http.put.mockRejectedValueOnce({ response: { status: 403, data: { code: 1254302 } } });
    http.put.mockRejectedValueOnce(new Error('unknown write result fixture'));
    const update = () => gateway.updateTableRecord(LINK, RECORD.record_id, { 状态: '已处理' }, TARGET);
    await expect(update()).rejects.toMatchObject({ status: 400 });
    await expect(update()).rejects.toMatchObject({ status: 403 });
    await expect(update()).rejects.toMatchObject({ status: 502 });
    expect(http.put).toHaveBeenCalledTimes(3);
  });

  it('refuses arbitrary tables and changed Wiki targets before a record write', async () => {
    await expect(gateway.createTableRecord(LINK.replace('tblFileFixture', 'tblForbidden'), REQUEST_ID, {}, TARGET))
      .rejects.toThrow('尚未配置');
    await expect(gateway.getRecordSchema(LINK.replace('enterprise.feishu.cn', 'enterprise.feishu.cn.invalid')))
      .rejects.toThrow('飞书多维表链接');
    expect(http.get).not.toHaveBeenCalled();
    http.get.mockResolvedValueOnce(ok({ node: { obj_type: 'bitable', obj_token: 'appMovedFixture' } }));
    await expect(gateway.updateTableRecord(WIKI, RECORD.record_id, { 状态: '已处理' }, TARGET)).rejects.toThrow('多维表已变化');
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.post).not.toHaveBeenCalled();
    expect(http.put).not.toHaveBeenCalled();
  });
});
