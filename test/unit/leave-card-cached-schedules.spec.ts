jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
}));
jest.mock('../../server/common/feishu/leave-approval-source', () => ({
  ...jest.requireActual('../../server/common/feishu/leave-approval-source'),
  fetchLeaveApprovalSnapshot: jest.fn(),
  readCachedLeaveApprovalSnapshotState: jest.fn(),
}));

import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';
import { fetchBitableRecords, readLatestPersistedBitableRecordSnapshot } from '../../server/common/feishu/bitable-direct-read';
import { fetchLeaveApprovalSnapshot, readCachedLeaveApprovalSnapshotState } from '../../server/common/feishu/leave-approval-source';

describe('leave card schedule validation stays on persisted snapshots', () => {
  const persisted = jest.mocked(readLatestPersistedBitableRecordSnapshot);
  const cachedApproval = jest.mocked(readCachedLeaveApprovalSnapshotState);
  const cloudApproval = jest.mocked(fetchLeaveApprovalSnapshot);
  const cloudRecords = jest.mocked(fetchBitableRecords);
  let service: BitableSyncService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = Object.assign(Object.create(BitableSyncService.prototype), {
      NON_DUTY_APP_TOKEN: 'app_test', NON_DUTY_TABLE_ID: 'tbl_nonduty',
      SCHEDULE_APP_TOKEN: 'app_test', SCHEDULE_TABLE_ID: 'tbl_schedule',
    });
    persisted.mockImplementation(async options => ({
      fetchedAt: Date.now(), expiresAt: Date.now() + 60_000,
      records: options.tableId === 'tbl_schedule' ? [{ record_id: 'rec_test', fields: {
        排班日期: '2026-10-28', 楼栋: 'C楼', 班次: '白班', 班组: 'C班',
        '值班人员（实际）程序修改': 'TEST', 人员文本: 'TEST', 请假人员: 'TEST',
      } }] : [],
    }));
    cachedApproval.mockResolvedValue({ snapshot: { verified: true, requests: [] }, approvalFetchedAt: Date.now(), shiftDetailFetchedAt: null });
    cloudApproval.mockResolvedValue({ verified: true, requests: [] });
    cloudRecords.mockResolvedValue([]);
  });

  it('uses one local approval projection and both local schedules without cloud calls', async () => {
    const rows = await service.getCachedLeaveRequestImpactSchedules('2026-10-28', '2026-10-28');
    expect(cloudRecords).not.toHaveBeenCalled();
    expect(cloudApproval).not.toHaveBeenCalled();
    expect(cachedApproval).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveBeenCalledTimes(2);
    expect(rows.map(row => row.recordId)).toEqual(['rec_test']);
  });

  it('fails closed when the local approval projection is missing or expired', async () => {
    cachedApproval.mockResolvedValue({ snapshot: { verified: false, requests: [] }, approvalFetchedAt: null, shiftDetailFetchedAt: null });
    await expect(service.getCachedLeaveRequestImpactSchedules('2026-10-28', '2026-10-28')).rejects.toThrow(/审批.*缓存/);
    expect(cloudApproval).not.toHaveBeenCalled();
  });

  it('preserves the actual roster instead of overwriting it with an approval summary', async () => {
    cachedApproval.mockResolvedValue({
      snapshot: { verified: true, requests: [{
        recordId: 'rec_leave_test', leaveStaff: ['TEST'], substituteStaff: ['TEST_BACKUP'],
        startAt: '2026-10-28 09:00', endAt: '2026-10-28 18:00',
        building: 'C楼', team: 'C班', shift: '白班', impactedScheduleRecordIds: ['rec_test'],
      }] }, approvalFetchedAt: Date.now(), shiftDetailFetchedAt: null,
    });
    const rows = await service.getCachedLeaveRequestImpactSchedules('2026-10-28', '2026-10-28');
    expect(rows[0].dutyStaffActual).toEqual(['TEST']);
    expect(cloudApproval).not.toHaveBeenCalled();
  });

  it('does not treat a missing schedule snapshot as an empty working roster', async () => {
    persisted.mockResolvedValue(null);
    await expect(service.getCachedLeaveRequestImpactSchedules('2026-10-28', '2026-10-28')).rejects.toThrow(/排班.*缓存/);
    expect(cloudRecords).not.toHaveBeenCalled();
  });

  it('retains invalid-range rejection before any reads', async () => {
    await expect(service.getCachedLeaveRequestImpactSchedules('2026-10-29', '2026-10-28')).rejects.toThrow(/范围无效/);
    expect(persisted).not.toHaveBeenCalled();
    expect(cloudRecords).not.toHaveBeenCalled();
  });

  it('projects approval state only onto the requested dates, not the historical roster', async () => {
    const approval = require('../../server/common/feishu/leave-approval-source');
    const enrich = jest.spyOn(approval, 'enrichScheduleRecordsWithLeaveApproval');
    const historic = Array.from({ length: 10_000 }, (_, i) => ({
      record_id: `rec_history_${i}`, fields: { 排班日期: '2025-10-28', 班次: '白班', 楼栋: 'C楼' },
    }));
    const current = { record_id: 'rec_current', fields: {
      排班日期: '2026-10-28', 班次: '白班', 楼栋: 'C楼', '值班人员（实际）程序修改': 'TEST',
    } };
    persisted.mockImplementation(async options => ({
      fetchedAt: Date.now(), expiresAt: Date.now() + 60_000,
      records: options.tableId === 'tbl_schedule' ? [...historic, current] : historic,
    }));
    try {
      const rows = await service.getCachedLeaveRequestImpactSchedules('2026-10-28', '2026-10-28');
      expect(rows.map(row => row.recordId)).toEqual(['rec_current']);
      expect(enrich.mock.calls.map(([records]) => records.length)).toEqual([0, 1]);
    } finally { enrich.mockRestore(); }
  });

  it('retains both adjacent boundary days, timestamp aliases and the next fresh personnel change', async () => {
    let name = 'TEST';
    persisted.mockImplementation(async options => ({
      fetchedAt: Date.now(), expiresAt: Date.now() + 60_000,
      records: options.tableId === 'tbl_schedule' ? [
        { record_id: 'rec_before', fields: { 日期: '2026-10-14', 班次: '夜班', 楼栋: 'C楼' } },
        { record_id: 'rec_start', fields: { fldZSaDbGf: Date.parse('2026-10-15T00:00:00+08:00'), 班次: '夜班', 楼栋: 'C楼', '值班人员（实际）程序修改': name } },
        { record_id: 'rec_end', fields: { 日期: '2026-10-17', 班次: '白班', 楼栋: 'C楼', '值班人员（实际）程序修改': name } },
        { record_id: 'rec_after', fields: { 日期: '2026-10-18', 班次: '白班', 楼栋: 'C楼' } },
      ] : [{ record_id: 'rec_white', fields: { schedule_date: '2026-10-16', 班次: '长白', 楼栋: 'C楼', '值班人员（实际）程序修改': name } }],
    }));
    const first = await service.getCachedLeaveRequestImpactSchedules('2026-10-15', '2026-10-17');
    expect(first.map(row => row.recordId)).toEqual(['rec_start', 'rec_white', 'rec_end']);
    expect(first.every(row => row.dutyStaffActual.includes('TEST'))).toBe(true);
    name = 'CHANGED';
    const next = await service.getCachedLeaveRequestImpactSchedules('2026-10-15', '2026-10-17');
    expect(next.every(row => row.dutyStaffActual.includes('CHANGED'))).toBe(true);
  });
});
