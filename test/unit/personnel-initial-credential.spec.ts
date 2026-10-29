import { buildExternalEmployeeCredentials, readExternalEmployeeCredentials } from '../../server/common/access/external-employee-directory';
import { matchesAccessPassword } from '../../server/common/access/access-password';
import type { BitableRecordItem } from '../../server/common/feishu/bitable-direct-read';

// Synthetic identity only; generate its check digit rather than using personnel data.
const prefix = '11010119900101000';
const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const identity = prefix + '10X98765432'[[...prefix].reduce((sum, digit, index) => sum + Number(digit) * weights[index], 0) % 11];
const activeViewId = 'vewrQcypV4';
const externalViewId = 'vewSyntheticExternal';
const metadata = [
  { field_name: '姓名', type: 1 }, { field_name: '密码', type: 1 },
  { field_name: '离职/异动情况', type: 7 }, { field_name: '身份证号', type: 1 },
];
const views = [{ view_id: activeViewId, view_name: '在职人员' }, { view_id: externalViewId, view_name: '外部账号人员' }];
const row = (fields: Record<string, unknown> = {}, recordId = 'recSyntheticInitial'): BitableRecordItem => ({
  record_id: recordId, fields: { 姓名: '合成新员工', 密码: '', 身份证号: identity, '离职/异动情况': false, ...fields },
});
const build = (records: BitableRecordItem[]) => buildExternalEmployeeCredentials(records, 'cli_synthetic', 'syntheticBase', 'tblSynthetic');

