jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  getTenantAccessToken: jest.fn(),
  resolveBitableAppToken: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
}));
import {
  fetchBitableRecords,
  getTenantAccessToken,
  resolveBitableAppToken,
  readLatestPersistedBitableRecordSnapshot,
} from '../../server/common/feishu/bitable-direct-read';
import { MonthlyOperationsEventsService } from '../../server/modules/bitable-sync/monthly-operations-events.service';
import { HttpService } from '@nestjs/axios';
describe('事件只读接口边界', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-13'));
    jest.mocked(fetchBitableRecords).mockReset().mockResolvedValue([]);
    jest.mocked(getTenantAccessToken).mockReset().mockResolvedValue('tenant');
    jest
      .mocked(resolveBitableAppToken)
      .mockReset()
      .mockResolvedValue('test-base');
    jest
      .mocked(readLatestPersistedBitableRecordSnapshot)
      .mockReset()
      .mockResolvedValue(null);
  });
  afterEach(() => jest.useRealTimers());
  it('仅授权事件表白名单字段，不读取人员附件', async () => {
    const result = await new MonthlyOperationsEventsService(
      new HttpService(),
    ).getEvents('2026-09-01', '2026-09-30');
    expect(result.status).toBe('empty');
    const [primary, supplement] = jest
      .mocked(fetchBitableRecords)
      .mock.calls.map((call) => call[1]);
    expect(primary).toMatchObject({
      tableId: 'tblj9XJLq5QzTAqX',
      strict: true,
      allowStale: true,
      cacheTtlMs: 300000,
    });
    expect(supplement).toMatchObject({
      tableId: 'tbl07kaaLGodiTqQ',
      viewId: 'vewtj0ZiJJ',
      strict: true,
      allowStale: true,
      cacheTtlMs: 300000,
    });
    expect(primary.fieldNames).not.toContain('创建人');
    expect(primary.fieldNames).not.toContain('附件');
    expect(supplement.fieldNames).toEqual(
      expect.arrayContaining(['需回溯', '1-回溯报告', '2-回溯报告']),
    );
  });
  it('普通过期快照立即返回并标记后台更新；手动刷新等待真实读取', async () => {
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue({
      fetchedAt: Date.now() - 3600000,
      records: [],
    } as never);
    const service = new MonthlyOperationsEventsService(new HttpService());
    expect(await service.getEvents('2026-09-01', '2026-09-30')).toMatchObject({
      status: 'stale',
      message: '后台更新中',
    });
    await service.getEvents('2026-09-01', '2026-09-30', true);
    expect(
      jest
        .mocked(fetchBitableRecords)
        .mock.calls.slice(-2)
        .map((call) => call[1]),
    ).toEqual([
      expect.objectContaining({ forceRefresh: true, allowStale: false }),
      expect.objectContaining({ forceRefresh: true, allowStale: false }),
    ]);
  });
  it('无效范围联网前拒绝，超时返回可重试错误', async () => {
    const service = new MonthlyOperationsEventsService(new HttpService());
    await expect(
      service.getEvents('2026-10-01', '2026-09-30'),
    ).rejects.toThrow();
    expect(resolveBitableAppToken).not.toHaveBeenCalled();
    jest
      .mocked(resolveBitableAppToken)
      .mockImplementation(() => new Promise(() => {}));
    const task = service.getEvents('2026-09-01', '2026-09-30');
    await jest.advanceTimersByTimeAsync(35001);
    expect((await task).status).toBe('error');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('只按事件内已登记报告读取飞书正文，文件型报告返回明确降级状态', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockImplementation(async (_http, options) =>
        options.tableId === 'tblj9XJLq5QzTAqX'
          ? [
              {
                record_id: 'primary',
                fields: {
                  事件编号: 'SJ260413-101',
                  事件发生时间: Date.parse('2026-04-13T21:20:00+08:00'),
                  告警描述: '方舟平台温度异常',
                },
              },
            ]
          : [
              {
                record_id: 'supplement',
                fields: {
                  事件编号: 'SJ260413-101',
                  事件发生时间: Date.parse('2026-04-13T21:20:00+08:00'),
                  告警描述: '方舟平台温度异常',
                  '1-回溯报告': {
                    link: 'https://vnet.feishu.cn/wiki/P2klwb3Y0i8M4gk5kl7cYQ8nnbe',
                    text: '温度异常复盘',
                  },
                  '2-回溯报告': {
                    link: 'https://vnet.feishu.cn/file/Ii4RbU6WGopA6GxLUPXclODln5c',
                    text: '附件复盘.docx',
                  },
                },
              },
            ],
      );
    const get = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: { node: { obj_type: 'docx', obj_token: 'doc-token' } },
        },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { content: '事件经过\n原因分析\n整改措施' } },
      });
    const service = new MonthlyOperationsEventsService({
      axiosRef: { get },
    } as unknown as HttpService);

    await expect(service.getEventReviewReport('primary', 0)).resolves.toEqual({
      title: '温度异常复盘',
      kind: 'document',
      content: '事件经过\n原因分析\n整改措施',
      message: '',
    });
    await expect(service.getEventReviewReport('primary', 1)).resolves.toEqual({
      title: '附件复盘.docx',
      kind: 'file',
      content: null,
      message: '该报告为飞书附件，请在飞书中打开查看完整内容。',
    });
    await expect(service.getEventReviewReport('unknown', 0)).rejects.toThrow(
      '未找到复盘报告',
    );
    expect(get).toHaveBeenCalledTimes(2);
  });
});
