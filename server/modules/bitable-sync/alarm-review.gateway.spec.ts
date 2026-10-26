import type { HttpService } from '@nestjs/axios';
import { AlarmReviewGateway } from './alarm-review.gateway';
import { reviewVersion } from './alarm-review.rules';
import * as direct from '../../common/feishu/bitable-direct-read';
import * as source from './today-operations-alarm.service';
import * as config from '../../common/config/external-services.config';

describe('alarm review gateway', () => {
  let gateway: AlarmReviewGateway;
  let fields: Record<string, unknown>;
  let put: jest.Mock;
  let get: jest.Mock;
  beforeEach(() => {
    jest.spyOn(direct, 'getTenantAccessToken').mockResolvedValue('test-token');
    jest.spyOn(direct, 'resolveBitableAppToken').mockResolvedValue('test-base');
    jest.spyOn(direct, 'invalidateBitableRecordCache').mockImplementation(() => {});
    fields = { 告警内容: '原告警', 处理状态: '已处理', 确认描述: '原确认', 恢复状态: '已恢复' };
    get = jest.fn(async (url: string) => ({ data: { code: 0, data: url.endsWith('/fields') ? {
      items: [{ field_name: '人工复核结果', type: 3, property: { options: ['人工复核无问题', '已通知现场跟进', '告警已闭环无法处理', '自定义回复'].map(name => ({ name })) } }, { field_name: '复核示例人员019', type: 11, property: { multiple: false } }, { field_name: '复核回复', type: 1 }], has_more: false,
    } : { record: { record_id: 'recABC', fields: { ...fields } } } } }));
    put = jest.fn(async (_url: string, body: { fields: Record<string, unknown> }) => {
      fields = { ...fields, ...body.fields, 复核示例人员019: [{ id: 'user123', name: '示例人员019' }] };
      return { data: { code: 0, data: { record: { record_id: 'recABC', fields } } } };
    });
    gateway = new AlarmReviewGateway({ axiosRef: { get, put } } as unknown as HttpService);
  });
  afterEach(() => jest.restoreAllMocks());
  it('writes only review fields and returns semantically verified data', async () => {
    const result = await gateway.syncRecord('recABC', '人工复核无问题', 'user123', 'unreviewed');
    expect(fields.确认描述).toBe('原确认');
    expect(fields.处理状态).toBe('已处理');
    expect(Object.keys(put.mock.calls[0][1].fields)).toEqual(['人工复核结果', '复核示例人员019', '复核回复']);
    expect(result.人工复核结果).toBe('人工复核无问题');
  });
  it('does not repeat the write after an indeterminate response when values already match', async () => {
    fields.人工复核结果 = '人工复核无问题'; fields.复核示例人员019 = [{ id: 'user123', name: '示例人员019' }];
    await gateway.syncRecord('recABC', '人工复核无问题', 'user123', 'unreviewed');
    expect(put).not.toHaveBeenCalled();
  });
  it('rejects a changed review instead of overwriting it', async () => {
    fields.人工复核结果 = '已通知现场跟进'; fields.复核示例人员019 = [{ id: 'other', name: '其他示例人员019' }];
    await expect(gateway.syncRecord('recABC', '人工复核无问题', 'user123', 'unreviewed')).rejects.toThrow('复核已变更');
    expect(put).not.toHaveBeenCalled();
  });
  it('allows an explicit update from the review displayed to the user', async () => {
    fields.人工复核结果 = '已通知现场跟进'; fields.复核示例人员019 = [{ id: 'other', name: '其他示例人员019' }];
    await gateway.syncRecord('recABC', '人工复核无问题', 'user123', reviewVersion(fields));
    expect(fields.人工复核结果).toBe('人工复核无问题');
  });
  it('refuses success when readback differs', async () => {
    put.mockResolvedValue({ data: { code: 0, data: { record: { record_id: 'recABC', fields: {} } } } });
    await expect(gateway.syncRecord('recABC', '人工复核无问题', 'user123', 'unreviewed')).rejects.toThrow('回读');
  });
  it('round-trips custom text and rejects a mismatched custom reply', async () => {
    await gateway.syncRecord('recABC', '自定义回复' as never, 'user123', 'unreviewed', '等待备件');
    expect(fields.复核回复).toBe('等待备件');
    put.mockImplementation(async () => ({ data: { code: 0 } }));
    await expect(gateway.syncRecord('recABC', '自定义回复' as never, 'user123', reviewVersion(fields), '已完成')).rejects.toThrow('回读');
  });
  it('requires a text reply field before any record write', async () => {
    get.mockResolvedValueOnce({ data: { code: 0, data: { items: [
      { field_name: '人工复核结果', type: 3, property: { options: ['人工复核无问题', '已通知现场跟进', '告警已闭环无法处理', '自定义回复'].map(name => ({ name })) } },
      { field_name: '复核示例人员019', type: 11, property: { multiple: false } },
      { field_name: '复核回复', type: 3 },
    ], has_more: false } } });
    await expect(gateway.preflight()).rejects.toThrow('字段未就绪');
    expect(put).not.toHaveBeenCalled();
  });
  it('reuses a directory Open ID only within the same application', async () => {
    jest.spyOn(config, 'getEffectiveFeishuAppCredentials').mockReturnValue({ appId: 'test-primary-app', appSecret: 'test-only' });
    jest.spyOn(source, 'resolveTodayOperationsAlarmAuth').mockReturnValue({ appId: 'test-primary-app', appSecret: 'test-only' });
    expect(await gateway.resolveResponsibleUserId('ou_123')).toBe('ou_123');
    expect(get).not.toHaveBeenCalled();
  });
  it('converts cross-application identities instead of carrying over Open IDs', async () => {
    jest.spyOn(config, 'getEffectiveFeishuAppCredentials').mockReturnValue({ appId: 'test-primary-app', appSecret: 'test-only' });
    jest.spyOn(source, 'resolveTodayOperationsAlarmAuth').mockReturnValue({ appId: 'test-other-app', appSecret: 'test-only' });
    get.mockResolvedValue({ data: { code: 0, data: { user: { user_id: 'tenantUser123' } } } });
    expect(await gateway.resolveResponsibleUserId('ou_123')).toBe('tenantUser123');
    get.mockResolvedValue({ data: { code: 999, data: {} } });
    await expect(gateway.resolveResponsibleUserId('ou_123')).rejects.toThrow('通讯录');
  });
});
