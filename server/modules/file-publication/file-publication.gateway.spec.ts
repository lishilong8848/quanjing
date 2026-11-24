import type { HttpService } from '@nestjs/axios';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { FilePublicationDeliveryRejected, FilePublicationGateway } from './file-publication.gateway';
import { readCachedActivePersonnel } from '../bitable-sync/active-personnel-directory';

jest.mock('../../common/feishu/bitable-direct-read', () => ({
  getTenantAccessToken: jest.fn().mockResolvedValue('test-tenant-token'),
}));
jest.mock('../bitable-sync/active-personnel-directory', () => ({ readCachedActivePersonnel: jest.fn() }));

const LINK = 'https://enterprise.feishu.cn/base/appFileFixture?table=tblFileFixture';
const WIKI = 'https://enterprise.feishu.cn/wiki/wikiFileFixture?table=tblFileFixture';
const UUID = '4382ea12-599b-442a-9ba3-4240d4e21889';
const API = 'https://open.feishu.cn/open-apis';
const FIELD_URL = `${API}/bitable/v1/apps/appFileFixture/tables/tblFileFixture/fields`;
const RECORD_URL = `${API}/bitable/v1/apps/appFileFixture/tables/tblFileFixture/records`;
const FILES = [
  { name: 'GL-2026-038 高压配电手册.pdf', size: 3 },
  { name: '巡检表.xlsx', size: 4 },
];
const COLUMNS = [
  { field_id: 'fldName', field_name: '资料名称', type: 1, is_primary: true },
  { field_id: 'fldCode', field_name: '文件编号', type: 1 },
  { field_id: 'fldNote', field_name: '备注', type: 1 },
  { field_id: 'fldCustom', field_name: '专业分类', type: 1 },
  { field_id: 'fldBatch', field_name: '发布批次ID', type: 1 },
  { field_id: 'fldFormula', field_name: '系统公式', type: 20 },
  { field_id: 'fldFiles', field_name: '附件', type: 17 },
];
const ok = (data: unknown) => ({ data: { code: 0, data } });

