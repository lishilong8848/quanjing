import {
  ThresholdAdjustmentGateway,
  THRESHOLD_APPROVAL_FIELDS,
} from '../../server/modules/threshold-management/threshold-adjustment.gateway';
import { fetchBitableRecords } from '../../server/common/feishu/bitable-direct-read';
import * as config from '../../server/common/config/external-services.config';
import type { ThresholdAdjustmentEntry } from '../../server/modules/threshold-management/threshold-adjustment.store';
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  getTenantAccessToken: jest.fn(async () => 'qa-no-credential'),
  fetchBitableRecords: jest.fn(),
  invalidateBitableRecordCache: jest.fn(),
}));
function entry(): ThresholdAdjustmentEntry {
  const person = { openId: 'ou_qa_engineer', name: '验收工程师' };
  return {
    fingerprint: 'a'.repeat(64),
    actorId: 'qa-account',
    cloudRevision: 0,
    messages: [],
    attempts: 0,
    adjustment: {
      id: 'ta-00000000-0000-4000-8000-000000000001',
      revision: 1,
      policyVersion: 'threshold-dual-approval-v1',
      clientMutationId: 'threshold-qa-00000001',
      applicant: person,
      engineer: person,
      managers: [{ openId: 'ou_qa_manager', name: '验收经理' }],
      before: {
        id: 'qa-threshold',
        profession: '电气',
        building: 'A楼',
        device: 'UPS',
        section: '延时',
        parameter: '自复延时',
        location: 'A-120',
        value: '/',
        unit: 'S',
        kind: '设定',
        enabled: '',
        note: '',
        version: 1,
        updatedAt: '',
      },
      value: '单路失电180S\n双路失电600S',
      reason: '阈值验收',
      plannedAt: '2026-10-09T04:00:00Z',
      submittedAt: '2026-10-09T03:00:00Z',
      state: 'routing',
      syncState: 'pending',
      stages: [
        {
          role: 'building',
          approver: { openId: 'ou_qa_building', name: '验收楼长' },
        },
        {
          role: 'professional',
          approver: { openId: 'ou_qa_professional', name: '验收示例人员001' },
        },
      ],
    },
  };
}
describe('阈值审批多维表类型适配与恢复', () => {
  let gateway: ThresholdAdjustmentGateway,
    request: jest.Mock,
    fields: Record<string, unknown>,
    records: unknown[];
  beforeEach(() => {
    jest
      .spyOn(config, 'getFeishuAuthPayload')
      .mockReturnValue({ app_id: 'qa-app', app_secret: 'qa-synthetic-only' });
    fields = {};
    records = [];
    (fetchBitableRecords as jest.Mock).mockImplementation(async () => records);
    request = jest.fn(async (input) => {
      if (input.url.endsWith('/fields'))
        return {
          data: {
            code: 0,
            data: {
              items: Object.entries(THRESHOLD_APPROVAL_FIELDS).map(
                ([field_name, type]) => ({ field_name, type }),
              ),
            },
          },
        };
      if (input.method === 'post' || input.method === 'put') {
        fields = structuredClone(input.data.fields);
        records = [{ record_id: 'rec_qa', fields }];
        return { data: { code: 0, data: { record: { record_id: 'rec_qa' } } } };
      }
      const normalized = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key,
          Array.isArray(value)
            ? value.map((v) =>
                typeof v === 'string' ? v : { ...v, name: '人员显示名称' },
              )
            : typeof value === 'string'
              ? [{ type: 'text', text: value }]
              : value,
        ]),
      );
      return { data: { code: 0, data: { record: { fields: normalized } } } };
    });
    gateway = new ThresholdAdjustmentGateway({
      axiosRef: { request },
    } as never);
  });
  afterEach(() => jest.restoreAllMocks());
  test('人员按Open ID、日期按时间戳回读；斜杠、多行和计划时间原样同步', async () => {
    const e = entry();
    expect(await gateway.sync(e)).toBe('rec_qa');
    expect(fields['原阈值']).toBe('/');
    expect(fields['申请阈值']).toBe('单路失电180S\n双路失电600S');
    expect(fields['计划进行时间']).toBe(Date.parse(e.adjustment.plannedAt));
    expect(fields['调整人']).toEqual([{ id: 'ou_qa_engineer' }]);
    expect(fields['文本']).toContain('自复延时');
    const restored = await gateway.recover();
    expect(
      (fetchBitableRecords as jest.Mock).mock.calls.at(-1)?.[1].filter
        .conditions[0].value,
    ).toEqual([]);
    expect(restored[0].adjustment).toEqual(e.adjustment);
    expect(restored[0].cloudRecordId).toBe('rec_qa');
  });
  test('丢失本地记录ID后按程序申请编号恢复，不重复创建；篡改快照停止恢复', async () => {
    const e = entry();
    await gateway.sync(e);
    await gateway.sync(e);
    expect(
      request.mock.calls.filter(
        (c) => c[0].method === 'post' && c[0].url.endsWith('/records'),
      ),
    ).toHaveLength(1);
    const signed = JSON.parse(fields['阈值审批快照'] as string);
    signed.entry.adjustment.value = '999';
    fields['阈值审批快照'] = JSON.stringify(signed);
    await expect(gateway.recover()).rejects.toThrow('签名');
  });
  test('写入返回成功但字段回读不符，不能报告同步成功', async () => {
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async (input) => {
      const result = await normal(input);
      if (input.method === 'get' && input.url.includes('/records/'))
        result.data.data.record.fields['申请阈值'] = [{ text: '被改写' }];
      return result;
    });
    await expect(gateway.sync(entry())).rejects.toThrow('回读未确认');
  });
  test('字段类型漂移停止写入，防止把姓名字符串当作人员关联', async () => {
    request.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: Object.entries(THRESHOLD_APPROVAL_FIELDS).map(
            ([field_name, type]) => ({
              field_name,
              type: field_name === '申请人' ? 1 : type,
            }),
          ),
        },
      },
    });
    await expect(gateway.sync(entry())).rejects.toThrow('类型不匹配');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
