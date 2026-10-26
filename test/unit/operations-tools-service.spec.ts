jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
  createBitableBackgroundRefresh: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
  })),
}));
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
} from '../../server/common/feishu/bitable-direct-read';
import { OperationsToolsService } from '../../server/modules/operations-tools/operations-tools.service';
import { TOOL_SOURCES } from '../../server/modules/operations-tools/operations-tools.config';

describe('tools snapshot read-through and background refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(readLatestPersistedBitableRecordSnapshot)
      .mockResolvedValue(null);
    jest.mocked(fetchBitableRecords).mockResolvedValue([]);
  });
  it('deduplicates concurrent syncs and exposes unavailable sources instead of successful zeroes', async () => {
    const service = new OperationsToolsService({} as never);
    jest
      .mocked(fetchBitableRecords)
      .mockRejectedValue(new Error('private token must not escape'));
    await Promise.all([service.refresh(), service.refresh()]);
    const snapshot = await service.getSnapshot();
    expect(fetchBitableRecords).toHaveBeenCalledTimes(7);
    expect(snapshot.sources.ledger.state).toBe('error');
    expect(JSON.stringify(snapshot)).not.toContain('private token');
  });
  it('retains last successful section when an external refresh fails', async () => {
    const service = new OperationsToolsService({} as never);
    jest
      .mocked(fetchBitableRecords)
      .mockImplementation(async (_http, options) =>
        options.tableId === TOOL_SOURCES.ledger.tableId
          ? [
              {
                record_id: 'recA',
                fields: { 工具名称: '真实样本', 楼栋: '南通A楼' },
              },
            ]
          : [],
      );
    await service.refresh();
    jest.mocked(fetchBitableRecords).mockRejectedValue(new Error('offline'));
    await service.refresh();
    const snapshot = await service.getSnapshot();
    expect(snapshot.tools).toHaveLength(1);
    expect(snapshot.sources.ledger.state).toBe('stale');
    expect(snapshot.refreshing).toBe(false);
  });
  it('hydrates persistent cache before returning without waiting for network', async () => {
    jest
      .mocked(readLatestPersistedBitableRecordSnapshot)
      .mockImplementation(async (options) =>
        options.tableId === TOOL_SOURCES.ledger.tableId
          ? {
              records: [
                { record_id: 'recA', fields: { 工具名称: '缓存工具' } },
              ],
              fetchedAt: Date.now() - 120000,
              expiresAt: 0,
            }
          : null,
      );
    let release!: (value: []) => void;
    const pending = new Promise<[]>((resolve) => {
      release = resolve;
    });
    jest.mocked(fetchBitableRecords).mockImplementation(() => pending);
    const service = new OperationsToolsService({} as never);
    const snapshot = await service.getSnapshot();
    expect(snapshot.tools[0].name).toBe('缓存工具');
    expect(snapshot.sources.ledger.state).toBe('stale');
    expect(snapshot.refreshing).toBe(true);
    release([]);
    await service.refresh();
    expect((await service.getSnapshot()).refreshing).toBe(false);
  });
});
