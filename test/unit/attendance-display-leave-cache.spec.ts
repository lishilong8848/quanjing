jest.mock('@server/common/feishu/leave-approval-source', () => ({
  ...jest.requireActual('@server/common/feishu/leave-approval-source'),
  readCachedLeaveApprovalSnapshotState: jest.fn(),
  fetchLeaveApprovalSnapshot: jest.fn(),
}));

import {
  readCachedLeaveApprovalSnapshotState,
  fetchLeaveApprovalSnapshot,
} from '../../server/common/feishu/leave-approval-source';
import { AttendanceAutomationFeishuGateway } from '../../server/modules/duty-schedule/attendance-automation-feishu.gateway';

describe('attendance display leave cache', () => {
  const leave = { recordId: 'leave-fixture', leaveStaff: ['测试甲'] };
  beforeEach(() => jest.clearAllMocks());

  it('returns a recent verified local approval without waiting on a remote request', async () => {
    jest.mocked(readCachedLeaveApprovalSnapshotState).mockResolvedValue({
      snapshot: { verified: true, requests: [leave as any] },
      approvalFetchedAt: Date.now(),
      shiftDetailFetchedAt: Date.now(),
    });
    const gateway = new AttendanceAutomationFeishuGateway({} as never);
    await expect(
      (gateway as any).readApprovedAttendanceLeaveForDisplay(),
    ).resolves.toEqual([leave]);
    expect(fetchLeaveApprovalSnapshot).not.toHaveBeenCalled();
  });

  it.each(['expired', 'unverified', 'expired-details'])(
    'strictly refreshes %s cache instead of trusting it',
    async (state) => {
      jest.mocked(readCachedLeaveApprovalSnapshotState).mockResolvedValue({
        snapshot: {
          verified: state !== 'unverified',
          requests: [leave as any],
        },
        approvalFetchedAt: Date.now() - (state === 'expired' ? 60_001 : 0),
        shiftDetailFetchedAt:
          Date.now() - (state === 'expired-details' ? 60_001 : 0),
      });
      jest
        .mocked(fetchLeaveApprovalSnapshot)
        .mockResolvedValue({ verified: true, requests: [] });
      const gateway = new AttendanceAutomationFeishuGateway({} as never);
      await expect(
        (gateway as any).readApprovedAttendanceLeaveForDisplay(),
      ).resolves.toEqual([]);
      expect(fetchLeaveApprovalSnapshot).toHaveBeenCalledWith(
        expect.anything(),
        { forceRefresh: true, strict: true },
      );
    },
  );

  it('does not weaken the forced verification for automated notifications', async () => {
    jest
      .mocked(fetchLeaveApprovalSnapshot)
      .mockRejectedValue(new Error('approval unavailable'));
    const gateway = new AttendanceAutomationFeishuGateway({} as never);
    await expect(gateway.readApprovedAttendanceLeave()).rejects.toThrow(
      'approval unavailable',
    );
    expect(readCachedLeaveApprovalSnapshotState).not.toHaveBeenCalled();
  });
});
