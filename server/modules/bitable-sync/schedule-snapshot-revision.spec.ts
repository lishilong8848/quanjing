jest.mock('../../common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../common/feishu/bitable-direct-read'),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
}));
jest.mock('../../common/feishu/leave-approval-source', () => ({
  ...jest.requireActual('../../common/feishu/leave-approval-source'),
  readCachedLeaveApprovalSnapshotState: jest.fn(),
}));

import { readLatestPersistedBitableRecordSnapshot } from '../../common/feishu/bitable-direct-read';
import { readCachedLeaveApprovalSnapshotState } from '../../common/feishu/leave-approval-source';
import { BitableSyncService } from './bitable-sync.service';

interface ScheduleSnapshotRevisionResponseContract {
  available: boolean;
  token: string | null;
  nonDutyFetchedAt: number | null;
  scheduleFetchedAt: number | null;
}

interface ScheduleSnapshotRevisionReader {
  getScheduleSnapshotRevision(): Promise<ScheduleSnapshotRevisionResponseContract>;
}

function persistedSnapshot(fetchedAt: number) {
  return {
    records: [],
    fetchedAt,
    expiresAt: fetchedAt + 60_000,
  };
}

function createServiceHarness() {
  const axiosRef = {
    get: jest.fn(),
    post: jest.fn(),
    request: jest.fn(),
  };
  const service = new BitableSyncService(
    {} as never,
    { axiosRef } as never,
  ) as BitableSyncService & ScheduleSnapshotRevisionReader;
  const fetchFeishuNonDutyRecords = jest.fn(() => {
    throw new Error('schedule snapshot revision must not fetch Feishu');
  });
  const fetchFeishuScheduleRecords = jest.fn(() => {
    throw new Error('schedule snapshot revision must not fetch Feishu');
  });

  Object.assign(service, {
    NON_DUTY_APP_TOKEN: 'non-duty-app-token',
    NON_DUTY_TABLE_ID: 'non-duty-table-id',
    SCHEDULE_APP_TOKEN: 'schedule-app-token',
    SCHEDULE_TABLE_ID: 'schedule-table-id',
    fetchFeishuNonDutyRecords,
    fetchFeishuScheduleRecords,
  });

  return {
    axiosRef,
    fetchFeishuNonDutyRecords,
    fetchFeishuScheduleRecords,
    service,
  };
}

function readRevision(
  service: BitableSyncService & ScheduleSnapshotRevisionReader,
): Promise<ScheduleSnapshotRevisionResponseContract> {
  const method = service.getScheduleSnapshotRevision;
  expect(method).toEqual(expect.any(Function));
  return method.call(service);
}

describe('BitableSyncService schedule snapshot revision', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(readCachedLeaveApprovalSnapshotState).mockResolvedValue({
      snapshot: { verified: true, requests: [] },
      approvalFetchedAt: 1_725_000_001_100,
      shiftDetailFetchedAt: 1_725_000_001_200,
    });
  });

  it('combines schedule and leave projection timestamps into one revision token without HTTP', async () => {
    jest
      .mocked(readLatestPersistedBitableRecordSnapshot)
      .mockResolvedValueOnce(persistedSnapshot(1_725_000_000_100))
      .mockResolvedValueOnce(persistedSnapshot(1_725_000_000_900));
    const {
      axiosRef,
      fetchFeishuNonDutyRecords,
      fetchFeishuScheduleRecords,
      service,
    } = createServiceHarness();

    await expect(readRevision(service)).resolves.toEqual({
      available: true,
      token: '1725000000100:1725000000900:1725000001100:1725000001200',
      nonDutyFetchedAt: 1_725_000_000_100,
      scheduleFetchedAt: 1_725_000_000_900,
    });
    expect(readLatestPersistedBitableRecordSnapshot).toHaveBeenNthCalledWith(
      1,
      {
        appToken: 'non-duty-app-token',
        tableId: 'non-duty-table-id',
        tableName: '长白班排班',
      },
    );
    expect(readLatestPersistedBitableRecordSnapshot).toHaveBeenNthCalledWith(
      2,
      {
        appToken: 'schedule-app-token',
        tableId: 'schedule-table-id',
        tableName: '值班排班',
      },
    );
    expect(readLatestPersistedBitableRecordSnapshot).toHaveBeenCalledTimes(2);
    expect(readCachedLeaveApprovalSnapshotState).toHaveBeenCalledTimes(1);
    expect(fetchFeishuNonDutyRecords).not.toHaveBeenCalled();
    expect(fetchFeishuScheduleRecords).not.toHaveBeenCalled();
    expect(axiosRef.get).not.toHaveBeenCalled();
    expect(axiosRef.post).not.toHaveBeenCalled();
    expect(axiosRef.request).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'long-white snapshot',
      nonDutySnapshot: null,
      scheduleSnapshot: persistedSnapshot(1_725_000_000_900),
      expected: {
        available: false,
        token: null,
        nonDutyFetchedAt: null,
        scheduleFetchedAt: 1_725_000_000_900,
      },
    },
    {
      label: 'duty snapshot',
      nonDutySnapshot: persistedSnapshot(1_725_000_000_100),
      scheduleSnapshot: null,
      expected: {
        available: false,
        token: null,
        nonDutyFetchedAt: 1_725_000_000_100,
        scheduleFetchedAt: null,
      },
    },
  ])(
    'is unavailable when the $label is missing while preserving the other timestamp',
    async ({ nonDutySnapshot, scheduleSnapshot, expected }) => {
      jest
        .mocked(readLatestPersistedBitableRecordSnapshot)
        .mockResolvedValueOnce(nonDutySnapshot)
        .mockResolvedValueOnce(scheduleSnapshot);
      const { service } = createServiceHarness();

      await expect(readRevision(service)).resolves.toEqual(expected);
    },
  );
});
