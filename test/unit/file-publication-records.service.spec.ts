import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type {
  FilePublicationGateway, FilePublicationRecordSchema, FilePublicationTableRecord,
} from '../../server/modules/file-publication/file-publication.gateway';
import { FilePublicationRecordsService } from '../../server/modules/file-publication/file-publication-records.service';
import type { FilePublicationStore, PublicationBatch } from '../../server/modules/file-publication/file-publication.store';

const link = 'https://example.feishu.cn/base/FilePublication?table=tblPublication';
const admin: AccessPrincipal = { role: 'admin', accountId: 'admin', purchaseBuilding: null };
const publisher: AccessPrincipal = { role: 'editor', accountId: 'publisher', purchaseBuilding: null };

function fixture() {
  const schema: FilePublicationRecordSchema = {
    tableName: '发布台账', sourceUrl: link, appToken: 'appExample', tableId: 'tblPublication',
    fields: [
      { key: 'fldTitle', name: '资料名称', type: 1 },
      { key: 'fldPrice', name: '数值', type: 2 },
      { key: 'fldOption', name: '状态', type: 3, options: [{ id: 'opt_a', name: '已确认' }] },
      { key: 'fldMulti', name: '标签', type: 4, options: [{ id: 'opt_b', name: '年度' }, { id: 'opt_c', name: '巡检' }] },
      { key: 'fldDate', name: '发布日期', type: 5 },
      { key: 'fldCheck', name: '已校验', type: 7 },
      { key: 'fldOwner', name: '负责人', type: 11 },
      { key: 'fldLink', name: '链接', type: 15 },
      { key: 'fldFiles', name: '附件', type: 17 },
      { key: 'fldRelated', name: '关联记录', type: 18 },
      { key: 'fldFormula', name: '实时计算', type: 20 },
      { key: 'fldCreated', name: '创建时间', type: 1001 },
      { key: 'fldMarker', name: '发布批次ID', type: 1 },
    ],
  };
  const row: FilePublicationTableRecord = { id: 'rec_plain', fields: {
    资料名称: [{ type: 'text', text: '巡检记录' }], 数值: 3, 状态: { id: 'opt_a' },
    标签: ['巡检', '年度'], 负责人: [{ name: '某人员', id: 'ou_private', avatar_url: 'https://private.test/avatar' }],
    附件: [{ name: '记录.pdf', file_token: 'private_token', tmp_url: 'https://private.test/file' }],
    关联记录: { link_record_ids: ['rec_related'] }, 实时计算: { type: 2, value: [1] }, 创建时间: 1_795_680_000_000,
  } };
  const rows = new Map([[row.id, row]]);
  const createdIds = new Map<string, string>();
  const gateway = {
    getRecordSchema: jest.fn(async (_link: string) => schema),
    listTableRecords: jest.fn(async (_link: string, _cursor?: string): ReturnType<FilePublicationGateway['listTableRecords']> => (
      { records: Array.from(rows.values()), pageToken: 'next-page' }
    )),
    getTableRecord: jest.fn(async (_link: string, id: string) => rows.get(id) ?? null),
    createTableRecord: jest.fn(async (_link: string, token: string, fields: Record<string, unknown>) => {
      const storedId = createdIds.get(token);
      if (storedId) return rows.get(storedId)!;
      const newRow = { id: 'rec_created' + createdIds.size, fields };
      createdIds.set(token, newRow.id);
      rows.set(newRow.id, newRow);
      return newRow;
    }),
    updateTableRecord: jest.fn(async (_link: string, id: string, fields: Record<string, unknown>) => {
      const updated = { id, fields: { ...rows.get(id)?.fields, ...fields } };
      rows.set(id, updated);
      return updated;
    }),
    deleteTableRecord: jest.fn(async (_link: string, id: string) => { rows.delete(id); }),
  };
  const batches = { list: jest.fn(async (): Promise<PublicationBatch[]> => []) };
  const service = () => new FilePublicationRecordsService(gateway as unknown as FilePublicationGateway, batches as unknown as FilePublicationStore);
  return { schema, row, rows, gateway, createdIds, batches, service };
}

