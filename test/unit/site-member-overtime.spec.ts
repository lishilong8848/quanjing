import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';
import { DutyScheduleController } from '../../server/modules/duty-schedule/duty-schedule.controller';
import type { AccessPrincipal } from '../../shared/access-control.interface';

const principal: AccessPrincipal = { role: 'site_member', purchaseBuilding: null, accountId: `feishu-${'a'.repeat(64)}`, displayName: '验收成员甲', authorizationVersion: 1 };
const payload = { clientMutationId: 'overtime-request-member-test', staffName: principal.displayName!, reason: '代表性加班申请' };

describe('成员加班只能为本人申请', () => {
  it('110公共账号在任何写入前按所选人员核验站内关联，不使用公共账号名称', async () => {
    const station = { ...principal, displayName: '南通基地-110kV变电站值班' };
    const identity = jest.fn().mockRejectedValue(new Error('站内稳定身份核验'));
    const writes = jest.fn();
    const service = Object.assign(Object.create(DutyScheduleService.prototype), {
      resolveLeaveRequestStaff: identity, validateOvertimeRequestScreenshot: writes,
      withOvertimeRequestMutationIdempotency: writes,
    });
    await expect(service.createOvertimeRequest({ ...payload, staffName: '站内示例人员003' }, undefined, station))
      .rejects.toThrow('站内稳定身份核验');
    expect(identity).toHaveBeenCalledWith('站内示例人员003', undefined, station);
    expect(writes).not.toHaveBeenCalled();
  });
  it('控制器拒绝他人姓名，本人稳定身份传给服务，其他角色调用保持原样', async () => {
    const create = jest.fn().mockResolvedValue({ success: true });
    const controller = Object.assign(Object.create(DutyScheduleController.prototype), { dutyScheduleService: { createOvertimeRequest: create }, overtimeWorkflowService: { isEnabled: () => false } });
    await expect(controller.createOvertimeRequest(JSON.stringify({ ...payload, staffName: '其他成员' }), [], { accessPrincipal: principal, accessPrincipalFingerprint: 'synthetic-identity' })).rejects.toThrow('当前登录本人');
    expect(create).not.toHaveBeenCalled();
    await controller.createOvertimeRequest(JSON.stringify(payload), [], { accessPrincipal: principal, accessPrincipalFingerprint: 'synthetic-identity' });
    expect(create).toHaveBeenLastCalledWith(payload, undefined, principal);
    await controller.createOvertimeRequest(JSON.stringify(payload), [], { accessPrincipal: { role: 'admin', purchaseBuilding: null, accountId: 'local-admin' }, accessPrincipalFingerprint: 'trusted-legacy' });
    expect(create).toHaveBeenLastCalledWith(payload, undefined);
  });
  it('服务在上传、幂等重放或任何写入前核对人员记录身份', async () => {
    const identity = jest.fn().mockRejectedValue(new Error('稳定人员记录不匹配'));
    const writes = jest.fn();
    const service = Object.assign(Object.create(DutyScheduleService.prototype), { resolveLeaveRequestStaff: identity, validateOvertimeRequestScreenshot: writes, withOvertimeRequestMutationIdempotency: writes });
    await expect(service.createOvertimeRequest({ ...payload, staffName: '其他成员' }, undefined, principal)).rejects.toThrow('当前登录本人');
    expect(identity).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    await expect(service.createOvertimeRequest(payload, undefined, principal)).rejects.toThrow('稳定人员记录不匹配');
    expect(identity).toHaveBeenCalledWith(principal.displayName, undefined, principal); expect(writes).not.toHaveBeenCalled();
  });
});
