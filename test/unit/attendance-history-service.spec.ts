import { BadRequestException } from '@nestjs/common';
import { parseAttendanceHistoryQuery } from '../../server/modules/duty-schedule/attendance-history.query';
import { AttendanceHistoryService } from '../../server/modules/duty-schedule/attendance-history.service';

describe('AttendanceHistoryService', () => {
  it('合并同周期并发请求并复用短缓存', async () => {
    let resolveRead!: (value: {
      startDate: string;
      endDate: string;
      fetchedAt: string;
      checkedCount: number;
      anomalies: never[];
      normal: never[];
    }) => void;
    const read = jest.fn(
      () =>
        new Promise<{
          startDate: string;
          endDate: string;
          fetchedAt: string;
          checkedCount: number;
          anomalies: never[];
          normal: never[];
        }>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const service = new AttendanceHistoryService({
      readArchivedAttendancePeriod: read,
    } as never);

    const first = service.getHistory('2026-09-01', '2026-09-19');
    const second = service.getHistory('2026-09-01', '2026-09-19');
    expect(read).toHaveBeenCalledTimes(1);
    resolveRead({
      startDate: '2026-09-01',
      endDate: '2026-09-19',
      fetchedAt: '2026-09-19 10:00',
      checkedCount: 12,
      anomalies: [],
      normal: [],
    });

    await expect(first).resolves.toMatchObject({ anomalyCount: 0 });
    await expect(second).resolves.toMatchObject({ checkedCount: 12 });
    await service.getHistory('2026-09-01', '2026-09-19');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('强制刷新会跳过已完成缓存', async () => {
    const read = jest.fn().mockResolvedValue({
      startDate: '2026-09-01',
      endDate: '2026-09-19',
      fetchedAt: '2026-09-19 10:00',
      checkedCount: 12,
      anomalies: [],
      normal: [],
    });
    const service = new AttendanceHistoryService({
      readArchivedAttendancePeriod: read,
    } as never);

    await service.getHistory('2026-09-01', '2026-09-19');
    await service.getHistory('2026-09-01', '2026-09-19', true);

    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('parseAttendanceHistoryQuery', () => {
  it('接受合法周期并识别强制刷新', async () => {
    expect(
      parseAttendanceHistoryQuery('2026-09-01', '2026-09-19', 'true'),
    ).toEqual({
      startDate: '2026-09-01',
      endDate: '2026-09-19',
      forceRefresh: true,
    });
  });

  it.each([
    ['2026/09/01', '2026-09-19'],
    ['2026-09-20', '2026-09-19'],
    ['2025-09-01', '2026-09-19'],
  ])('拒绝非法或过长周期 %s ~ %s', async (from, through) => {
    expect(() => parseAttendanceHistoryQuery(from, through)).toThrow(
      BadRequestException,
    );
  });
});