describe('file publication table record CRUD', () => {
  let directory: string;
  let previousState: string | undefined;
  beforeEach(async () => {
    previousState = process.env.FILE_PUBLICATION_STATE_DIR;
    directory = await mkdtemp(join(tmpdir(), 'file-publication-records-'));
    process.env.FILE_PUBLICATION_STATE_DIR = directory;
  });
  afterEach(async () => {
    if (previousState === undefined) delete process.env.FILE_PUBLICATION_STATE_DIR;
    else process.env.FILE_PUBLICATION_STATE_DIR = previousState;
    await rm(directory, { force: true, recursive: true });
  });

  it('gates source access and presents real schema, cursor, typed values and safe read-only summaries', async () => {
    const { service, schema, gateway } = fixture();
    const app = service();
    await expect(app.query(publisher, { link })).rejects.toThrow('无权操作');
    await expect(app.query({ ...admin, requiresPasswordChange: true }, { link })).rejects.toThrow('无权操作');
    expect(gateway.getRecordSchema).not.toHaveBeenCalled();
    const page = await app.query(admin, { link, pageToken: 'previous-page' });
    expect(gateway.listTableRecords).toHaveBeenCalledWith(link, 'previous-page', schema);
    expect(page).toMatchObject({ tableName: '发布台账', pageToken: 'next-page', permissions: { create: true, update: true, delete: true },
      records: [{ managed: false, values: { fldTitle: '巡检记录', fldPrice: 3, fldOption: '已确认', fldMulti: ['巡检', '年度'].sort(),
        fldOwner: '某人员', fldLink: null, fldFiles: '记录.pdf', fldCheck: false, fldRelated: '关联 1 条记录', fldFormula: '1',
        fldCreated: expect.stringMatching(/2026/u) } }] });
    expect(page.fields.filter(field => !field.editable).map(field => field.key)).toEqual(['fldOwner', 'fldFiles', 'fldRelated', 'fldFormula', 'fldCreated', 'fldMarker']);
    expect(JSON.stringify(page)).not.toMatch(/ou_private|private_token|https:\/\/private.test/);
  });

  it('validates keyword and field selection, binds the source cursor to the search, and preserves row permissions', async () => {
    const { service, schema, gateway, row } = fixture();
    const app = service();
    const search = { keyword: ' 巡检 ', fieldKey: 'fldTitle' };
    await expect(app.query(publisher, { link, search })).rejects.toThrow('无权操作');
    await expect(app.query(admin, { link, search: { keyword: '\u0000' } })).rejects.toThrow('搜索关键词');
    expect(gateway.getRecordSchema).not.toHaveBeenCalled();
    await expect(app.query(admin, { link, search: { ...search, fieldKey: 'fldFormula' } })).rejects.toThrow('可搜索的文本字段');
    expect(gateway.listTableRecords).not.toHaveBeenCalled();
    gateway.listTableRecords.mockResolvedValueOnce({ records: [row], pageToken: 'source-next', total: 51 });
    const first = await app.query(admin, { link, search });
    expect(first).toMatchObject({ total: 51, records: [{ id: row.id, managed: false, values: { fldTitle: '巡检记录' } }] });
    expect(first.pageToken).toMatch(/^[0-9a-f]{64}:source-next$/u);
    expect(gateway.listTableRecords).toHaveBeenLastCalledWith(link, undefined, schema, { keyword: '巡检', fieldNames: ['资料名称'] });
    await expect(app.query(admin, { link, search: { ...search, keyword: '其他' }, pageToken: first.pageToken })).rejects.toThrow('重新搜索');
    expect(gateway.listTableRecords).toHaveBeenCalledTimes(1);
    gateway.listTableRecords.mockResolvedValueOnce({ records: [], total: 51 });
    await expect(app.query(admin, { link, search, pageToken: first.pageToken })).resolves.toMatchObject({ records: [], total: 51 });
    expect(gateway.listTableRecords).toHaveBeenLastCalledWith(link, 'source-next', schema, { keyword: '巡检', fieldNames: ['资料名称'] });
    expect(gateway.createTableRecord).not.toHaveBeenCalled();
    expect(gateway.updateTableRecord).not.toHaveBeenCalled();
    expect(gateway.deleteTableRecord).not.toHaveBeenCalled();
  });

  it('validates edited values, pins the schema, and verifies a newly created row after receipt loss', async () => {
    const { service, schema, gateway, createdIds } = fixture();
    const app = service();
    const { schemaVersion } = await app.query(admin, { link });
    const request = { link, schemaVersion, requestId: randomUUID(), values: { fldTitle: '可编辑资料', fldMulti: ['巡检', '年度'],
      fldDate: 1_795_680_000_000, fldCheck: false, fldLink: { text: '文档', link: 'https://example.test/details' }, fldPrice: 0 } };
    await expect(app.create(admin, { ...request, values: { fldPrice: '3' } })).rejects.toThrow('不符合类型');
    await expect(app.create(admin, { ...request, values: { fldMarker: '覆盖批次' } })).rejects.toThrow('只读');
    await expect(app.create(admin, { ...request, values: { fldLink: { text: '禁止', link: 'javascript:alert(1)' } } })).rejects.toThrow('不符合类型');
    expect(gateway.createTableRecord).not.toHaveBeenCalled();
    const create = gateway.createTableRecord.getMockImplementation()!;
    gateway.createTableRecord.mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error('模拟云端已写入但回执丢失');
    });
    await expect(app.create(admin, request)).rejects.toThrow('原请求重试');
    gateway.createTableRecord.mockRejectedValueOnce(new ForbiddenException('飞书权限暂不可用'));
    await expect(service().create(admin, request)).rejects.toThrow('原请求重试');
    const result = await service().create(admin, request);
    expect(result.record.values).toMatchObject({ fldTitle: request.values.fldTitle, fldPrice: 0, fldCheck: false });
    expect(gateway.createTableRecord).toHaveBeenCalledTimes(3);
    expect(new Set(gateway.createTableRecord.mock.calls.map(call => call[1])).size).toBe(1);
    expect(gateway.getTableRecord).toHaveBeenLastCalledWith(link, result.record.id, schema);
    expect(await service().create(admin, request)).toEqual(result);
    expect(gateway.createTableRecord).toHaveBeenCalledTimes(3);
    expect(createdIds.size).toBe(1);
    const anotherRequest = { ...request, requestId: randomUUID() };
    schema.appToken = 'differentApp';
    await expect(service().create(admin, anotherRequest)).rejects.toThrow('结构已变化');
  });

  it('serializes competing edits against the same row and ignores attachment URL renewal for versioning', async () => {
    const { service, row, gateway } = fixture();
    const app = service();
    const { records: [first] } = await app.query(admin, { link });
    (row.fields.附件 as Array<{ tmp_url: string }>)[0].tmp_url = 'https://private.test/renewed';
    row.fields.实时计算 = { type: 2, value: [2] };
    const firstEdit = { link, version: first.version, requestId: randomUUID(), values: { fldTitle: '新版巡检', fldPrice: null } };
    const secondEdit = { link, version: first.version, requestId: randomUUID(), values: { fldTitle: '并发修改内容' } };
    const results = await Promise.allSettled([app.update(admin, row.id, firstEdit), app.update(admin, row.id, secondEdit)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { message: '记录内容已变化，请刷新后核对' } });
    expect(gateway.updateTableRecord).toHaveBeenCalledTimes(1);
    const successful = gateway.updateTableRecord.mock.calls[0][2].资料名称 === '新版巡检' ? firstEdit : secondEdit;
    await expect(service().update(admin, row.id, successful)).resolves.toMatchObject({ record: { id: row.id } });
    expect(gateway.updateTableRecord).toHaveBeenCalledTimes(1);
  });

  it('retains rich text and presents a definite first write rejection without replay', async () => {
    const { service, row, gateway } = fixture();
    row.fields.资料名称 = [{ type: 'url', text: '原文', link: 'https://example.test/original' }];
    const app = service();
    const { records: [first], schemaVersion } = await app.query(admin, { link });
    expect(first).toMatchObject({ readonlyFields: ['fldTitle'], values: { fldTitle: '原文' } });
    await expect(app.update(admin, row.id, { link, version: first.version, requestId: randomUUID(), values: { fldTitle: '覆盖' } })).rejects.toThrow('富文本');
    expect(gateway.updateTableRecord).not.toHaveBeenCalled();
    await expect(app.update(admin, row.id, { link, version: first.version, requestId: randomUUID(), values: { fldMulti: [] } })).resolves.toMatchObject({ record: { values: { fldMulti: [] } } });
    expect(gateway.updateTableRecord.mock.calls[0][2]).toEqual({ 标签: null });
    gateway.createTableRecord.mockRejectedValueOnce(new ForbiddenException('飞书拒绝新增'));
    const request = { link, schemaVersion, requestId: randomUUID(), values: { fldTitle: '新建资料' } };
    await expect(app.create(admin, request)).rejects.toThrow('飞书拒绝新增');
    await expect(service().create(admin, request)).rejects.toThrow('飞书拒绝新增');
    expect(gateway.createTableRecord).toHaveBeenCalledTimes(1);
  });

  it('does not delete on an outdated version and verifies an already-applied deletion on retry', async () => {
    const { service, row, rows, gateway } = fixture();
    const app = service();
    const { records: [first] } = await app.query(admin, { link });
    row.fields.资料名称 = '另一终端更新';
    await expect(app.deleteRecord(admin, row.id, { link, version: first.version, requestId: randomUUID() })).rejects.toThrow('记录内容已变化');
    expect(gateway.deleteTableRecord).not.toHaveBeenCalled();
    const { records: [fresh] } = await app.query(admin, { link });
    const request = { link, version: fresh.version, requestId: randomUUID() };
    gateway.deleteTableRecord.mockImplementationOnce(async (_link, id) => {
      rows.delete(id);
      throw new Error('删除回执丢失');
    });
    await expect(app.deleteRecord(admin, row.id, request)).resolves.toEqual({ deleted: true, id: row.id });
    await expect(service().deleteRecord(admin, row.id, request)).resolves.toEqual({ deleted: true, id: row.id });
    expect(gateway.deleteTableRecord).toHaveBeenCalledTimes(1);
  });

  it('protects every managed batch and fails closed while its original marker no longer exists', async () => {
    const { service, schema, row, rows, batches, gateway } = fixture();
    const app = service();
    rows.set('rec_marked', { id: 'rec_marked', fields: { 发布批次ID: [{ text: '未经本地绑定的批次' }] } });
    rows.set('rec_linked', { id: 'rec_linked', fields: { 资料名称: '老批次' } });
    const prepared = { appToken: schema.appToken, tableId: schema.tableId, batchField: '发布批次ID' };
    batches.list.mockResolvedValueOnce([{ sourceUrl: 'https://example.feishu.cn/wiki/alias?table=tblPublication',
      recordId: 'rec_linked', prepared, status: 'rejected' } as PublicationBatch]);
    const known = await app.query(admin, { link });
    expect(known.records.filter(record => record.managed).map(record => record.id).sort()).toEqual(['rec_linked', 'rec_marked']);
    const marked = known.records.find(record => record.id === 'rec_marked')!;
    await expect(app.deleteRecord(admin, marked.id, { link, version: marked.version, requestId: randomUUID() })).rejects.toThrow('文件发布流程维护');
    const first = known.records.find(record => record.id === row.id)!;
    schema.fields = schema.fields.filter(field => field.key !== 'fldMarker');
    batches.list.mockResolvedValue([{ sourceUrl: link, prepared, commitStartedAt: Date.now(), status: 'failed' } as PublicationBatch]);
    expect((await app.query(admin, { link })).records.every(record => record.managed)).toBe(true);
    await expect(app.update(admin, row.id, { link, version: first.version, requestId: randomUUID(), values: { fldTitle: '覆盖' } })).rejects.toThrow('文件发布流程维护');
    expect(gateway.updateTableRecord).not.toHaveBeenCalled();
    expect(gateway.deleteTableRecord).not.toHaveBeenCalled();
  });
});
