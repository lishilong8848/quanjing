jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
}));
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
} from '../../server/common/feishu/bitable-direct-read';
import { MonthlyOperationsAlarmsService } from '../../server/modules/bitable-sync/monthly-operations-alarms.service';
import { MonthlyOperationsMaintenanceService } from '../../server/modules/bitable-sync/monthly-operations-maintenance.service';
import { HttpService } from '@nestjs/axios';
describe('告警与维护只读服务', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T08:00:00+08:00'));
    jest.mocked(fetchBitableRecords).mockReset().mockResolvedValue([]);
    jest
      .mocked(readLatestPersistedBitableRecordSnapshot)
      .mockReset()
      .mockResolvedValue(null);
  });
  afterEach(() => jest.useRealTimers());
  it('告警远端限定有效等级及周期，回读再验证范围', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      { record_id: 'in', fields: { 等级: '重要', 产生时间: '2026-09-01' } },
      { record_id: 'out', fields: { 等级: '重要', 产生时间: '2026-08-31' } },
    ]);
    const data = await new MonthlyOperationsAlarmsService(
      new HttpService(),
    ).get('2026-09-01', '2026-09-30');
    expect(data.records.map((r) => r.id)).toEqual(['in']);
    const options = jest.mocked(fetchBitableRecords).mock.calls[0][1];
    expect(options.filter?.conditions).toEqual([
      { field_name: '等级', operator: 'isNotEmpty', value: [] },
      {
        field_name: '产生时间',
        operator: 'isGreater',
        value: ['ExactDate', String(Date.parse('2026-08-31T00:00:00+08:00'))],
      },
      {
        field_name: '产生时间',
        operator: 'isLess',
        value: ['ExactDate', String(Date.parse('2026-09-15T00:00:00+08:00'))],
      },
    ]);
    expect(options.fieldNames?.join()).not.toMatch(/确认人|受理人|账号/);
  });
  it('维护源固定、空数据和失败状态不同，旧快照可读', async () => {
    const service = new MonthlyOperationsMaintenanceService(new HttpService());
    for (const kind of ['planned', 'unplanned'])
      expect(await service.get(kind, '2026-09-01', '2026-09-30')).toMatchObject(
        { status: 'empty', kind },
      );
    await expect(
      service.get('other', '2026-09-01', '2026-09-30'),
    ).rejects.toThrow();
    jest.mocked(fetchBitableRecords).mockRejectedValue(Error('offline'));
    expect(
      await service.get('planned', '2026-09-01', '2026-09-30'),
    ).toMatchObject({ status: 'error' });
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue({
      records: [],
      fetchedAt: Date.now() - 3600000,
    } as never);
    expect(
      await service.get('planned', '2026-09-01', '2026-09-30'),
    ).toMatchObject({ status: 'stale', message: '更新失败，显示上次成功数据' });
  });
  it('告警刷新等待真实数据，超时清理计时器并报错', async () => {
    const service = new MonthlyOperationsAlarmsService(new HttpService());
    jest
      .mocked(fetchBitableRecords)
      .mockImplementation(() => new Promise(() => {}));
    const task = service.get('2026-09-01', '2026-09-30', true);
    await jest.advanceTimersByTimeAsync(35001);
    expect(await task).toMatchObject({ status: 'error' });
    expect(jest.mocked(fetchBitableRecords).mock.calls[0][1]).toMatchObject({
      allowStale: false,
      forceRefresh: true,
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});
