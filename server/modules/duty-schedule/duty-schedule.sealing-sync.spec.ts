import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { DutyScheduleService } from './duty-schedule.service';

jest.mock('../../common/feishu/bitable-direct-read', () => {
  const actual = jest.requireActual(
    '../../common/feishu/bitable-direct-read',
  ) as typeof import('../../common/feishu/bitable-direct-read');
  return {
    ...actual,
    fetchBitableRecords: jest.fn(),
    readLatestPersistedBitableRecordSnapshot: jest.fn(),
    resolveBitableAppToken: jest.fn(),
  };
});

const mockedFetchBitableRecords = jest.mocked(fetchBitableRecords);
const mockedResolveBitableAppToken = jest.mocked(resolveBitableAppToken);
const mockedPersisted = jest.mocked(readLatestPersistedBitableRecordSnapshot);

function sealingRecord(
  id: string,
  startDate: string,
  endDate: string,
): BitableRecordItem {
  return {
    record_id: id,
    fields: {
      封网信息: `封网 ${id}`,
      编号: id,
      开始日期: Date.parse(startDate),
      结束日期: Date.parse(endDate),
    },
  };
}

describe('DutyScheduleService sealing source synchronization', () => {
  let now: number;
  let service: DutyScheduleService;

  beforeEach(() => {
    jest.clearAllMocks();
    now = Date.parse('2026-07-29T08:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockedResolveBitableAppToken.mockResolvedValue('seal-app-token');
    mockedPersisted.mockResolvedValue(null);
    service = new DutyScheduleService({} as never, {} as never);
    (service as unknown as { sealingConfig: unknown }).sealingConfig = {
      appToken: 'seal-app-token',
      wikiToken: '',
      tableId: 'tblSeal',
      viewId: 'vewSeal',
      tableName: '封网信息',
      sourceUrl: 'https://example.test/base?table=tblSeal&view=vewSeal',
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('synchronously refreshes once per five-minute window and exposes the next snapshot immediately', async () => {
    mockedFetchBitableRecords
      .mockResolvedValueOnce([
        sealingRecord(
          'rec-today',
          '2026-07-29T00:00:00.000Z',
          '2026-07-30T00:00:00.000Z',
        ),
      ])
      .mockResolvedValueOnce([
        sealingRecord(
          'rec-today',
          '2026-07-29T00:00:00.000Z',
          '2026-07-30T00:00:00.000Z',
        ),
        sealingRecord(
          'rec-new',
          '2026-07-31T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z',
        ),
      ]);

    await expect(service.getYearlySealingInfo(2026)).resolves.toMatchObject({
      total: 1,
    });
    await expect(service.getYearlySealingInfo(2026)).resolves.toMatchObject({
      total: 1,
    });
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(1);
    expect(mockedFetchBitableRecords).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        cacheTtlMs: 5 * 60 * 1000,
        forceRefresh: true,
      }),
    );

    now += 5 * 60 * 1000 + 1;
    await expect(service.getYearlySealingInfo(2026)).resolves.toMatchObject({
      total: 2,
    });
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent refreshes so multiple dashboards do not fan out to Feishu', async () => {
    let resolveRecords!: (records: BitableRecordItem[]) => void;
    mockedFetchBitableRecords.mockReturnValue(
      new Promise<BitableRecordItem[]>((resolve) => {
        resolveRecords = resolve;
      }),
    );

    const first = service.getYearlySealingInfo(2026);
    const second = service.getYearlySealingInfo(2026);
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(1);

    resolveRecords([
      sealingRecord(
        'rec-today',
        '2026-07-29T00:00:00.000Z',
        '2026-07-30T00:00:00.000Z',
      ),
    ]);
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { total: 1 },
      { total: 1 },
    ]);
  });

  it('keeps the last successful snapshot after a refresh failure and retries after 30 seconds', async () => {
    mockedFetchBitableRecords
      .mockResolvedValueOnce([
        sealingRecord(
          'rec-today',
          '2026-07-29T00:00:00.000Z',
          '2026-07-30T00:00:00.000Z',
        ),
      ])
      .mockRejectedValueOnce(new Error('temporary Feishu outage'))
      .mockResolvedValueOnce([
        sealingRecord(
          'rec-today',
          '2026-07-29T00:00:00.000Z',
          '2026-07-30T00:00:00.000Z',
        ),
        sealingRecord(
          'rec-new',
          '2026-07-31T00:00:00.000Z',
          '2026-08-01T00:00:00.000Z',
        ),
      ]);

    await expect(service.getYearlySealingInfo(2026)).resolves.toMatchObject({
      total: 1,
    });
    now += 5 * 60 * 1000 + 1;
    await expect(service.getYearlySealingInfo(2026)).resolves.toMatchObject({
      total: 1,
    });
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(2);

    now += 29 * 1000;
    await expect(service.getYearlySealingInfo(2026)).resolves.toMatchObject({
      total: 1,
    });
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(2);

    now += 1001;
    await expect(service.getYearlySealingInfo(2026)).resolves.toMatchObject({
      total: 2,
    });
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(3);
  });

  it('surfaces an initial read failure instead of returning an empty successful snapshot', async () => {
    mockedFetchBitableRecords.mockRejectedValueOnce(
      new Error('initial Feishu outage'),
    );

    await expect(service.getYearlySealingInfo(2026)).rejects.toThrow(
      'initial Feishu outage',
    );
  });

  it('restores persisted sealing records after a restart when wiki resolution fails', async () => {
    mockedPersisted.mockResolvedValue({
      records: [
        sealingRecord('cached', '2026-07-29T00:00:00Z', '2026-07-30T00:00:00Z'),
      ],
      fetchedAt: now - 10 * 60 * 1000,
      expiresAt: now - 5 * 60 * 1000,
    });
    mockedResolveBitableAppToken.mockRejectedValueOnce(
      new Error('wiki offline'),
    );
    await expect(service.getYearlySealingInfo(2026)).resolves.toMatchObject({
      total: 1,
      sourceStatus: 'stale',
      syncedAt: new Date(now - 10 * 60 * 1000).toISOString(),
    });
    expect(mockedPersisted).toHaveBeenCalledWith(
      expect.objectContaining({
        appToken: 'seal-app-token',
        tableId: 'tblSeal',
        viewId: 'vewSeal',
        tableName: '封网信息',
      }),
    );
  });

  it('uses a fresh persisted snapshot without resolving Feishu again', async () => {
    mockedPersisted.mockResolvedValue({
      records: [
        sealingRecord('cached', '2026-07-29T00:00:00Z', '2026-07-30T00:00:00Z'),
      ],
      fetchedAt: now - 1000,
      expiresAt: now + 1000,
    });
    await expect(service.getYearlySealingInfo(2026)).resolves.toMatchObject({
      total: 1,
      sourceStatus: 'fresh',
    });
    expect(mockedResolveBitableAppToken).not.toHaveBeenCalled();
  });

  it('bounds a hung sealing refresh and retains the cached list until the in-flight read recovers', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    mockedPersisted.mockResolvedValue({
      records: [
        sealingRecord('cached', '2026-07-29T00:00:00Z', '2026-07-30T00:00:00Z'),
      ],
      fetchedAt: now - 10 * 60 * 1000,
      expiresAt: now - 5 * 60 * 1000,
    });
    let resolveRecords!: (records: BitableRecordItem[]) => void;
    mockedFetchBitableRecords.mockReturnValue(
      new Promise((resolve) => {
        resolveRecords = resolve;
      }),
    );
    const result = service.getYearlySealingInfo(2026);
    await jest.advanceTimersByTimeAsync(8001);
    await expect(result).resolves.toMatchObject({
      total: 1,
      sourceStatus: 'stale',
    });
    resolveRecords([
      sealingRecord(
        'recovered',
        '2026-07-29T00:00:00Z',
        '2026-07-30T00:00:00Z',
      ),
    ]);
    await jest.advanceTimersByTimeAsync(0);
    await expect(service.getYearlySealingInfo(2026)).resolves.toMatchObject({
      sourceStatus: 'fresh',
      sealings: [expect.objectContaining({ id: 'recovered' })],
    });
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(1);
  });

  it('rejects a hung cold read without inventing a zero total', async () => {
    jest.useFakeTimers();
    mockedFetchBitableRecords.mockReturnValue(new Promise(() => {}));
    const result = service
      .getYearlySealingInfo(2026)
      .catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(8001);
    expect(await result).toMatchObject({ code: 'SOURCE_TIMEOUT' });
  });
});