describe('file publication Feishu adapter', () => {
  const envNames = ['FILE_PUBLICATION_TABLES_JSON', 'FILE_PUBLICATION_GROUPS_JSON', 'PUBLIC_BASE_URL', 'CLIENT_BASE_PATH'];
  let oldEnv: (string | undefined)[];
  let http: { get: jest.Mock; post: jest.Mock };
  let gateway: FilePublicationGateway;

  beforeEach(() => {
    oldEnv = envNames.map(name => process.env[name]);
    process.env.FILE_PUBLICATION_TABLES_JSON = JSON.stringify([
      { label: '试验台账', url: LINK, extraFields: ['专业分类', '系统公式'] },
      { label: '知识库台账', url: WIKI },
    ]);
    process.env.FILE_PUBLICATION_GROUPS_JSON = JSON.stringify([{ id: 'oc_allowed', name: '试验群' }]);
    process.env.PUBLIC_BASE_URL = 'https://portal.example.test:3001';
    delete process.env.CLIENT_BASE_PATH;
    http = { get: jest.fn(), post: jest.fn() };
    gateway = new FilePublicationGateway({ axiosRef: http } as unknown as HttpService);
  });

  afterEach(() => {
    envNames.forEach((name, index) => {
      if (oldEnv[index] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[index];
    });
  });

  it('reads the configured field schema and presents backend-inferred metadata under its real labels', async () => {
    http.get.mockResolvedValue(ok({ items: COLUMNS, has_more: false }));
    const result = await gateway.parse(LINK + '&view=viewNotMaterial', FILES);
    expect(result).toMatchObject({ tableName: '试验台账', sourceUrl: LINK, title: '高压配电手册', code: 'GL-2026-038' });
    expect(result).toMatchObject({
      codeFieldKey: 'fldCode', attachmentField: { key: 'fldFiles', name: '附件' },
      batchField: { key: 'fldBatch', name: '发布批次ID' }, schemaVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(result.fields).toEqual([
      { key: 'fldName', name: '资料名称', value: '高压配电手册', maxLength: 180, required: true },
      { key: 'fldCode', name: '文件编号', value: 'GL-2026-038', maxLength: 180 },
      { key: 'fldNote', name: '备注', value: expect.stringContaining('巡检表.xlsx'), maxLength: 2000 },
      { key: 'fldCustom', name: '专业分类', value: '', maxLength: 2000 },
    ]);
    expect(http.get).toHaveBeenCalledWith(FIELD_URL, expect.objectContaining({ maxRedirects: 0 }));
    expect(http.post).not.toHaveBeenCalled();
  });

  it('only inspects exact allowed table targets and resolves Wiki nodes through Feishu', async () => {
    await expect(gateway.parse(LINK.replace('enterprise.feishu.cn', 'enterprise.feishu.cn.invalid'), FILES)).rejects.toThrow('飞书多维表链接');
    await expect(gateway.parse(LINK.replace('tblFileFixture', 'tblNotAllowed'), FILES)).rejects.toThrow('尚未配置');
    expect(http.get).not.toHaveBeenCalled();
    http.get.mockResolvedValueOnce(ok({ node: { obj_type: 'bitable', obj_token: 'appFileFixture' } }));
    http.get.mockResolvedValueOnce(ok({ items: COLUMNS, has_more: false }));
    expect(await gateway.parse(WIKI, [])).toMatchObject({ tableName: '知识库台账', title: '' });
    expect(http.get).toHaveBeenNthCalledWith(1, `${API}/wiki/v2/spaces/get_node`, expect.objectContaining({
      maxRedirects: 0, params: { token: 'wikiFileFixture' },
    }));
    expect(http.get).toHaveBeenNthCalledWith(2, FIELD_URL, expect.any(Object));
  });

  it('prepares both attachments, writes one record and reads back a lost acknowledgment by the original UUID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-publication-gateway-owned-'));
    try {
      const files = await Promise.all(FILES.map(async (file, index) => {
        const path = join(root, `fixture-${index}`);
        await writeFile(path, Buffer.alloc(file.size));
        return { ...file, path };
      }));
      http.get.mockResolvedValue(ok({ items: COLUMNS, has_more: false }));
      const preview = await gateway.parse(LINK, files);
      http.get.mockResolvedValueOnce(ok({ items: COLUMNS.map(column =>
        column.field_id === 'fldFiles' ? { ...column, field_name: '上传文件' } : column), has_more: false }));
      await expect(gateway.prepareBatch({
        batchId: UUID, link: LINK, files, metadata: {}, schemaVersion: preview.schemaVersion,
      })).rejects.toThrow('多维表写入字段已变化');
      await expect(gateway.prepareBatch({ batchId: UUID, link: LINK, files, metadata: { fldBatch: 'forged' } })).rejects.toThrow('资料字段');
      expect(http.post).not.toHaveBeenCalled();
      http.post.mockResolvedValueOnce(ok({ file_token: 'box_first' }));
      http.post.mockResolvedValueOnce(ok({ file_token: 'box_second' }));
      const prepared = await gateway.prepareBatch({
        batchId: UUID, link: LINK, files, metadata: { fldName: '编辑后的标题', fldCustom: '电气' }, schemaVersion: preview.schemaVersion,
      });
      expect(prepared.fields).toMatchObject({
        资料名称: '编辑后的标题', 文件编号: 'GL-2026-038', 专业分类: '电气', 发布批次ID: UUID,
        附件: [{ file_token: 'box_first' }, { file_token: 'box_second' }],
      });
      expect(http.post.mock.calls.map(([url]) => url)).toEqual([
        `${API}/drive/v1/medias/upload_all`, `${API}/drive/v1/medias/upload_all`,
      ]);
      http.post.mockRejectedValueOnce(new Error('lost acknowledgment fixture'));
      http.post.mockResolvedValueOnce(ok({ items: [{
        record_id: 'recFixture',
        fields: { ...prepared.fields, 发布批次ID: [{ text: UUID }] },
      }], has_more: false }));
      await expect(gateway.commitBatch(prepared, UUID)).resolves.toBe('recFixture');
      expect(http.post.mock.calls.filter(([url]) => url === RECORD_URL)).toEqual([[
        RECORD_URL, { fields: prepared.fields },
        expect.objectContaining({ params: { client_token: UUID, ignore_consistency_check: false } }),
      ]]);
      expect(http.post.mock.calls.at(-1)?.[0]).toBe(`${RECORD_URL}/search`);
    } finally {
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('file-publication-gateway-owned-')) throw Error('Unsafe test cleanup');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds a single aggregate card per registered group with a stable send UUID and no public token', async () => {
    const group = { id: 'oc_allowed', name: '试验群' };
    const batch = { id: UUID, title: '测试批次', code: 'GL-2026-038', files: FILES };
    await expect(gateway.notifyRecipient(batch, { ...group, id: 'oc_not_allowed' })).rejects.toThrow('允许名单');
    expect(http.post).not.toHaveBeenCalled();
    http.post.mockResolvedValue(ok({ message_id: 'om_summary' }));
    await expect(gateway.notifyRecipient(batch, group)).resolves.toBe('om_summary');
    expect(http.post).toHaveBeenCalledTimes(1);
    const [, original, config] = http.post.mock.calls[0];
    expect(config.params).toEqual({ receive_id_type: 'chat_id' });
    expect(original).toMatchObject({ receive_id: group.id, msg_type: 'interactive' });
    expect(original.content).toContain(FILES[0].name);
    expect(original.content).toContain(FILES[1].name);
    expect(original.content).toContain(`https://portal.example.test:3001/file-publication?batch=${UUID}`);
    await gateway.notifyRecipient(batch, group);
    expect(http.post.mock.calls[1][1]).toEqual(original);
  });

  it('distinguishes a known Feishu rejection from an ambiguous notification receipt', async () => {
    const group = { id: 'oc_allowed', name: '试验群' };
    const batch = { id: UUID, title: '测试批次', code: 'GL-2026-038', files: FILES };
    http.post.mockRejectedValueOnce({ response: { data: { code: 230002 } } })
      .mockResolvedValueOnce({ data: { code: 230049 } });
    await expect(gateway.notifyRecipient(batch, group)).rejects.toBeInstanceOf(FilePublicationDeliveryRejected);
    await expect(gateway.notifyRecipient(batch, group)).rejects.toThrow('结果待核对');
    expect(http.post.mock.calls[0][1].uuid).toBe(http.post.mock.calls[1][1].uuid);
  });

  it('resolves a named person and a chat without sending, then uses the proper Feishu target type', async () => {
    const roster = [
      { name: '测试甲', openId: 'ou_person_one' },
      { name: '同名人员', openId: 'ou_person_two' },
      { name: '同名人员', openId: 'ou_person_three' },
      { name: '未绑定', openId: '' },
    ];
    (readCachedActivePersonnel as jest.Mock).mockResolvedValue({ selectablePersonnel: roster, snapshot: { stale: false } });
    http.get.mockResolvedValueOnce(ok({ name: '测试工作群', chat_mode: 'group' }));
    const result = await gateway.resolveManualRecipients(['测试甲', 'oc_manual', 'ou_person_two', 'oc_allowed']);
    expect(result).toEqual([
      { id: 'ou_person_one', name: '测试甲', kind: 'person' },
      { id: 'oc_manual', name: '测试工作群', kind: 'group' },
      { id: 'ou_person_two', name: '同名人员', kind: 'person' },
      { id: 'oc_allowed', name: '试验群' },
    ]);
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.get).toHaveBeenCalledWith(`${API}/im/v1/chats/oc_manual`, expect.any(Object));
    await expect(gateway.resolveManualRecipients(['同名人员'])).rejects.toThrow('重名');
    await expect(gateway.resolveManualRecipients(['未绑定'])).rejects.toThrow('尚未绑定');
    await expect(gateway.resolveManualRecipients(['ou_unknown'])).rejects.toThrow('未找到通知人员');
    http.get.mockResolvedValueOnce(ok({ name: '测试单聊', chat_mode: 'p2p' }));
    await expect(gateway.resolveManualRecipients(['oc_private'])).rejects.toThrow('无法核对群');
    expect(http.post).not.toHaveBeenCalled();
    http.post.mockResolvedValue(ok({ message_id: 'om_summary' }));
    const batch = { id: UUID, title: '测试批次', code: 'GL-2026-038', files: FILES };
    await gateway.notifyRecipient(batch, result[0]);
    await gateway.notifyRecipient(batch, result[1]);
    expect(http.post.mock.calls.map(([, body, config]) => [body.receive_id, config.params.receive_id_type])).toEqual([
      ['ou_person_one', 'open_id'], ['oc_manual', 'chat_id'],
    ]);
  });
});
