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
  MonthlyOperationsAssessmentService,
  ASSESSMENT_SOURCES,
} from '../../server/modules/bitable-sync/monthly-operations-assessment.service';
import { HttpService } from '@nestjs/axios';
describe('智航四源只读边界', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14'));
    jest.mocked(fetchBitableRecords).mockReset().mockResolvedValue([]);
    jest
      .mocked(readLatestPersistedBitableRecordSnapshot)
      .mockReset()
      .mockResolvedValue(null);
  });
  afterEach(() => jest.useRealTimers());
  it('其他三表固定投影，巡检全字段只映射业务明细；人员账号附件不会进入响应', async () => {
    const service = new MonthlyOperationsAssessmentService(new HttpService());
    for (const kind of Object.keys(ASSESSMENT_SOURCES)) {
      expect(await service.get(kind, '2026-09-01', '2026-09-30')).toMatchObject(
        { kind, status: 'empty', records: [] },
      );
      const options = jest.mocked(fetchBitableRecords).mock.calls.at(-1)![1];
      if (kind === 'inspection') expect(options.fieldNames).toBeUndefined();
      expect(options.fieldNames?.join() ?? '').not.toMatch(
        /账号|人员|负责人|主管|附件|创建人/,
      );
      expect(options).toMatchObject({ allowStale: true, strict: true });
    }
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: '1',
        fields: {
          事件ID: 'x',
          发生时间: '2026-08-31',
          创建人: 'private',
          事件标题: 'out',
        },
      },
      {
        record_id: '2',
        fields: {
          事件ID: 'y',
          发生时间: '2026-09-01',
          事件标题: 'in',
          创建人: 'private',
        },
      },
    ]);
    const data = await service.get('event', '2026-09-01', '2026-09-30');
    expect(data.records.map((r) => r.id)).toEqual(['2']);
    expect(JSON.stringify(data)).not.toContain('private');
    jest.mocked(fetchBitableRecords).mockResolvedValue([
      {
        record_id: 'inspection',
        fields: {
          自动编码: 'I-1',
          工单名称: 'C楼巡检',
          楼栋: 'C楼',
          计划区间: '2026/09/02 08:00-2026/09/02 20:00',
          异常标: '异常',
          异常描述: '冷机压力偏高',
          创建人: 'private',
          附件: 'private',
        },
      },
    ]);
    const inspection = await service.get(
      'inspection',
      '2026-09-01',
      '2026-09-30',
    );
    expect(inspection.records[0].detail).toContainEqual({
      label: '异常原因',
      value: '异常描述：冷机压力偏高',
    });
    expect(JSON.stringify(inspection)).not.toContain('private');
  });
  it('越权种类和无效周期联网前拒绝', async () => {
    const service = new MonthlyOperationsAssessmentService(new HttpService());
    await expect(
      service.get('__proto__', '2026-09-01', '2026-09-30'),
    ).rejects.toThrow();
    await expect(service.get('event', 'bad', '2026-09-30')).rejects.toThrow();
    expect(fetchBitableRecords).not.toHaveBeenCalled();
  });
  it('汇总为空或排查明细失败时仍保留 OPEN 风险清单', async () => {
    jest.mocked(fetchBitableRecords).mockImplementation(async (_http, options) => {
      if (options.tableId === 'tblviRG8ZDfY7AnF')
        return [{ record_id: 'open-1', fields: {
          楼栋名称: '南通A楼', 风险项编号: 'JS-JZ-FS-3', 风险等级: '低',
          检查项_描述: '检查消防通道',
        } }];
      if (options.tableId === 'tblNddknaoXp2ASG') throw Error('inspection unavailable');
      return [];
    });
    const data = await new MonthlyOperationsAssessmentService(new HttpService()).get(
      'risk', '2026-09-01', '2026-09-30',
    );
    expect(data.records).toEqual([]);
    expect(data.openRisks).toMatchObject([{
      building: 'A楼', code: 'JS-JZ-FS-3', inspectionStatus: '排查记录暂不可用',
    }]);
    expect(data.openRiskStatus).toMatchObject({ status: 'stale' });
  });
  it('旧快照立即返回，手动刷新等待真实读取，失败保留快照', async () => {
    jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue({
      fetchedAt: Date.now() - 3600000,
      records: [],
    } as never);
    const service = new MonthlyOperationsAssessmentService(new HttpService());
    expect(await service.get('risk', '2026-09-01', '2026-09-30')).toMatchObject(
      { status: 'stale', message: '后台更新中' },
    );
    await service.get('risk', '2026-09-01', '2026-09-30', true);
    expect(
      jest.mocked(fetchBitableRecords).mock.calls.at(-1)![1],
    ).toMatchObject({ allowStale: false, forceRefresh: true });
    jest.mocked(fetchBitableRecords).mockRejectedValue(Error('network'));
    expect(
      await service.get('risk', '2026-09-01', '2026-09-30', true),
    ).toMatchObject({ status: 'stale', message: '更新失败，显示上次成功数据' });
  });
  it('超时明确错误并清理定时器，不伪造成功', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockImplementation(() => new Promise(() => {}));
    const task = new MonthlyOperationsAssessmentService(new HttpService()).get(
      'inspection',
      '2026-09-01',
      '2026-09-30',
    );
    await jest.advanceTimersByTimeAsync(35001);
    expect(await task).toMatchObject({ status: 'error', records: [] });
    expect(jest.getTimerCount()).toBe(0);
  });
});
