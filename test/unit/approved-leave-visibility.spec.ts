import {
  isLeaveRequestApprovalComplete,
  resolveApprovalAwareDutyStaffFromFields,
  resolveApprovedLeaveVisibility,
  resolveApprovedLeaveVisibilityFromFields,
} from '../../server/modules/duty-schedule/approved-leave-visibility';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('approved leave visibility', () => {
  it('hides pending leave and substitute staff', () => {
    expect(
      resolveApprovedLeaveVisibility({
        rawLeaveStaff: ['张三'],
        rawSubstituteStaff: ['李四'],
        approvedLeaveStaff: [],
      }),
    ).toEqual({
      leaveStaff: [],
      substituteStaff: [],
      allRawLeaveApproved: false,
      rawLeaveStaff: ['张三'],
      rawSubstituteStaff: ['李四'],
      hasUnapprovedLeave: true,
    });
  });

  it('shows leave and substitute staff after every leave is approved', () => {
    expect(
      resolveApprovedLeaveVisibility({
        rawLeaveStaff: ['张三'],
        rawSubstituteStaff: ['李四'],
        approvedLeaveStaff: ['张三'],
      }),
    ).toEqual({
      leaveStaff: ['张三'],
      substituteStaff: ['李四'],
      allRawLeaveApproved: true,
      rawLeaveStaff: ['张三'],
      rawSubstituteStaff: ['李四'],
      hasUnapprovedLeave: false,
    });
  });

  it('filters the no-substitute sentinel at the approval visibility boundary', () => {
    expect(
      resolveApprovedLeaveVisibility({
        rawLeaveStaff: ['杨煜文'],
        rawSubstituteStaff: ['无需替班'],
        approvedLeaveStaff: ['杨煜文'],
        approvedSubstituteStaff: ['无需替班'],
      }),
    ).toMatchObject({
      rawSubstituteStaff: [],
      substituteStaff: [],
    });
  });

  it('fails closed for substitutes when a record mixes approved and pending leave', () => {
    expect(
      resolveApprovedLeaveVisibility({
        rawLeaveStaff: ['张三', '王五'],
        rawSubstituteStaff: ['李四', '赵六'],
        approvedLeaveStaff: ['张三'],
      }),
    ).toEqual({
      leaveStaff: ['张三'],
      substituteStaff: [],
      allRawLeaveApproved: false,
      rawLeaveStaff: ['张三', '王五'],
      rawSubstituteStaff: ['李四', '赵六'],
      hasUnapprovedLeave: true,
    });
  });

  it('never exposes stale approved-helper names when the raw leave field is empty', () => {
    expect(
      resolveApprovedLeaveVisibility({
        rawLeaveStaff: [],
        rawSubstituteStaff: ['替班甲'],
        approvedLeaveStaff: ['陈旧请假人'],
      }),
    ).toEqual({
      leaveStaff: [],
      substituteStaff: [],
      allRawLeaveApproved: false,
      rawLeaveStaff: [],
      rawSubstituteStaff: ['替班甲'],
      hasUnapprovedLeave: false,
    });
  });

  it('only exposes the intersection of raw and approved leave names', () => {
    expect(
      resolveApprovedLeaveVisibility({
        rawLeaveStaff: ['请假甲'],
        rawSubstituteStaff: ['替班甲'],
        approvedLeaveStaff: ['请假甲', '2026-08-10~2026-08-11', '其他人员'],
      }),
    ).toEqual({
      leaveStaff: ['请假甲'],
      substituteStaff: ['替班甲'],
      allRawLeaveApproved: true,
      rawLeaveStaff: ['请假甲'],
      rawSubstituteStaff: ['替班甲'],
      hasUnapprovedLeave: false,
    });
  });

  it('can expose only substitutes proven by approved requests on mixed records', () => {
    expect(
      resolveApprovedLeaveVisibility({
        rawLeaveStaff: ['请假甲', '请假乙'],
        rawSubstituteStaff: ['替班甲', '替班乙'],
        approvedLeaveStaff: ['请假甲'],
        approvedSubstituteStaff: ['替班甲'],
      }),
    ).toEqual({
      leaveStaff: ['请假甲'],
      substituteStaff: ['替班甲'],
      allRawLeaveApproved: false,
      rawLeaveStaff: ['请假甲', '请假乙'],
      rawSubstituteStaff: ['替班甲', '替班乙'],
      hasUnapprovedLeave: true,
    });
  });

  it('does not expose a stale raw substitute when the verified approval source returns none', () => {
    expect(
      resolveApprovedLeaveVisibility({
        rawLeaveStaff: ['请假甲'],
        rawSubstituteStaff: ['陈旧替班人'],
        approvedLeaveStaff: ['请假甲'],
        approvedSubstituteStaff: [],
      }),
    ).toMatchObject({
      leaveStaff: ['请假甲'],
      substituteStaff: [],
      allRawLeaveApproved: true,
      hasUnapprovedLeave: false,
    });
  });

  it('reads the approved helper field and normalizes formula text', () => {
    expect(
      resolveApprovedLeaveVisibilityFromFields({
        fld4xMPICY: '张三、王五',
        fldZnstUS3: '李四，赵六',
        __systemLeaveApprovalVerified: true,
        __systemApprovedLeaveStaff: ' 王五 / 张三 ',
        __systemApprovedSubstituteStaff: '李四，赵六',
      }),
    ).toEqual({
      leaveStaff: ['张三', '王五'],
      substituteStaff: ['李四', '赵六'],
      allRawLeaveApproved: true,
      rawLeaveStaff: ['张三', '王五'],
      rawSubstituteStaff: ['李四', '赵六'],
      hasUnapprovedLeave: false,
    });
  });

  it('restores the planned staff while a leave request is pending', () => {
    expect(
      resolveApprovalAwareDutyStaffFromFields({
        '人员（文本）': '张三 王五',
        '值班人员（实际）程序修改': '李四 王五',
        请假人员: '张三',
        替班人员: '李四',
        __systemLeaveApprovalVerified: true,
        __systemApprovedLeaveStaff: [],
        __systemApprovedSubstituteStaff: [],
      }).dutyStaff,
    ).toEqual(['张三', '王五']);
  });

  it('fails closed for actual substitutes on mixed approval records', () => {
    expect(
      resolveApprovalAwareDutyStaffFromFields({
        '人员（文本）': '张三 王五 周六',
        '值班人员（实际）程序修改': '李四 赵六 周六',
        请假人员: '张三 王五',
        替班人员: '李四 赵六',
        __systemLeaveApprovalVerified: true,
        __systemApprovedLeaveStaff: '张三',
        __systemApprovedSubstituteStaff: [],
      }).dutyStaff,
    ).toEqual(['王五', '周六']);
  });

  it('removes business travelers from actual duty staff even when no leave request exists', () => {
    expect(
      resolveApprovalAwareDutyStaffFromFields({
        '人员（文本）': '张三 王五',
        '值班人员（实际）程序修改': '张三 王五',
        差旅人员: '张三',
      }).dutyStaff,
    ).toEqual(['王五']);
  });

  it('only treats the explicit approval-complete state as approved', () => {
    expect(isLeaveRequestApprovalComplete({ fld1k05IQ9: '审批结束' })).toBe(
      true,
    );
    expect(isLeaveRequestApprovalComplete({ 审批进度: '审批中' })).toBe(false);
    expect(
      isLeaveRequestApprovalComplete({ 系统审批完成标记: '审批结束' }),
    ).toBe(true);
    expect(
      isLeaveRequestApprovalComplete({
        系统审批完成标记: [{ text: '审批结束' }],
      }),
    ).toBe(true);
    expect(isLeaveRequestApprovalComplete({ 系统审批完成标记: '审批中' })).toBe(
      false,
    );
    expect(isLeaveRequestApprovalComplete({})).toBe(false);
  });

  it('uses approval-aware records across every public schedule feed', () => {
    const dutySource = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-schedule.service.ts',
      ),
      'utf8',
    );
    const bitableSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/bitable-sync/bitable-sync.service.ts',
      ),
      'utf8',
    );
    const kpiSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/bitable-sync/today-operations-kpi.service.ts',
      ),
      'utf8',
    );

    expect(dutySource).toContain('requiresApprovalAwareScheduleSourceRead');
    expect(dutySource).toContain('fetchLeaveApprovalSnapshot');
    expect(dutySource).toContain('enrichScheduleRecordsWithLeaveApproval');
    expect(dutySource).toContain('resolveApprovalAwareDutyStaffFromFields');
    expect(dutySource).toContain('isLeaveRequestApprovalComplete');
    expect(bitableSource).toContain('requiresApprovalAwareLeaveSourceRead');
    expect(bitableSource).toContain('fetchLeaveApprovalSnapshot');
    expect(bitableSource).toContain('enrichScheduleRecordsWithLeaveApproval');
    expect(bitableSource).toContain('resolveApprovalAwareDutyStaffFromFields');
    expect(kpiSource).toContain('fetchLeaveApprovalSnapshot');
    expect(kpiSource).toContain('enrichScheduleRecordsWithLeaveApproval');
    expect(kpiSource).toContain('resolveApprovalAwareDutyStaffFromFields');
  });
});
