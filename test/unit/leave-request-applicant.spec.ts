jest.mock('../../server/modules/duty-schedule/duty-schedule.service', () => ({ DutyScheduleService: class {} }));
jest.mock('../../server/modules/duty-schedule/duty-schedule.automation', () => ({ DutyScheduleAutomationService: class {} }));
jest.mock('../../server/modules/duty-schedule/duty-screenshot.service', () => ({ DutyScreenshotService: class {} }));
jest.mock('../../server/modules/duty-schedule/typhoon-warning-monitor.service', () => ({ TyphoonWarningMonitorService: class {} }));
jest.mock('../../server/modules/overtime-workflow/overtime-workflow.service', () => ({ OvertimeWorkflowService: class {} }));
jest.mock('../../server/modules/leave-workflow/leave-workflow.service', () => ({ LeaveWorkflowService: class {} }));
import { DutyScheduleController } from '../../server/modules/duty-schedule/duty-schedule.controller';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { resolveLeaveRequestApplicant } from '../../shared/leave-request-applicant';
import { assertLeaveRequestPersonnelIdentity } from '../../server/modules/duty-schedule/leave-request-applicant';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { createHash } from 'node:crypto';
import { bindLeaveRequestApplicant } from '../../server/modules/duty-schedule/leave-request-applicant';