describe('在职新人初始姓名凭据', () => {
  const prior = { ...process.env };
  beforeEach(() => {
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 7).toString('base64');
    delete process.env.FEISHU_ORG_VIEW_ID;
    delete process.env.FEISHU_ORGANIZATION_VIEW_ID;
  });
  afterEach(() => { process.env = { ...prior }; });

  it('空密码在职人员以身份证后六位派生稳定散列，输出不包含身份证或初始密码', async () => {
    const [credential] = await build([row()]);
    expect(credential.active).toBe(true);
    expect(identity.slice(-6)).toMatch(/^0/);
    expect(await matchesAccessPassword(identity.slice(-6), credential.passwordHash!)).toBe(true);
    expect((await build([row()]))[0]).toEqual(credential);
    expect(Object.keys(credential).sort()).toEqual(['active', 'id', 'name', 'passwordHash']);
    expect(JSON.stringify(credential)).not.toContain(identity);
    expect(JSON.stringify(credential)).not.toContain(identity.slice(-6));
  });

  it.each([undefined, null, [], [{ text: '' }]])('确实为空的密码单元 %j 可以生成初始凭据', async password => {
    const [credential] = await build([row({ 密码: password })]);
    expect(credential.active).toBe(true);
    expect(await matchesAccessPassword(identity.slice(-6), credential.passwordHash!)).toBe(true);
  });

  it('已有明文密码优先，保留空格，不降级到身份证密码', async () => {
    const [credential] = await build([row({ 密码: [{ text: ' old ' }, { text: ' old ' }] })]);
    expect(await matchesAccessPassword(' old  old ', credential.passwordHash!)).toBe(true);
    expect(await matchesAccessPassword(identity.slice(-6), credential.passwordHash!)).toBe(false);
    const [spaces] = await build([row({ 密码: '  ' })]);
    expect(await matchesAccessPassword('  ', spaces.passwordHash!)).toBe(true);
    expect(await matchesAccessPassword(identity.slice(-6), spaces.passwordHash!)).toBe(false);
  });

  it('既有合法PBKDF2散列原样保留，身份证缺失不影响', async () => {
    const passwordHash = `pbkdf2_sha256$600000$${Buffer.alloc(16, 3).toString('base64')}$${Buffer.alloc(32, 4).toString('base64')}`;
    expect((await build([row({ 密码: passwordHash, 身份证号: undefined })]))[0]).toMatchObject({ active: true, passwordHash });
  });

  it.each(['pbkdf2_sha256$broken', 'unknown$encoded', 'a'.repeat(257), { text: 'malformed' }, [{ value: 'bad' }], 123])(
    '非空无效密码 %j 不得回退为身份证密码', async password => {
      const [credential] = await build([row({ 密码: password })]);
      expect(credential.active).toBe(false);
      expect(credential.passwordHash).toBeUndefined();
    },
  );

  it.each([undefined, null, '待确认', true, '已离职', {}])('状态 %j 不生成初始凭据', async status => {
    expect((await build([row({ '离职/异动情况': status })]))[0]).toMatchObject({ active: false });
  });

  it('既有显式凭据仍独立于离职授权处置，不在解析层改写原规则', async () => {
    const [credential] = await build([row({ 密码: 'synthetic-existing', '离职/异动情况': true })]);
    expect(credential.active).toBe(true);
    expect(await matchesAccessPassword('synthetic-existing', credential.passwordHash!)).toBe(true);
  });

  it.each([undefined, '', identity.slice(0, 17) + (identity.endsWith('0') ? '1' : '0'), 123456, { text: identity }])(
    '身份证缺失或无效时不给初始凭据', async invalid => {
      const [credential] = await build([row({ 身份证号: invalid })]);
      expect(credential.active).toBe(false);
      expect(credential.passwordHash).toBeUndefined();
    },
  );

  it('跨来源重名仍全部禁止姓名登录', async () => {
    const result = await build([row(), row({ 密码: 'synthetic-existing' }, 'recSyntheticOther')]);
    expect(result).toHaveLength(2);
    expect(result.every(credential => !credential.active)).toBe(true);
  });

  function source(active: BitableRecordItem[], external: BitableRecordItem[] = []) {
    const post = jest.fn(async (_url, body) => ({ data: { code: 0, data: {
      items: body.view_id === externalViewId ? external : active, has_more: false,
    } } }));
    const read = (fieldList = metadata, viewList = views) => readExternalEmployeeCredentials(
      { axiosRef: { post } } as never, 'cli_synthetic', 'syntheticBase', 'tblSynthetic', 'synthetic-token', fieldList, viewList,
    );
    return { post, read };
  }

  it('在职视图中新人不必进入外部账号视图；外部视图原密码同时保留', async () => {
    const { post, read } = source([row()], [row({ 姓名: '合成已有员工', 密码: 'synthetic-existing' }, 'recSyntheticExisting')]);
    const credentials = await read();
    expect(credentials).toHaveLength(2);
    expect(await matchesAccessPassword(identity.slice(-6), credentials[0].passwordHash!)).toBe(true);
    expect(await matchesAccessPassword('synthetic-existing', credentials[1].passwordHash!)).toBe(true);
    expect(post.mock.calls.map(call => call[1])).toEqual(views.map(view => ({
      view_id: view.view_id, field_names: ['姓名', '密码', '离职/异动情况', '身份证号'],
    })));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('外部视图单独出现的空密码人员不扩展为初始登录资格', async () => {
    expect(await source([], [row()]).read()).toEqual([expect.objectContaining({ active: false })]);
  });

  it('两视图同记录相同值只生成一个账号，可信checkbox省略代表未勾选', async () => {
    const result = await source([row({ '离职/异动情况': undefined })], [row()]).read();
    expect(result).toHaveLength(1);
    expect(result[0].active).toBe(true);
    expect(await matchesAccessPassword(identity.slice(-6), result[0].passwordHash!)).toBe(true);
  });

  it.each([
    { 姓名: '合成不同姓名' }, { 密码: 'synthetic-changed' }, { 身份证号: '' }, { '离职/异动情况': true },
  ])('同记录跨视图值不一致则整批失败，不按读取顺序选择凭据', async fields => {
    await expect(source([row()], [row(fields)]).read()).rejects.toThrow('外部员工资料读取失败');
    await expect(source([row(fields)], [row()]).read()).rejects.toThrow('外部员工资料读取失败');
  });

  it('初始密码所需任职状态未知时拒绝半批目录，不能推断为在职或离职', async () => {
    await expect(source([row({ '离职/异动情况': 'unknown' })]).read()).rejects.toThrow('外部员工资料读取失败');
  });

  it.each([metadata.filter(field => field.field_name !== '身份证号'), metadata.map(field => field.field_name === '身份证号' ? { ...field, type: 2 } : field)].map(fieldList => [fieldList]))(
    '身份证字段缺失或类型不可信不影响纯显式密码账号，但需要初始密码时拒绝半批目录', async fieldList => {
      const { post, read } = source([row({ 密码: 'synthetic-existing' })]);
      const credentials = await read(fieldList);
      expect(credentials[0].active).toBe(true);
      expect(await matchesAccessPassword('synthetic-existing', credentials[0].passwordHash!)).toBe(true);
      expect(post.mock.calls[0][1].field_names).not.toContain('身份证号');
      await expect(source([row(), row({ 姓名: '合成原账号', 密码: 'synthetic-existing' }, 'recSyntheticExisting')]).read(fieldList))
        .rejects.toThrow('外部员工资料读取失败');
    },
  );

  it('配置的在职视图优先于别名，缺省时使用别名', async () => {
    process.env.FEISHU_ORG_VIEW_ID = 'vewPrimary';
    process.env.FEISHU_ORGANIZATION_VIEW_ID = 'vewAlias';
    const { post, read } = source([row()]);
    const configuredViews = [...views, { view_id: 'vewPrimary', view_name: '在职主视图' }, { view_id: 'vewAlias', view_name: '在职别名视图' }];
    await read(metadata, configuredViews);
    expect(post.mock.calls[0][1].view_id).toBe('vewPrimary');
    delete process.env.FEISHU_ORG_VIEW_ID;
    post.mockClear();
    await read(metadata, configuredViews);
    expect(post.mock.calls[0][1].view_id).toBe('vewAlias');
  });

  it('任一视图缺失、外部视图重名或同视图重复记录都拒绝部分目录', async () => {
    await expect(source([row()]).read(metadata, views.slice(1))).rejects.toThrow('外部员工资料读取失败');
    await expect(source([row()]).read(metadata, views.slice(0, 1))).rejects.toThrow('外部员工资料读取失败');
    await expect(source([row()]).read(metadata, [...views, { view_id: 'vewOtherExternal', view_name: '外部账号人员' }])).rejects.toThrow('外部员工资料读取失败');
    await expect(source([row(), row()]).read()).rejects.toThrow('外部员工资料读取失败');
  });

  it('另一视图失败时不返回半批结果，错误不携带外部响应凭据', async () => {
    const { post, read } = source([row()]);
    post.mockImplementationOnce(async () => ({ data: { code: 0, data: { items: [row()], has_more: false } } }));
    post.mockRejectedValueOnce({ message: identity, response: { data: [row({ 密码: 'synthetic-sensitive' })] } } as never);
    const error = await read().catch(caught => caught);
    expect(error.message).toContain('外部员工资料读取失败');
    expect(JSON.stringify(error)).not.toMatch(new RegExp(`${identity}|synthetic-sensitive`));
  });
});
