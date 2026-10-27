import { Test } from '@nestjs/testing';
import { HttpModule } from '@nestjs/axios';
import {
  MonthlyOperationsChangesService,
  MONTHLY_CHANGE_SOURCE,
  ZHIHANG_PROGRESS_SOURCE,
} from '../../server/modules/bitable-sync/monthly-operations-changes.service';
import { MonthlyOperationsChangesController } from '../../server/modules/bitable-sync/monthly-operations-changes.controller';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
} from '../../server/common/feishu/bitable-direct-read';
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
  resolveBitableAppToken: jest.fn(),
}));
const read = fetchBitableRecords as jest.Mock,
  snapshot = readLatestPersistedBitableRecordSnapshot as jest.Mock;
describe('月览变更只读服务与依赖注入', () => {
  let module: Awaited<
    ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>
  >;
  let service: MonthlyOperationsChangesService;
  beforeEach(async () => {
    jest.clearAllMocks();
    (resolveBitableAppToken as jest.Mock).mockResolvedValue('fixture-base');
    read.mockResolvedValue([]);
    snapshot.mockResolvedValue(null);
    module = await Test.createTestingModule({
      imports: [HttpModule],
      controllers: [MonthlyOperationsChangesController],
      providers: [MonthlyOperationsChangesService],
    }).compile();
    service = module.get(MonthlyOperationsChangesService);
  });
  afterEach(async () => {
    jest.useRealTimers();
    await module.close();
  });
  it('普通变更和进展读取使用快照后台更新模式，仍保留原始同步时间', async () => {
    const fetchedAt = Date.now() - 3600000;
    snapshot.mockResolvedValue({ fetchedAt, records: [] });
    for (const result of [
      await service.getChanges('2026-09-01', '2026-09-30'),
      await service.getProgress('2026-09-01', '2026-09-30'),
    ]) {
      expect(result).toMatchObject({
        status: 'stale',
        message: '后台更新中',
        syncedAt: new Date(fetchedAt).toISOString(),
      });
    }
    read.mock.calls.forEach((call) =>
      expect(call[1]).toMatchObject({ allowStale: true, forceRefresh: false }),
    );
  });
  it('通过 Nest 注入控制器，严格分页读取白名单，提供只读空态', async () => {
    const result = await module
      .get(MonthlyOperationsChangesController)
      .get('2026-09-01', '2026-09-30', '1');
    expect(result.status).toBe('empty');
    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: 'tblBvg6wCYSX3hcg',
        strict: true,
        allowStale: false,
        forceRefresh: true,
        fieldNames: MONTHLY_CHANGE_SOURCE.fieldNames,
      }),
    );
    expect(MONTHLY_CHANGE_SOURCE.fieldNames).not.toContain('提交人');
    expect(MONTHLY_CHANGE_SOURCE.fieldNames).not.toContain('变更编码&描述');
  });
  it('上游失败保留成功快照并显式标为过期', async () => {
    read.mockRejectedValue(Error('upstream'));
    snapshot.mockResolvedValue({
      fetchedAt: Date.parse('2026-09-10'),
      records: [
        {
          record_id: 'fixture',
          fields: { '计划开始日期（阿里）': Date.parse('2026-09-08') },
        },
      ],
    });
    const result = await service.getChanges('2026-09-01', '2026-09-30');
    expect(result.status).toBe('stale');
    expect(result.records).toHaveLength(1);
    expect(result.syncedAt).toBe('2026-09-10T00:00:00.000Z');
  });
  it('上游失败且无快照返回 error，不能当成真实零记录', async () => {
    read.mockRejectedValue(Error('upstream'));
    expect((await service.getChanges('2026-09-01', '2026-09-30')).status).toBe(
      'error',
    );
  });
  it('超时进入可重试错误态', async () => {
    jest.useFakeTimers();
    read.mockReturnValue(new Promise(() => {}));
    const pending = service.getChanges('2026-09-01', '2026-09-30');
    await jest.advanceTimersByTimeAsync(35001);
    expect((await pending).status).toBe('error');
  });
  it('无效周期在请求外部表之前拒绝', async () => {
    await expect(service.getChanges('invalid', '2026-09-30')).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('智航进展使用独立表及白名单，保持当前审批节点', async () => {
    read.mockResolvedValue([
      {
        record_id: 'progress',
        fields: {
          当前节点: '实施后审批',
          状态: '实施成功',
          计划开始: Date.parse('2026-09-10'),
        },
      },
    ]);
    const result = await module
      .get(MonthlyOperationsChangesController)
      .progress('2026-09-01', '2026-09-30', '1');
    expect(result.status).toBe('ready');
    expect(result.records[0].node).toBe('实施后审批');
    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tableId: 'tbl2cJuTBqRdIm8Z',
        fieldNames: ZHIHANG_PROGRESS_SOURCE.fieldNames,
        forceRefresh: true,
        strict: true,
      }),
    );
    expect(ZHIHANG_PROGRESS_SOURCE.fieldNames).not.toContain('提交人');
    expect(ZHIHANG_PROGRESS_SOURCE.fieldNames).not.toContain('提交人（账号）');
  });
  it('智航进展错误恢复不能读取另一张变更表的快照', async () => {
    read.mockRejectedValue(Error('upstream'));
    snapshot.mockImplementation((source) =>
      source.tableId === ZHIHANG_PROGRESS_SOURCE.tableId
        ? {
            fetchedAt: Date.parse('2026-09-14'),
            records: [
              {
                record_id: 'cached-progress',
                fields: { 当前节点: '客服审批' },
              },
            ],
          }
        : null,
    );
    const result = await service.getProgress('2026-09-01', '2026-09-30');
    expect(result.status).toBe('stale');
    expect(result.records[0].node).toBe('客服审批');
    expect(snapshot).toHaveBeenCalledWith(ZHIHANG_PROGRESS_SOURCE);
  });
});
