import { DutyScheduleController } from '../../server/modules/duty-schedule/duty-schedule.controller';
import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { publicSubmitterId } from '../../server/modules/bitable-sync/change-request-submitter-directory';

const accounts: AccessPrincipal[] = [
  { role: 'admin', purchaseBuilding: null, accountId: 'feishu-' + 'a'.repeat(64), displayName: '验收员工甲' },
  { role: 'guest', purchaseBuilding: null, accountId: 'local-external-' + 'b'.repeat(64), displayName: '验收员工甲' },
];
const identityRequest = (principal: AccessPrincipal) => ({ accessPrincipal: principal, accessPrincipalFingerprint: 'trusted-fixture' });

describe('加班与变更使用登录本人', () => {
  it.each(accounts)('加班控制器拒绝 $accountId 代他人提交', async principal => {
    const create = jest.fn().mockResolvedValue({ success: true });
    const controller = Object.assign(Object.create(DutyScheduleController.prototype), {
      dutyScheduleService: { createOvertimeRequest: create }, overtimeWorkflowService: { isEnabled: () => false },
    });
    await expect(controller.createOvertimeRequest(JSON.stringify({ staffName: '示例人员004员' }), [], identityRequest(principal)))
      .rejects.toThrow('当前登录本人');
    expect(create).not.toHaveBeenCalled();
  });

  it.each(accounts)('加班服务在截图和重放前校验 $accountId 稳定身份', async principal => {
    const identity = jest.fn().mockRejectedValue(new Error('稳定身份不匹配'));
    const writes = jest.fn();
    const service = Object.assign(Object.create(DutyScheduleService.prototype), {
      resolveLeaveRequestStaff: identity, validateOvertimeRequestScreenshot: writes,
      withOvertimeRequestMutationIdempotency: writes,
    });
    await expect(service.createOvertimeRequest({ staffName: principal.displayName }, undefined, principal))
      .rejects.toThrow('稳定身份不匹配');
    expect(identity).toHaveBeenCalledWith(principal.displayName, undefined, principal);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(accounts)('变更控制器拒绝 $accountId 改名，且不暂存附件', async principal => {
    const create = jest.fn().mockResolvedValue({ success: true });
    const stage = jest.fn();
    const controller = Object.assign(Object.create(DutyScheduleController.prototype), {
      dutyScheduleService: { createChangeRequest: create }, changeAttachmentStorage: { stageFromDisk: stage },
    });
    await expect(controller.createChangeRequest(undefined, { submitterName: '示例人员004员' }, [], identityRequest(principal)))
      .rejects.toThrow('当前登录本人');
    expect(create).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it.each(accounts)('空姓名由 $accountId 回填并传递稳定身份', async principal => {
    const overtime = jest.fn().mockResolvedValue({ success: true });
    const change = jest.fn().mockResolvedValue({ success: true });
    const controller = Object.assign(Object.create(DutyScheduleController.prototype), {
      dutyScheduleService: { createOvertimeRequest: overtime, createChangeRequest: change }, overtimeWorkflowService: { isEnabled: () => false },
    });
    await controller.createOvertimeRequest(JSON.stringify({ staffName: '' }), [], identityRequest(principal));
    expect(overtime).toHaveBeenCalledWith(expect.objectContaining({ staffName: principal.displayName }), undefined, principal);
    await controller.createChangeRequest(undefined, { submitterName: '' }, [], identityRequest(principal));
    expect(change).toHaveBeenCalledWith(expect.objectContaining({ submitterName: principal.displayName }), [], { backgroundAttachments: true, principal });
  });

  it('未登录游客不能提交加班或变更', async () => {
    const create = jest.fn();
    const controller = Object.assign(Object.create(DutyScheduleController.prototype), {
      dutyScheduleService: { createOvertimeRequest: create, createChangeRequest: create }, overtimeWorkflowService: { isEnabled: () => false },
    });
    await expect(controller.createOvertimeRequest(JSON.stringify({ staffName: '验收员工甲' }), [])).rejects.toThrow('请先登录');
    await expect(controller.createChangeRequest(undefined, { submitterName: '验收员工甲' }, [])).rejects.toThrow('请先登录');
    expect(create).not.toHaveBeenCalled();
  });

  it.each(accounts)('变更在任何业务写入前验证 $accountId 的人员关联', async principal => {
    const identity = jest.fn().mockRejectedValue(new Error('稳定身份不匹配'));
    const service = Object.assign(Object.create(DutyScheduleService.prototype), { resolveLeaveRequestStaff: identity });
    await expect(service.createChangeRequest({ submitterName: principal.displayName }, [], { principal })).rejects.toThrow('稳定身份不匹配');
    expect(identity).toHaveBeenCalledWith(principal.displayName, undefined, principal);
  });

  it('变更拒绝本人没有提交资格的人员关联', async () => {
    const principal = accounts[0];
    const service = Object.assign(Object.create(DutyScheduleService.prototype), {
      resolveLeaveRequestStaff: async () => ({ userId: 'ou_self' }),
      resolveChangeRequestSubmitter: async () => ({ userId: 'ou_self' }),
      readActiveChangeRequestUserIds: () => new Set(),
    });
    await expect(service.createChangeRequest({ submitterName: principal.displayName }, [], { principal })).rejects.toThrow('不具备变更提交资格');
  });

  it('变更将已验证人员的公开 ID 固定到后续申请内容', async () => {
    const principal = accounts[0];
    const service = Object.assign(Object.create(DutyScheduleService.prototype), {
      resolveLeaveRequestStaff: async () => ({ userId: 'ou_self' }),
      resolveChangeRequestSubmitter: async () => ({ userId: 'ou_self' }),
      readActiveChangeRequestUserIds: () => new Set(['ou_self']),
      assertChangeRequestDocumentSignatures: jest.fn(),
      normalizeChangeRequest: jest.fn(() => { throw new Error('fixture reached normalization'); }),
    });
    await expect(service.createChangeRequest({
      clientMutationId: 'change-request-9c109b77-6110-4dcf-9a63-b79aa7d3b49d', submitterName: principal.displayName,
      nature: '标准变更', changeType: '计划性变更', workType: '维护', buildings: ['A楼'], discipline: '电气', level: '低',
      summary: '隔离验收', riskSummary: '风险可控', plannedStartAt: '2026-10-12T10:00', plannedEndAt: '2026-10-12T11:00',
    }, [{ fieldname: 'documents', originalname: 'fixture.pdf', mimetype: 'application/pdf', size: 20, buffer: Buffer.from('%PDF-1.4 fixture') }], { principal })).rejects.toThrow('fixture reached normalization');
    expect(service.normalizeChangeRequest).toHaveBeenCalledWith(expect.objectContaining({ submitterId: publicSubmitterId('ou_self') }));
  });
});
