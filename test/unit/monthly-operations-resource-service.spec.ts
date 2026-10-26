jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
}));
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
} from '../../server/common/feishu/bitable-direct-read';
import {
  MonthlyOperationsResourcesService,
  MONTHLY_RESOURCE_SOURCES,
} from '../../server/modules/bitable-sync/monthly-operations-resources.service';
import { HttpService } from '@nestjs/axios';
const fetchRows = jest.mocked(fetchBitableRecords),
  persisted = jest.mocked(readLatestPersistedBitableRecordSnapshot);
describe('月览资源读取状态与投影', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-13T12:00:00+08:00'));
    fetchRows.mockReset().mockResolvedValue([]);
    persisted.mockReset().mockResolvedValue(null);
  });
  afterEach(() => jest.useRealTimers());
  const create = () => new MonthlyOperationsResourcesService(new HttpService());
  it('只读取授权五表及白名单字段，PUE 数值投影；机柜快照不使用不支持的公式日期过滤', async () => {
    await create().getResources('2026-09-01', '2026-09-30');
    expect(fetchRows).toHaveBeenCalledTimes(5);
    const options = fetchRows.mock.calls.map((x) => x[1]);
    expect(options.map((x) => x.tableId).sort()).toEqual(
      Object.values(MONTHLY_RESOURCE_SOURCES)
        .map((x) => x.tableId)
        .sort(),
    );
    expect(options[0].filter).toBeUndefined();
    expect(options[1].fieldNames).toContain('PUE（数值）');
    expect(options[1].fieldNames).not.toContain('PUE');
    options.forEach((x) => {
      expect(x).toMatchObject({
        strict: true,
        allowStale: true,
        cacheTtlMs: 300000,
      });
    });
    expect(options[2].fieldNames).toEqual([
      '日期',
      '楼栋',
      '班次',
      '室外湿球温度（℃）',
      '本班组上电机柜数（个）',
      '本班组下电机柜数（个）',
    ]);
    expect(options[2].viewId).toBe('vewX77mW48');
  });
  it('资源快照先返回，显式刷新对五个来源都等待最新数据', async () => {
    persisted.mockResolvedValue({
      fetchedAt: Date.now() - 3600000,
      records: [],
    } as never);
    const data = await create().getResources('2026-09-01', '2026-09-30');
    expect(data.energy).toMatchObject({
      status: 'stale',
      message: '后台更新中',
    });
    fetchRows.mockClear();
    await create().getResources('2026-09-01', '2026-09-30', true);
    fetchRows.mock.calls.forEach((call) =>
      expect(call[1]).toMatchObject({ forceRefresh: true, allowStale: false }),
    );
  });
  it('同一周期复用已映射响应，避免重复读取和聚合全年明细', async () => {
    const service = create();
    const first = await service.getResources('2026-01-01', '2026-12-31');
    const second = await service.getResources('2026-01-01', '2026-12-31');

    expect(second).toBe(first);
    expect(fetchRows).toHaveBeenCalledTimes(5);
  });
  it('全年读取复用最近七天内的同年度快照并在后台更新', async () => {
    const previousUpperBoundary = String(
      Date.parse('2026-09-13T00:00:00+08:00'),
    );
    persisted.mockImplementation(async (options) => {
      const upperBoundary = options.filter?.conditions[1]?.value?.[1];
      return upperBoundary === previousUpperBoundary
        ? ({
            fetchedAt: Date.parse('2026-09-12T23:00:00+08:00'),
            records: [],
          } as never)
        : null;
    });
    const slowTableIds = new Set<string>([
      MONTHLY_RESOURCE_SOURCES.energy.tableId,
      MONTHLY_RESOURCE_SOURCES.weather.tableId,
      MONTHLY_RESOURCE_SOURCES.water.tableId,
    ]);
    fetchRows.mockImplementation(async (_http, options) => {
      if (slowTableIds.has(options.tableId)) return new Promise(() => {});
      return [];
    });

    const data = await create().getResources('2026-01-01', '2026-12-31');

    expect(data.energy).toMatchObject({
      status: 'stale',
      message: '后台更新中',
    });
    expect(data.weather.status).toBe('stale');
    expect(data.water.status).toBe('stale');
    expect(fetchRows).toHaveBeenCalledTimes(5);
  });
  it('单源失败独立报错，其他来源仍可用，缺数不能伪造成功', async () => {
    fetchRows.mockImplementation(async (_http, options) => {
      if (options.tableId === MONTHLY_RESOURCE_SOURCES.energy.tableId)
        throw Error('upstream');
      return [];
    });
    const data = await create().getResources('2026-09-01', '2026-09-30');
    expect(data.energy.status).toBe('error');
    expect(data.water.status).toBe('empty');
    expect(data.energy.days.every((x) => x.pue === null)).toBe(true);
  });
  it('网络失败使用同查询成功快照并显示过期状态', async () => {
    fetchRows.mockRejectedValue(Error('upstream'));
    persisted.mockResolvedValue({
      fetchedAt: Date.parse('2026-09-12T00:00:00Z'),
      records: [],
    } as never);
    const data = await create().getResources('2026-09-01', '2026-09-30');
    expect(data.energy.status).toBe('stale');
    expect(data.energy.syncedAt).toBe('2026-09-12T00:00:00.000Z');
    expect(data.energy.message).toContain('上次成功');
  });
  it('外部读取35秒截止，返回可恢复错误并清除计时器', async () => {
    fetchRows.mockImplementation(() => new Promise(() => {}));
    const task = create().getResources('2026-09-01', '2026-09-30');
    await jest.advanceTimersByTimeAsync(35001);
    const data = await task;
    expect(data.energy.status).toBe('error');
    expect(jest.getTimerCount()).toBe(0);
  });
  it('????????35????????60???????????', async () => {
    fetchRows.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const task = create()
      .getResources('2026-01-01', '2026-12-31')
      .then((data) => {
        settled = true;
        return data;
      });
    await jest.advanceTimersByTimeAsync(35001);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(25000);
    const data = await task;
    expect(data.energy.status).toBe('error');
    expect(jest.getTimerCount()).toBe(0);
  });
  it('无效日期在联网之前拒绝', async () => {
    await expect(
      create().getResources('2026-10-01', '2026-09-30'),
    ).rejects.toThrow();
    expect(fetchRows).not.toHaveBeenCalled();
  });
});
