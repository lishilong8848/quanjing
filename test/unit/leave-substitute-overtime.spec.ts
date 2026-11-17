import { LeaveSubstituteOvertimeService } from '../../server/modules/leave-workflow/leave-substitute-overtime.service';
import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';
import type { LeaveWorkflowApplicationEntry, LeaveWorkflowTaskEntry } from '../../server/modules/leave-workflow/leave-workflow.store';
import type { OvertimeBitableRecord } from '../../server/modules/overtime-workflow/overtime-workflow.gateway';
import { OvertimeWorkflowService } from '../../server/modules/overtime-workflow/overtime-workflow.service';

const date = '2026-11-17';
const at = (hour: number) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`);
const shift = (openId = 'ou_sub') => ({
  substituteOpenId: openId, substituteName: openId === 'ou_sub' ? '替班甲' : '替班乙',
  startAt: new Date(at(9)).toISOString(), endAt: new Date(at(21)).toISOString(),
});

function application(revision = 1, openId = 'ou_sub') {
  return {
    recordId: 'recLeave', status: 'approved',
    snapshot: { ...shift(openId), assignmentRevision: revision, shiftAssignments: [shift(openId)] },
  } as unknown as LeaveWorkflowApplicationEntry;
}

function fixture() {
  const rows: OvertimeBitableRecord[] = [];
  const bitable = {
    readSubstituteOvertimePersonnel: jest.fn().mockResolvedValue([
      { openId: 'ou_sub', name: '替班甲', buildings: ['A楼'], shift: '长白', position: '值班员' },
      { openId: 'ou_next', name: '替班乙', buildings: ['A楼'], shift: '长白', position: '值班员' },
    ]),
    getCachedLeaveRequestImpactSchedules: jest.fn().mockResolvedValue(
      ['2026-11-16', date].map(scheduleDate => ({ scheduleDate, dutyStaffActual: [], recordId: 'recSchedule' })),
    ),
  };
  const leave = { readLeaveRecordIfExists: jest.fn().mockResolvedValue({
    fields: { 请假工作流状态: '已审批', 休假开始时间: at(9), 休假结束时间: at(21) },
  }) };
  const overtime = {
    readSubstitutionOvertimeRecords: jest.fn(async () => structuredClone(rows)),
    createSubstitutionOvertimeRecord: jest.fn(async (fields: Record<string, unknown>) => {
      const recordId = `recAuto${rows.length + 1}`;
      rows.push({ recordId, fields });
      return recordId;
    }),
    readOvertimeRecord: jest.fn(async (recordId: string) => rows.find(row => row.recordId === recordId)),
    updateOvertimeRecord: jest.fn(async (recordId: string, fields: Record<string, unknown>) => {
      const row = rows.find(entry => entry.recordId === recordId);
      if (row) Object.assign(row.fields, fields);
    }),
  };
  const workflow = {
    isEnabled: jest.fn().mockReturnValue(true),
    acceptSubstitutionApplication: jest.fn(),
    retireSubstitutionApplication: jest.fn(async (recordId: string) => {
      const row = rows.find(entry => entry.recordId === recordId);
      if (row) row.fields.加班工作流状态 = '已驳回';
    }),
  };
  const store = { listApplications: jest.fn(async () => rows.map(row => ({
    clientMutationId: row.fields.请求唯一ID,
  }))) };
  const service = new LeaveSubstituteOvertimeService(bitable as never, leave as never, overtime as never, workflow as never, store as never);
  return { service, rows, bitable, leave, overtime, workflow };
}

describe('leave substitution generates pending overtime applications', () => {
  it('subtracts the substitute’s normal hours and existing applications, and reuses the written record on retry', async () => {
    const { service, rows, overtime, workflow, bitable } = fixture();
    rows.push({ recordId: 'recManual', fields: {
      加班人员: [{ id: 'ou_sub' }], 加班人员姓名: '替班甲',
      加班工作流状态: '待路由', 加班开始时间: at(18), 加班结束时间: at(19),
    } });
    await service.sync(application(), 1);
    await service.sync(application(), 1);
    expect(overtime.createSubstitutionOvertimeRecord).toHaveBeenCalledTimes(1);
    expect(rows[1].fields).toMatchObject({ 加班开始时间: at(19), 加班结束时间: at(21), 加班时长: 2 });
    expect(workflow.acceptSubstitutionApplication.mock.calls[0][1]).toMatchObject({ applicantOpenId: 'ou_sub', plannedHours: 2 });
    expect(bitable.getCachedLeaveRequestImpactSchedules).toHaveBeenCalledWith('2026-11-16', date, expect.objectContaining({ originalOnly: true }));
  });

  it('retires the old generated application on reassignment and does not retire an unrelated manual row', async () => {
    const { service, overtime, workflow, rows, leave } = fixture();
    await service.sync(application(), 1);
    const old = rows[0];
    await service.sync(application(2, 'ou_next'), 2);
    expect(workflow.retireSubstitutionApplication).toHaveBeenCalledWith(old.recordId, old.fields.请求唯一ID);
    expect(overtime.createSubstitutionOvertimeRecord).toHaveBeenCalledTimes(2);
    expect(rows[1].fields.加班人员).toEqual([{ id: 'ou_next' }]);
    leave.readLeaveRecordIfExists.mockResolvedValueOnce(null);
    await service.reconcileChangedSources([application(2, 'ou_next')], async () => application(2, 'ou_next'));
    expect(workflow.retireSubstitutionApplication).toHaveBeenLastCalledWith(rows[1].recordId, rows[1].fields.请求唯一ID);
  });

  it('fails closed on incomplete original schedules and never treats a source outage as withdrawal', async () => {
    const { service, bitable, overtime, leave, workflow } = fixture();
    bitable.getCachedLeaveRequestImpactSchedules.mockResolvedValueOnce([]);
    await expect(service.sync(application(), 1)).rejects.toThrow('原始排班');
    leave.readLeaveRecordIfExists.mockRejectedValueOnce(new Error('upstream unavailable'));
    await expect(service.sync(application(), 1)).rejects.toThrow('upstream unavailable');
    expect(overtime.createSubstitutionOvertimeRecord).not.toHaveBeenCalled();
    expect(workflow.retireSubstitutionApplication).not.toHaveBeenCalled();
  });

  it('retains approved overtime for review when the leave source time changes', async () => {
    const { service, leave, rows, workflow, overtime } = fixture();
    await service.sync(application(), 1);
    rows[0].fields.加班工作流状态 = '已审批';
    leave.readLeaveRecordIfExists.mockResolvedValue({ fields: {
      请假工作流状态: '已审批', 休假开始时间: at(9), 休假结束时间: at(20),
    } });
    await service.sync(application(), 1);
    expect(workflow.retireSubstitutionApplication).not.toHaveBeenCalled();
    expect(overtime.updateOvertimeRecord).toHaveBeenCalledWith(rows[0].recordId, { 加班工作流错误: expect.stringContaining('人工核对') });
  });

  it('replaces pending overtime with the times from the newly synchronized revision', async () => {
    const { service, leave, rows, workflow, overtime } = fixture();
    const revised = application(2);
    revised.snapshot.endAt = new Date(at(20)).toISOString();
    await service.sync(application(), 1);
    leave.readLeaveRecordIfExists.mockResolvedValue({ fields: {
      请假工作流状态: '已审批', 休假开始时间: at(9), 休假结束时间: at(20),
    } });
    await service.sync(revised, 2);
    await service.sync(revised, 2);
    expect(workflow.retireSubstitutionApplication).toHaveBeenCalledTimes(1);
    expect(overtime.createSubstitutionOvertimeRecord).toHaveBeenCalledTimes(2);
    expect(rows[1].fields).toMatchObject({ 加班开始时间: at(18), 加班结束时间: at(20), 加班时长: 2 });
  });

  it('creates only the uncovered extension when a previously approved time is extended', async () => {
    const { service, leave, rows, workflow } = fixture();
    await service.sync(application(), 1);
    rows[0].fields.加班工作流状态 = '已审批';
    const revised = application(2);
    revised.snapshot.endAt = new Date(at(22)).toISOString();
    revised.snapshot.shiftAssignments![0].endAt = revised.snapshot.endAt;
    leave.readLeaveRecordIfExists.mockResolvedValue({ fields: {
      请假工作流状态: '已审批', 休假开始时间: at(9), 休假结束时间: at(22),
    } });
    await service.sync(revised, 2);
    expect(workflow.retireSubstitutionApplication).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
    expect(rows[1].fields).toMatchObject({ 加班开始时间: at(21), 加班结束时间: at(22), 加班时长: 1 });
  });

  it('recovers a successful write with a lost response without creating a second application', async () => {
    const { service, rows, overtime, workflow } = fixture();
    overtime.createSubstitutionOvertimeRecord.mockImplementationOnce(async fields => {
      rows.push({ recordId: 'recLostResponse', fields });
      throw new Error('write response lost');
    });
    await expect(service.sync(application(), 1)).rejects.toThrow('write response lost');
    await service.sync(application(), 1);
    expect(overtime.createSubstitutionOvertimeRecord).toHaveBeenCalledTimes(1);
    expect(workflow.acceptSubstitutionApplication.mock.calls[0][1]).toMatchObject({ recordId: 'recLostResponse' });
  });

  it('retries a withdrawn approval card without rewriting the already withdrawn source', async () => {
    const id = 'overtime-request-leave-123-revision';
    const fields = { 请求唯一ID: id, 加班工作流状态: '待审批', 加班工作流错误: '' };
    const row = { recordId: 'recAuto', fields };
    const entry = {
      recordId: row.recordId, clientMutationId: id,
      snapshot: { recordId: row.recordId, applicantName: '替班甲', plannedStartAt: new Date(at(18)).toISOString(),
        plannedEndAt: new Date(at(21)).toISOString(), plannedHours: 3, reason: '请休假替班自动申请' },
      approvalCards: [{ messageId: 'om_approval' }], sourceDeletedCardPatches: [], managerNoticeCards: [],
      confirmationCards: [], confirmationResultCards: [],
    };
    const store = {
      getApplication: jest.fn().mockResolvedValue(entry), markSourceDeleted: jest.fn().mockResolvedValue(entry),
      markSourceDeletedCardPatched: jest.fn(), patchApplication: jest.fn(),
    };
    const gateway = {
      readOvertimeRecordIfExists: jest.fn().mockResolvedValue(row), readOvertimeRecord: jest.fn().mockResolvedValue(row),
      updateOvertimeRecord: jest.fn(async (_id, update) => { Object.assign(fields, update); }),
      patchInteractiveCard: jest.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(undefined),
    };
    const service = new OvertimeWorkflowService(store as never, gateway as never, {} as never);
    jest.spyOn(service, 'isEnabled').mockReturnValue(true);
    await expect(service.retireSubstitutionApplication(row.recordId, id)).rejects.toThrow('旧审批卡终态尚未同步');
    expect(fields.加班工作流状态).toBe('已驳回');
    await service.retireSubstitutionApplication(row.recordId, id);
    expect(gateway.updateOvertimeRecord).toHaveBeenCalledTimes(1);
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(2);
    expect(store.patchApplication).toHaveBeenCalledWith(row.recordId, { lastError: '' });
  });

  it('only queues automatic overtime after a successful approved schedule write', async () => {
    const leave = application();
    leave.snapshot.shiftAssignments![0].scheduleRecordIds = ['recSchedule'];
    const store = { getApplication: jest.fn().mockResolvedValue(leave), enqueueTask: jest.fn() };
    const sync = jest.fn().mockRejectedValueOnce(new Error('schedule unavailable')).mockResolvedValueOnce({});
    const auto = { sync: jest.fn() };
    const service = new LeaveWorkflowService(store as never, {} as never,
      { syncApprovedLeaveScheduleSnapshot: sync } as never, undefined, undefined, auto as never);
    const task = { recordId: leave.recordId, payload: { revision: 1 } } as LeaveWorkflowTaskEntry;
    await expect(service['syncApprovedLeaveSchedule'](task)).rejects.toThrow('schedule unavailable');
    expect(store.enqueueTask).not.toHaveBeenCalled();
    await service['syncApprovedLeaveSchedule'](task);
    expect(store.enqueueTask).toHaveBeenCalledWith({
      businessKey: 'leave:recLeave:substitute-overtime:1', kind: 'sync_substitute_overtime',
      recordId: 'recLeave', payload: { revision: 1 },
    });
    await service['syncSubstituteOvertime']({ ...task, payload: { revision: 0 } });
    expect(auto.sync).not.toHaveBeenCalled();
    await service['syncSubstituteOvertime'](task);
    expect(auto.sync).toHaveBeenCalledWith(leave, 1);
  });
});
