import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';
import { DutyScheduleController } from '../../server/modules/duty-schedule/duty-schedule.controller';
import { fetchBitableRecords } from '../../server/common/feishu/bitable-direct-read';
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  resolveBitableAppToken: jest.fn().mockResolvedValue('fixture'),
}));
describe('calendar follow-up bounded reads', () => {
  function service() {
    return Object.assign(Object.create(DutyScheduleService.prototype), {
      exceptionFollowUpConfig: {
        appToken: 'fixture',
        tableId: 'fixture',
        tableName: 'fixture',
      },
      hasBitableSourceConfig: () => true,
      mapExceptionFollowUpRecord: (r: any) => r,
    }) as DutyScheduleService;
  }
  beforeEach(() => jest.clearAllMocks());
  it('reads all days in one range without relabeling their dates', async () => {
    (fetchBitableRecords as jest.Mock).mockResolvedValue([
      { recordId: 'one', date: '2026-10-15' },
      { recordId: 'two', date: '2026-10-16' },
      { recordId: 'outside', date: '2026-10-17' },
    ]);
    const result = await (service().getExceptionFollowUps as any)(
      '2026-10-15',
      false,
      '2026-10-16',
    );
    expect(result.items.map((i: any) => i.date)).toEqual([
      '2026-10-15',
      '2026-10-16',
    ]);
    expect(result.range).toEqual({ start: '2026-10-15', end: '2026-10-16' });
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
  });
  it.each(['2026-10-14', '2026-02-30', '2027-01-01'])(
    'rejects invalid/reversed/oversized range ending %s before source access',
    async (end) => {
      await expect(
        (service().getExceptionFollowUps as any)('2026-10-15', false, end),
      ).rejects.toThrow();
      expect(fetchBitableRecords).not.toHaveBeenCalled();
    },
  );
  it('keeps existing single-day calls unchanged', async () => {
    (fetchBitableRecords as jest.Mock).mockResolvedValue([
      { recordId: 'one', date: '2026-10-15' },
      { recordId: 'two', date: '2026-10-16' },
    ]);
    const result = await service().getExceptionFollowUps('2026-10-15', false);
    expect(result.date).toBe('2026-10-15');
    expect(result.items).toHaveLength(1);
    expect((result as any).range).toBeUndefined();
  });
  it('passes the optional end date through the existing controller', async () => {
    const getExceptionFollowUps = jest.fn().mockResolvedValue({ items: [] });
    const controller = Object.assign(
      Object.create(DutyScheduleController.prototype),
      { dutyScheduleService: { getExceptionFollowUps } },
    );
    await controller.getExceptionFollowUps('2026-10-15', '1', '2026-10-16');
    expect(getExceptionFollowUps).toHaveBeenCalledWith(
      '2026-10-15',
      true,
      '2026-10-16',
    );
  });
  it('preserves the two-argument controller contract for a single date', async () => {
    const getExceptionFollowUps = jest.fn().mockResolvedValue({ items: [] });
    const controller = Object.assign(
      Object.create(DutyScheduleController.prototype),
      { dutyScheduleService: { getExceptionFollowUps } },
    );
    await controller.getExceptionFollowUps('2026-10-15', '1');
    expect(getExceptionFollowUps).toHaveBeenCalledWith('2026-10-15', true);
  });
});
