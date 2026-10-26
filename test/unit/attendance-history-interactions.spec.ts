jest.mock('@server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('@server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
}));
import { fetchBitableRecords } from '../../server/common/feishu/bitable-direct-read';
import { AttendanceAutomationFeishuGateway } from '../../server/modules/duty-schedule/attendance-automation-feishu.gateway';
import { AttendanceHistoryService } from '../../server/modules/duty-schedule/attendance-history.service';
import { buildAttendanceHistoryResponse } from '../../server/modules/duty-schedule/attendance-history.model';
import { filterAttendanceHistoryItems } from '../../client/src/components/attendance/attendance-history-presentation';

const expectation = {
  key: '2026-10-01:A:night:OffDuty:甲',
  name: '甲',
  building: 'A楼',
  shiftLabel: '夜班',
  direction: 'OffDuty',
  expectedAt: '2026-10-02 09:00:00',
  status: 'on_duty',
};
const records = [
  {
    record_id: 'result',
    fields: {
      记录类型: '考勤结果',
      工作日期: Date.parse('2026-10-01T00:00:00+08:00'),
      时间状态: '正常',
      原始记录JSON: JSON.stringify({
        attendanceChecks: [
          {
            expectation,
            timeResult: 'Normal',
            userCheckTime: '2026-10-02 09:00:00',
            processInstanceId: 'approval',
            sourceType: 'APPROVE',
            correctionEvidenceStatus: 'present',
          },
        ],
      }),
    },
  },
  {
    record_id: 'approval-record',
    fields: {
      记录类型: '补卡审批',
      工作日期: Date.parse('2026-10-01T00:00:00+08:00'),
      姓名: '甲',
      打卡类型: '下班',
      补卡状态: '已通过',
      补卡审批实例ID: 'approval',
      补卡举证材料: [{ file_token: 'photo' }],
    },
  },
];
const query = { businessDate: '2026-10-01', entryKey: expectation.key };

describe('attendance history interaction regressions', () => {
  beforeEach(() => jest.clearAllMocks());
  it('limits photo metadata reads while preserving legacy approvals without a work date', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue(records);
    const gateway = new AttendanceAutomationFeishuGateway({} as never);
    await gateway.readCorrectionEvidence(query);
    expect(fetchBitableRecords).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        forceRefresh: false,
        filter: {
          conjunction: 'or',
          conditions: [
            {
              field_name: '工作日期',
              operator: 'is',
              value: [
                'ExactDate',
                String(Date.parse('2026-10-01T00:00:00+08:00')),
              ],
            },
            { field_name: '记录类型', operator: 'is', value: ['补卡审批'] },
          ],
        },
      }),
    );
  });
  it('serves fresh history without waiting for an in-flight explicit refresh', async () => {
    const source = {
      startDate: '2026-10-01',
      endDate: '2026-10-10',
      fetchedAt: '2026-10-10 10:00',
      checkedCount: 1,
      anomalies: [],
      corrected: [],
      normal: [],
    };
    let resolve!: (value: typeof source) => void;
    const read = jest
      .fn()
      .mockResolvedValueOnce(source)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
    const service = new AttendanceHistoryService({
      readArchivedAttendancePeriod: read,
    } as never);
    const cached = await service.getHistory(source.startDate, source.endDate);
    const refresh = service.getHistory(source.startDate, source.endDate, true);
    let returned = false;
    const normal = service
      .getHistory(source.startDate, source.endDate)
      .then((value) => {
        returned = true;
        return value;
      });
    await Promise.resolve();
    const immediate = returned;
    resolve(source);
    await refresh;
    expect(await normal).toBe(cached);
    expect(immediate).toBe(true);
  });
  it('keeps the business date separate from next-morning display date', () => {
    const result = buildAttendanceHistoryResponse({
      startDate: query.businessDate,
      endDate: query.businessDate,
      fetchedAt: '',
      checkedCount: 1,
      anomalies: [],
      corrected: [{ ...expectation, businessDate: query.businessDate }],
    } as never);
    expect(result.items[0]).toMatchObject({
      businessDate: '2026-10-01',
      date: '2026-10-02',
    });
  });
  it('passes the actual archive work date through the gateway into the history response', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue(records);
    const gateway = new AttendanceAutomationFeishuGateway({} as never);
    const source = await gateway.readArchivedAttendancePeriod(
      query.businessDate,
      query.businessDate,
    );
    expect(buildAttendanceHistoryResponse(source).items[0]).toMatchObject({
      businessDate: '2026-10-01',
      date: '2026-10-02',
      category: 'corrected',
    });
  });
  it('bounds slow COS metadata reads instead of waiting sixty seconds', async () => {
    jest.useFakeTimers();
    try {
      jest.mocked(fetchBitableRecords).mockResolvedValue(records);
      const gateway = new AttendanceAutomationFeishuGateway(
        {} as never,
        { getStored: () => new Promise(() => {}) } as never,
      );
      const result = gateway.readCorrectionEvidence(query);
      await jest.advanceTimersByTimeAsync(1_001);
      await expect(result).resolves.toMatchObject({
        syncState: 'ready',
        images: [{ transport: 'proxy' }],
      });
    } finally {
      jest.useRealTimers();
    }
  });
  it('combines person/building drilldown with category without fetching', () => {
    const items = [
      { name: '甲', building: 'A楼', category: 'late' },
      { name: '甲', building: 'A楼', category: 'early' },
      { name: '乙', building: 'B楼', category: 'late' },
    ];
    expect(
      (filterAttendanceHistoryItems as any)(items, 'late', {
        kind: 'person',
        value: '甲',
      }),
    ).toEqual([items[0]]);
    expect(
      (filterAttendanceHistoryItems as any)(items, 'all', {
        kind: 'building',
        value: 'B楼',
      }),
    ).toEqual([items[2]]);
  });
  it.each(['missing', 'failed'])(
    'uses authenticated photo proxy when COS is %s',
    async (mode) => {
      jest.mocked(fetchBitableRecords).mockResolvedValue(records);
      const storage =
        mode === 'missing'
          ? undefined
          : {
              getStored: jest
                .fn()
                .mockRejectedValue(new Error('COS unavailable')),
            };
      const gateway = new AttendanceAutomationFeishuGateway(
        { axiosRef: { get: jest.fn() } } as never,
        storage as never,
      );
      await expect(
        gateway.readCorrectionEvidence(query),
      ).resolves.toMatchObject({
        syncState: 'ready',
        imageCount: 1,
        images: [{ transport: 'proxy', url: '' }],
      });
    },
  );
  it('filters history remotely by work dates instead of reading the whole table', async () => {
    jest.mocked(fetchBitableRecords).mockResolvedValue([]);
    const gateway = new AttendanceAutomationFeishuGateway({} as never);
    await gateway.readArchivedAttendancePeriod('2026-10-01', '2026-10-10');
    expect(fetchBitableRecords).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        filter: {
          conjunction: 'and',
          conditions: expect.arrayContaining([
            expect.objectContaining({
              field_name: '工作日期',
              operator: 'isGreater',
            }),
            expect.objectContaining({
              field_name: '工作日期',
              operator: 'isLess',
            }),
          ]),
        },
      }),
    );
  });
});
