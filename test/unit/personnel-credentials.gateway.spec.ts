import { createHash, pbkdf2Sync } from 'node:crypto';
import { PersonnelCredentialsGateway } from '../../server/common/access/personnel-credentials.gateway';
import { getFeishuAuthPayload } from '../../server/common/config/external-services.config';
import { readEmployeeOnboardingConfig } from '../../server/modules/bitable-sync/employee-onboarding.config';

jest.mock('../../server/common/config/external-services.config', () => ({ getFeishuAuthPayload: jest.fn() }));
jest.mock('../../server/modules/bitable-sync/employee-onboarding.config', () => ({ readEmployeeOnboardingConfig: jest.fn() }));
const IDENTITY = '11010519491231002X';
const source = { appToken: 'bascnTestSource0001', wikiToken: '', tableId: 'tblSource1', tableName: '员工信息池（全量）' };

describe('personnel credential source gateway (no real HTTP)', () => {
  let gateway: PersonnelCredentialsGateway, http: any, metadata: any[], views: any[], items: any[];
  let previousView: string | undefined;
  const ok = (data: unknown) => ({ data: { code: 0, data } });
  beforeEach(() => {
    previousView = process.env.FEISHU_ORG_VIEW_ID;
    process.env.FEISHU_ORG_VIEW_ID = 'vewActive1';
    (getFeishuAuthPayload as jest.Mock).mockReturnValue({ app_id: 'cliTest', app_secret: 'mock-secret' });
    (readEmployeeOnboardingConfig as jest.Mock).mockReturnValue(source);
    metadata = ['姓名', '身份证号', '密码'].map(field_name => ({ field_name, type: 1 })).concat([{ field_name: '离职/异动情况', type: 7 }]);
    views = [{ view_id: 'vewActive1' }];
    items = [{ record_id: 'recPerson1', fields: { 姓名: '测试人员', 身份证号: IDENTITY, 密码: '', '离职/异动情况': false } }];
    http = { axiosRef: {
      post: jest.fn(async (url) => url.includes('/auth/') ? { data: { code: 0, tenant_access_token: 'mock-only-token' } } : ok({ items, has_more: false })),
      get: jest.fn(async (url) => {
        if (url.endsWith('/fields')) return ok({ items: metadata, has_more: false });
        if (url.endsWith('/views')) return ok({ items: views, has_more: false });
        if (url.includes('/wiki/')) return ok({ node: { obj_type: 'bitable', obj_token: source.appToken } });
        return ok({ record: items[0] });
      }), put: jest.fn(async () => ok({})),
    } };
    gateway = new PersonnelCredentialsGateway(http);
  });
  afterEach(() => {
    if (previousView === undefined) delete process.env.FEISHU_ORG_VIEW_ID;
    else process.env.FEISHU_ORG_VIEW_ID = previousView;
  });

  it('uses the onboarding source, active view, strict name match and stable record identity', async () => {
    const record = await gateway.findActive('测试人员');
    expect(readEmployeeOnboardingConfig).toHaveBeenCalled();
    expect(record?.accountId).toBe('local-external-' + createHash('sha256').update(JSON.stringify(['cliTest', source.appToken, source.tableId, 'recPerson1'])).digest('hex'));
    expect(http.axiosRef.post.mock.calls[1][1]).toMatchObject({ view_id: 'vewActive1',
      filter: { conjunction: 'and', conditions: [{ field_name: '姓名', operator: 'is', value: ['测试人员'] }] } });
  });

  it('resolves wiki source tokens before field and record reads', async () => {
    (readEmployeeOnboardingConfig as jest.Mock).mockReturnValue({ ...source, appToken: '', wikiToken: 'wikiSourceToken001' });
    expect((await gateway.findActive('测试人员'))?.appToken).toBe(source.appToken);
    expect(http.axiosRef.get.mock.calls[0][0]).toContain('/wiki/v2/spaces/get_node');
  });

  it('rejects duplicate names rather than choosing a record', async () => {
    items.push({ ...items[0], record_id: 'recAnother' });
    expect(await gateway.findActive('测试人员')).toBeNull();
  });

  it('rejects incomplete search pagination rather than assuming uniqueness', async () => {
    http.axiosRef.post.mockImplementation(async url => url.includes('/auth/') ? { data: { code: 0, tenant_access_token: 'mock' } } : ok({ items, has_more: true, page_token: 'next' }));
    expect(await gateway.findActive('测试人员')).toBeNull();
  });

  it.each([true, null, 'unknown'])('rejects inactive or unknown checkbox state (%j)', async value => {
    items[0].fields['离职/异动情况'] = value;
    expect(await gateway.findActive('测试人员')).toBeNull();
  });

  it('allows omitted unchecked values only after verifying checkbox metadata', async () => {
    delete items[0].fields['离职/异动情况'];
    expect(await gateway.findActive('测试人员')).not.toBeNull();
    metadata.find(item => item.field_name === '离职/异动情况').type = 1;
    await expect(gateway.findActive('测试人员')).rejects.toThrow('人员资料核验');
  });

  it('rejects mismatched names and missing active views', async () => {
    items[0].fields.姓名 = '另一人员';
    expect(await gateway.findActive('测试人员')).toBeNull();
    views.length = 0;
    await expect(gateway.findActive('测试人员')).rejects.toThrow('人员资料核验');
  });

  it('writes only the password field using a valid hash, then fresh GETs the record', async () => {
    const record = (await gateway.findActive('测试人员'))!;
    const salt = Buffer.alloc(16, 7);
    const hash = `pbkdf2_sha256$600000$${salt.toString('base64')}$${pbkdf2Sync('new password', salt, 600000, 32, 'sha256').toString('base64')}`;
    await gateway.writePassword(record, hash);
    expect(http.axiosRef.put).toHaveBeenCalledWith(expect.stringContaining('/records/recPerson1'), { fields: { 密码: hash } }, expect.any(Object));
    items[0].fields.密码 = hash;
    expect((await gateway.fresh(record)).password).toBe(hash);
    expect(http.axiosRef.get.mock.calls.at(-1)[1].headers['Cache-Control']).toBe('no-cache');
    await expect(gateway.writePassword(record, 'raw-password')).rejects.toThrow('人员资料核验');
    expect(http.axiosRef.put).toHaveBeenCalledTimes(1);
  });

  it('rejects identity or employment changes during fresh read-back', async () => {
    const record = (await gateway.findActive('测试人员'))!;
    items[0].fields.身份证号 = 'changed';
    await expect(gateway.fresh(record)).rejects.toThrow('人员资料核验');
    items[0].fields.身份证号 = IDENTITY;
    items[0].fields['离职/异动情况'] = true;
    await expect(gateway.fresh(record)).rejects.toThrow('人员资料核验');
  });

  it('never leaks upstream HTTP messages, request config or response data', async () => {
    http.axiosRef.post.mockRejectedValue({ message: 'identity-and-password-secret', config: { data: 'sensitive' }, response: { data: IDENTITY } });
    const error = await gateway.findActive('测试人员').catch(error => error);
    expect(error.message).toBe('人员资料核验暂不可用，请稍后重试');
    expect(error.config).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(IDENTITY);
    expect(JSON.stringify(error)).not.toContain('sensitive');
  });

  it('applies a total source-read deadline and aborts its outstanding HTTP work', async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      http.axiosRef.post.mockImplementation((_url, _body, options) => {
        signal = options.signal;
        return new Promise(() => undefined);
      });
      const result = gateway.findActive('测试人员').catch(error => error);
      await jest.advanceTimersByTimeAsync(20_001);
      expect((await result).message).toBe('人员资料核验暂不可用，请稍后重试');
      expect(signal?.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});
