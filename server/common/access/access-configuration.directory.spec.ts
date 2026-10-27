import { HttpService } from '@nestjs/axios';
import { AccessConfigurationDirectory } from './access-configuration.directory';
import { fetchBitableRecords, getTenantAccessToken, resolveBitableAppToken } from '../feishu/bitable-direct-read';
jest.mock('./external-employee-directory', () => ({ readExternalEmployeeCredentials: jest.fn().mockResolvedValue([]) }));
jest.mock('../feishu/bitable-direct-read', () => ({ ...jest.requireActual('../feishu/bitable-direct-read'), fetchBitableRecords: jest.fn(), getTenantAccessToken: jest.fn(), resolveBitableAppToken: jest.fn() }));

describe('application personnel directory', () => {
  const saved = { ...process.env };
  const http = () => {
    const service = new HttpService();
    jest.spyOn(service.axiosRef, 'get').mockResolvedValue({ data: { code: 0, data: { items: ['姓名', '员工姓名', '飞书 open_id', '离职/异动情况'].map(field_name => ({ field_name })), has_more: false } } });
    return service;
  };
  beforeEach(() => { jest.clearAllMocks(); process.env.FEISHU_APP_ID = 'cli_directory_fixture'; (resolveBitableAppToken as jest.Mock).mockResolvedValue('fixture-token'); });
  afterEach(() => { process.env = { ...saved }; });
  it('uses stable personnel IDs, excludes inactive/invalid/duplicate identities and reuses the local cache', async () => {
    const records = [
      { record_id: 'rec_active', fields: { 姓名: '人员甲', 员工姓名: [{ id: 'ou_active', name: '人员甲' }] } },
      { record_id: 'rec_duplicate', fields: { 姓名: '人员甲重复', 员工姓名: [{ id: 'ou_active' }] } },
      { record_id: 'rec_inactive', fields: { 姓名: '离职人员', 员工姓名: [{ id: 'ou_inactive' }], '离职/异动情况': '已离职' } },
      { record_id: 'rec_name_only', fields: { 姓名: '无稳定身份' } },
    ];
    (fetchBitableRecords as jest.Mock).mockImplementation(async (_http, options) => options.viewId ? records.filter(record => record.record_id !== 'rec_duplicate') : records);
    const directory = new AccessConfigurationDirectory(http());
    expect((await directory.read()).people).toEqual([{ openId: 'ou_active', name: '人员甲' }]);
    await directory.read();
    expect(fetchBitableRecords).toHaveBeenCalledTimes(2);
    expect(fetchBitableRecords).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fieldNames: expect.arrayContaining(['离职/异动情况']), strict: true, allowStale: false }));
    await expect(directory.assertKnown(['ou_unknown'], new Set())).rejects.toThrow('未在当前应用人员目录中匹配');
  });
  it('does not use name matching as authorization and does not query approved current-application identities again', async () => {
    const directory = new AccessConfigurationDirectory(http());
    await directory.assertKnown(['ou_known'], new Set(['ou_known']));
    expect(fetchBitableRecords).not.toHaveBeenCalled();
    (fetchBitableRecords as jest.Mock).mockResolvedValue([{ record_id: 'rec_name', fields: { 姓名: 'ou_unknown' } }]);
    await expect(directory.assertKnown(['ou_unknown'], new Set())).rejects.toThrow('未在当前应用人员目录中匹配');
  });
  it('requests only existing identity fields, never missing aliases or private columns', async () => {
    const service = http();
    (service.axiosRef.get as jest.Mock).mockResolvedValue({ data: { code: 0, data: { items: ['姓名','飞书 open_id','身份证号'].map(field_name => ({ field_name })), has_more: false } } });
    (fetchBitableRecords as jest.Mock).mockResolvedValue([{ record_id: 'recExplicit', fields: { 姓名: '人员甲', '飞书 open_id': [{ text: 'ou_explicit' }] } }]);
    expect((await new AccessConfigurationDirectory(service).read()).people).toEqual([{ name: '人员甲', openId: 'ou_explicit' }]);
    expect(fetchBitableRecords).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fieldNames: ['姓名','飞书 open_id'] }));
  });
  it('releases failed requests so retry can recover without caching failure', async () => {
    const service = http();
    (service.axiosRef.get as jest.Mock).mockRejectedValueOnce(new Error('temporary schema failure'));
    (fetchBitableRecords as jest.Mock).mockResolvedValue([]);
    const directory = new AccessConfigurationDirectory(service);
    await expect(directory.read()).rejects.toThrow('temporary schema failure');
    await expect(directory.read()).resolves.toMatchObject({ people: [] });
  });
  it('isolates shared Feishu associations while keeping record-based name-account eligibility', async () => {
    const records = [
      { record_id: 'recOne', fields: { 姓名: '人员甲', '飞书 open_id': 'ou_shared' } },
      { record_id: 'recTwo', fields: { 姓名: '人员乙', '飞书 open_id': 'ou_shared' } },
      { record_id: 'recThree', fields: { 姓名: '人员丙', '飞书 open_id': 'ou_unique' } },
      { record_id: 'recFour', fields: { 姓名: '姓名账号人员' } },
    ];
    (fetchBitableRecords as jest.Mock).mockResolvedValue(records);
    const result = await new AccessConfigurationDirectory(http()).read();
    expect(result.activeMembers).toHaveLength(4);
    expect(result.activeMembers?.filter(person => person.openId)).toEqual([expect.objectContaining({ name: '人员丙', openId: 'ou_unique' })]);
    expect(result.activeMembers?.every(person => /^local-external-[a-f0-9]{64}$/.test(person.passwordAccountId))).toBe(true);
    expect(result.people).not.toEqual(expect.arrayContaining([expect.objectContaining({ openId: 'ou_shared' })]));
    expect(result.personnelWarnings).toEqual(expect.arrayContaining([expect.stringContaining('2 名人员'),expect.stringContaining('身份重复')]));
  });
  it('keeps valid employees eligible when an empty or unnamed row is present', async () => {
    (fetchBitableRecords as jest.Mock).mockResolvedValue([
      { record_id: 'recValid', fields: { 姓名: '正常人员', 员工姓名: [{ id: 'ou_valid', name: '正常人员' }] } },
      { record_id: 'recEmpty', fields: {} },
      { record_id: 'recUnnamed', fields: { '飞书 open_id': 'ou_unnamed' } },
    ]);
    const result = await new AccessConfigurationDirectory(http()).read();
    expect(result.activeMembers).toEqual([expect.objectContaining({ name: '正常人员', openId: 'ou_valid' })]);
    expect(result.personnelWarnings?.join('')).toContain('姓名');
  });
  it('does not authorize mismatching explicit and associated Feishu identities', async () => {
    (fetchBitableRecords as jest.Mock).mockResolvedValue([{ record_id: 'recMismatch', fields: { 姓名: '关联待核对', '飞书 open_id': 'ou_explicit', 员工姓名: [{ id: 'ou_different', name: '关联待核对' }] } }]);
    const result = await new AccessConfigurationDirectory(http()).read();
    expect(result.activeMembers).toEqual([expect.objectContaining({ name: '关联待核对', passwordAccountId: expect.any(String) })]);
    expect(result.activeMembers?.[0].openId).toBeUndefined();
    expect(result.personnelWarnings?.join('')).toContain('飞书');
  });
  it('includes organizational duty accounts and deduplicates stable identities without granting roles', async () => {
    const service = http();
    (service.axiosRef.get as jest.Mock).mockImplementation(async (url: string) => ({ data: { code: 0, data: { has_more: false, items: url.endsWith('/tables')
      ? [{ table_id: 'tbl_organization', name: '01-3 组织架构' }]
      : url.includes('tbl_organization') ? [{ field_name: '值班账号', type: 11 }, { field_name: '库房管理员', type: 11 }, { field_name: '主管（文本）', type: 20 }]
      : [{ field_name: '姓名' }, { field_name: '员工姓名' }] } } }));
    (fetchBitableRecords as jest.Mock).mockImplementation(async (_http, options) => options.tableId === 'tbl_organization'
      ? [{ fields: { 值班账号: [{ id: 'ou_duty', name: '合成楼栋值班' }, { id: 'ou_staff', name: '人员别名' }], 库房管理员: [{ id: 'ou_duty', name: '合成楼栋值班' }] } }]
      : [{ record_id: 'recStaff', fields: { 姓名: '人员甲', 员工姓名: [{ id: 'ou_staff', name: '人员甲' }] } }]);
    const people = (await new AccessConfigurationDirectory(service).read()).people;
    expect(people).toEqual(expect.arrayContaining([{ openId: 'ou_staff', name: '人员甲' }, { openId: 'ou_duty', name: '合成楼栋值班' }]));
    expect(people).toHaveLength(2);
    expect(fetchBitableRecords).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ fieldNames: ['值班账号','库房管理员'], strict: true }));
  });
});
