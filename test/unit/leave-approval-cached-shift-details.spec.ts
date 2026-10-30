jest.mock('../../server/common/feishu/bitable-direct-read', () => {
  const actual = jest.requireActual(
    '../../server/common/feishu/bitable-direct-read',
  );
  return {
    ...actual,
    readLatestPersistedBitableRecordSnapshot: jest.fn(),
  };
});
jest.mock('../../server/common/feishu/leave-local-projection', () => ({
  ...jest.requireActual('../../server/common/feishu/leave-local-projection'),
  readLocalLeaveProjection: jest.fn(async () => ({ fingerprint: 'synthetic', applications: new Map(), actions: new Map(), updates: new Map() })),
}));

import { readLatestPersistedBitableRecordSnapshot } from '../../server/common/feishu/bitable-direct-read';
import {
  SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD,
  enrichScheduleRecordsWithLeaveApproval,
  readCachedLeaveApprovalSnapshot,
} from '../../server/common/feishu/leave-approval-source';

const mockedReadLatestSnapshot = jest.mocked(
  readLatestPersistedBitableRecordSnapshot,
);

describe('cached leave approval shift details', () => {
  it('accepts a fresh empty approval set even when a configured detail cache does not exist', async () => {
    mockedReadLatestSnapshot.mockImplementation(async options => options.tableId === 'tbl_leave' ? { fetchedAt: Date.now(), expiresAt: Date.now() + 100000, records: [] } : null);
    await expect(readCachedLeaveApprovalSnapshot()).resolves.toEqual({ verified: true, requests: [] });
  });
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN = 'app_leave';
    process.env.FEISHU_LEAVE_SUBSTITUTE_TABLE_ID = 'tbl_leave';
    process.env.FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID = 'tbl_shift_detail';
  });

  afterEach(() => {
    delete process.env.FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN;
    delete process.env.FEISHU_LEAVE_SUBSTITUTE_TABLE_ID;
    delete process.env.FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID;
  });

  it('uses the latest per-shift substitute instead of the stale approval summary', async () => {
    const fetchedAt = Date.now();
    mockedReadLatestSnapshot
      .mockResolvedValueOnce({
        fetchedAt,
        expiresAt: fetchedAt + 15 * 60 * 1000,
        records: [
          {
            record_id: 'leave-zhou-qingqing',
            fields: {
              系统审批完成标记: '审批结束',
              '休假人员（文本）': '周庆庆',
              '替班人员（填姓名）': '陶必亮',
              替班调整版本: 1,
              系统影响排班记录ID: 'schedule-h-white',
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        fetchedAt: fetchedAt + 1,
        expiresAt: fetchedAt + 15 * 60 * 1000,
        records: [
          {
            record_id: 'shift-detail-current',
            fields: {
              状态: 'active',
              请假记录ID: 'leave-zhou-qingqing',
              班次键: '2026-09-05T09:00__2026-09-05T18:00',
              排班记录IDs: '["schedule-h-white"]',
              替班人员姓名: '陈继猛',
              替班安排版本: 1,
            },
          },
        ],
      });

    const approvalSnapshot = await readCachedLeaveApprovalSnapshot();
    const [schedule] = enrichScheduleRecordsWithLeaveApproval(
      [
        {
          record_id: 'schedule-h-white',
          fields: {
            fld4xMPICY: '周庆庆',
          },
        },
      ],
      approvalSnapshot,
    );

    expect(schedule.fields?.[SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD]).toEqual([
      '陈继猛',
    ]);
    expect(mockedReadLatestSnapshot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        appToken: 'app_leave',
        tableId: 'tbl_shift_detail',
        tableName: '请假替班班次明细',
      }),
    );
  });
});