describe('请休假申请登录身份绑定', () => {
  const create = jest.fn().mockResolvedValue({ success: true });
  const controller = new DutyScheduleController(
    { createLeaveRequest: create } as never,
    {} as never,
    {} as never,
    { start: jest.fn() } as never,
  );
  const payload = (name: string) => JSON.stringify({
    clientMutationId: 'leave-request-applicant-test', leaveStaffName: name,
    startAt: '2026-10-12T08:00', endAt: '2026-10-12T12:00',
    leaveType: '年假', leaveReason: '身份绑定验收',
  });
  const submit = (principal?: AccessPrincipal, fingerprint?: string, name = '验收员工甲') =>
    (controller.createLeaveRequest as (...args: unknown[]) => Promise<unknown>)(payload(name), [], {
      accessPrincipal: principal, accessPrincipalFingerprint: fingerprint,
    } as never);

  beforeEach(() => create.mockClear());

  it('未登录游客不能提交，也不能使用请求中的姓名伪造身份', async () => {
    await expect(submit({ role: 'guest', purchaseBuilding: null })).rejects.toThrow('请先登录');
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['feishu-', 'local-external-'])('%s 登录不允许代其他姓名提交', async prefix => {
    await expect(submit({ role: 'admin', purchaseBuilding: null,
      accountId: prefix + 'a'.repeat(64), displayName: '验收员工乙' }, 'authenticated'))
      .rejects.toThrow('申请人员必须为当前登录本人');
    expect(create).not.toHaveBeenCalled();
  });

  it('只有可信姓名而没有稳定身份的飞书 guest 不能提交', async () => {
    await expect(submit({ role: 'guest', purchaseBuilding: null, displayName: '验收员工甲' }, 'authenticated'))
      .rejects.toThrow('登录账号未匹配到人员');
    expect(create).not.toHaveBeenCalled();
  });

  it('有稳定身份的飞书本人账号可以提交', async () => {
    await expect(submit({ role: 'guest', purchaseBuilding: null, accountId: 'feishu-' + 'a'.repeat(64), displayName: '验收员工甲' }, 'authenticated'))
      .resolves.toMatchObject({ success: true });
  });

  it('外部姓名账号的 guest 角色可以提交本人的申请', async () => {
    await expect(submit({ role: 'guest', purchaseBuilding: null,
      accountId: 'local-external-' + 'a'.repeat(64), displayName: '验收员工甲' }, 'authenticated'))
      .resolves.toMatchObject({ success: true });
  });

  it('实名会话缺少姓名时明确拒绝，不能退回自由选择', async () => {
    await expect(submit({ role: 'admin', purchaseBuilding: null,
      accountId: 'feishu-' + 'a'.repeat(64) }, 'authenticated')).rejects.toThrow('登录姓名缺失');
    expect(create).not.toHaveBeenCalled();
  });

  it('其他密码登录保留人员选择', async () => {
    await expect(submit({ role: 'admin', purchaseBuilding: null,
      accountId: 'local-admin', displayName: '管理员' }, 'authenticated'))
      .resolves.toMatchObject({ success: true });
    expect(create.mock.calls[0][0].leaveStaffName).toBe('验收员工甲');
  });

  it('110公共账号提交加班时传递所选姓名及原登录身份给服务层校验', async () => {
    const overtime = jest.fn().mockResolvedValue({ success: true });
    const subject = Object.assign(Object.create(DutyScheduleController.prototype), {
      dutyScheduleService: { createOvertimeRequest: overtime }, overtimeWorkflowService: { isEnabled: () => false },
    });
    const station: AccessPrincipal = { role: 'guest', purchaseBuilding: null,
      accountId: 'feishu-' + 'c'.repeat(64), displayName: '南通基地-110kV变电站值班' };
    await expect(subject.createOvertimeRequest(JSON.stringify({ staffName: '张华' }), [], {
      accessPrincipal: station, accessPrincipalFingerprint: 'authenticated',
    })).resolves.toMatchObject({ success: true });
    expect(overtime).toHaveBeenCalledWith({ staffName: '张华' }, undefined, station);
  });
});

describe('申请姓名与人员记录身份', () => {
  const person = { appId: 'cli_fixture', appToken: 'fixture-base', tableId: 'tblFixture', recordId: 'recFixture', openId: 'ou_fixture' };

  it('110公共值班飞书账号允许选择真实人员，未登录和普通本人账号保持限制', () => {
    const station = { role: 'guest' as const, purchaseBuilding: null, accountId: 'feishu-' + 'c'.repeat(64), displayName: '南通基地-110kV变电站值班' };
    expect(resolveLeaveRequestApplicant(station, true)).toEqual({ mode: 'manual' });
    expect(bindLeaveRequestApplicant('张华', station, true)).toBe('张华');
    expect(resolveLeaveRequestApplicant(station, false).mode).toBe('login');
    expect(resolveLeaveRequestApplicant({ ...station, accountId: 'local-external-' + 'c'.repeat(64) }, true))
      .toEqual({ mode: 'automatic', name: station.displayName });
  });

  it('飞书账号自动显示姓名，缺失姓名不会放开选择', () => {
    const principal = { role: 'admin' as const, purchaseBuilding: null, accountId: 'feishu-' + 'a'.repeat(64), displayName: '验收员工甲' };
    expect(resolveLeaveRequestApplicant(principal, true)).toEqual({ mode: 'automatic', name: '验收员工甲' });
    expect(resolveLeaveRequestApplicant({ ...principal, displayName: undefined }, true).mode).toBe('error');
  });

  it('外部账号的 guest 角色区分登录与未登录', () => {
    const principal = { role: 'guest' as const, purchaseBuilding: null, accountId: 'local-external-' + 'a'.repeat(64), displayName: '验收员工甲' };
    expect(resolveLeaveRequestApplicant(principal, true)).toEqual({ mode: 'automatic', name: '验收员工甲' });
    expect(resolveLeaveRequestApplicant(principal, false).mode).toBe('login');
  });

  it('其他登录方式保留手动选择，管理员显示名不冒充申请人', () => {
    expect(resolveLeaveRequestApplicant({ role: 'admin', purchaseBuilding: null, displayName: '管理员', accountId: 'local-admin' }, true))
      .toEqual({ mode: 'manual' });
  });

  it('切换账号后实时使用新会话姓名', () => {
    const principal = { role: 'guest' as const, purchaseBuilding: null, accountId: 'local-external-' + 'a'.repeat(64) };
    expect(resolveLeaveRequestApplicant({ ...principal, displayName: '验收员工甲' }, true)).toMatchObject({ name: '验收员工甲' });
    expect(resolveLeaveRequestApplicant({ ...principal, displayName: '验收员工乙' }, true)).toMatchObject({ name: '验收员工乙' });
    expect(resolveLeaveRequestApplicant(principal, false).mode).toBe('login');
  });

  it('飞书身份必须匹配 Open ID 及应用，不能只匹配姓名', () => {
    const principal = { role: 'admin' as const, purchaseBuilding: null, accountId: `feishu-${feishuIdentityFingerprint(person.appId, person.openId)}` };
    expect(() => assertLeaveRequestPersonnelIdentity(principal, person)).not.toThrow();
    for (const changed of [{ ...person, openId: 'ou_other' }, { ...person, appId: 'cli_other' }, { ...person, openId: undefined }]) {
      expect(() => assertLeaveRequestPersonnelIdentity(principal, changed)).toThrow('登录账号与申请人员资料不一致');
    }
  });

  it('外部账号必须匹配人员记录、应用和表格身份', () => {
    const accountId = 'local-external-' + createHash('sha256').update(JSON.stringify([person.appId, person.appToken, person.tableId, person.recordId])).digest('hex');
    const principal = { role: 'guest' as const, purchaseBuilding: null, accountId };
    expect(() => assertLeaveRequestPersonnelIdentity(principal, person)).not.toThrow();
    for (const key of ['appId', 'appToken', 'tableId', 'recordId'] as const) {
      expect(() => assertLeaveRequestPersonnelIdentity(principal, { ...person, [key]: 'other' })).toThrow('登录账号与申请人员资料不一致');
    }
  });
});
