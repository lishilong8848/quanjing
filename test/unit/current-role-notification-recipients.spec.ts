import * as leaveRules from '../../server/modules/leave-workflow/leave-workflow.rules';
import * as overtimeRules from '../../server/modules/overtime-workflow/overtime-workflow.rules';

const person = (openId: string, position = '') => ({ openId, name: `合成${openId}`, position, buildings: ['B楼'] });
const leave = () => ({ snapshot: { applicantOpenId: 'ou_applicant', applicantNotificationOpenIds: ['ou_shared'], building: 'B楼', substituteOpenId: 'ou_substitute' },
  approvalPlan: { approvalClass: 'ordinary', discipline: 'electrical', stages: [{ key: 'supervisor', approvers: [person('ou_old_supervisor')] }], notificationPlan: { finalResultRecipients: [person('ou_applicant'), person('ou_old_supervisor'), person('ou_old_manager', '设施运维经理'), person('ou_old_professional')], professionalRecipients: [person('ou_old_professional')], substituteRecipients: [person('ou_substitute')] } },
  resultRecipients: [person('ou_applicant'), person('ou_shared'), person('ou_substitute'), person('ou_old_supervisor'), person('ou_old_manager', '设施运维经理'), person('ou_old_professional')] });
const overtime = () => ({ snapshot: { applicantName: '合成申请人', applicantOpenId: 'ou_applicant', building: 'B楼', position: '电气工程师' }, approvers: [person('ou_old_approver')], managerRecipients: [person('ou_old_manager')], professionalRecipients: [person('ou_old_professional')] });
const resolver = (kind: string) => [person(`ou_new_${kind}`)];
const resolveLeave = (value: unknown, resolve: unknown) => (leaveRules as unknown as { resolveCurrentLeaveNotificationRecipients(value: unknown, resolve: unknown): { openId: string }[] }).resolveCurrentLeaveNotificationRecipients(value, resolve);
const resolveOvertime = (value: unknown, resolve: unknown, approved = true) => (overtimeRules as unknown as { resolveCurrentOvertimeNotificationRecipients(value: unknown, resolve: unknown, approved: boolean): { openId: string }[] }).resolveCurrentOvertimeNotificationRecipients(value, resolve, approved);

describe('岗位通知按各自职责解析，申请人和替班身份保持', () => {
  it('请休假独立经理、主管、专业通知跟随现任，原快照不被改写', () => {
    const input = leave(), before = JSON.stringify(input), read = jest.fn(resolver);
    expect(resolveLeave(input, read).map(row => row.openId).sort()).toEqual(['ou_applicant', 'ou_shared', 'ou_substitute', 'ou_new_leave_supervisor', 'ou_new_leave_manager', 'ou_new_professional_supervisor'].sort());
    expect(read.mock.calls).toContainEqual(['professional_supervisor', { building: ['B楼'], specialty: '电气' }]); expect(JSON.stringify(input)).toBe(before);
  });
  it('前任同时是申请人、共享通知或替班人时保留该独立身份，按OpenID去重', () => {
    const input = leave(); input.snapshot.applicantOpenId = 'ou_old_manager'; input.snapshot.substituteOpenId = 'ou_old_professional';
    input.resultRecipients.push(person('ou_old_manager', '设施运维经理'), person('ou_old_professional'));
    const ids = resolveLeave(input, resolver).map(row => row.openId); expect(ids).toContain('ou_old_manager'); expect(ids).toContain('ou_old_professional'); expect(new Set(ids).size).toBe(ids.length);
  });
  it('未启用岗位覆盖时保持原接收人；明确空成员不回退旧人', () => {
    const input = leave(); expect(resolveLeave(input, () => null)).toEqual(input.resultRecipients);
    expect(resolveLeave(input, () => []).map(row => row.openId)).toEqual(['ou_applicant', 'ou_shared', 'ou_substitute']);
  });
  it('原阶段交接已更新聚合名单时，申请人和替班人的快照身份仍保留', () => {
    const input = leave(); input.snapshot.substituteOpenId = 'ou_old_supervisor';
    input.resultRecipients = input.resultRecipients.filter(row => row.openId !== 'ou_old_supervisor');
    input.approvalPlan.stages[0].approvers = [person('ou_new_stage')];
    expect(resolveLeave(input, resolver).map(row => row.openId)).toContain('ou_old_supervisor');
  });
  it('加班独立经理、专业及审批职责分别替换，拒绝结果不扩大知会范围', () => {
    const input = overtime(), before = JSON.stringify(input);
    expect(resolveOvertime(input, resolver).map(row => row.openId).sort()).toEqual(['ou_applicant', 'ou_new_overtime_supervisor', 'ou_new_overtime_manager', 'ou_new_professional_supervisor'].sort());
    expect(resolveOvertime(input, resolver, false).map(row => row.openId).sort()).toEqual(['ou_applicant', 'ou_new_overtime_supervisor'].sort()); expect(JSON.stringify(input)).toBe(before);
  });
  it('加班前任兼申请人仍按申请人收到一条，未覆盖角色保留原名单', () => {
    const input = overtime(); input.snapshot.applicantOpenId = 'ou_old_manager';
    const ids = resolveOvertime(input, () => null).map(row => row.openId); expect(ids.sort()).toEqual(['ou_old_manager', 'ou_old_approver', 'ou_old_professional'].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('经理本人请假的上级审批组不被普通经理岗位覆盖', () => {
    const input = leave(); input.approvalPlan.approvalClass = 'manager'; input.approvalPlan.discipline = '';
    input.approvalPlan.stages = [{ key: 'manager', approvers: [person('ou_escalation')] }];
    input.approvalPlan.notificationPlan.professionalRecipients = [];
    input.approvalPlan.notificationPlan.finalResultRecipients = [person('ou_applicant'), person('ou_escalation')];
    input.resultRecipients = [person('ou_applicant'), person('ou_escalation')];
    const read = jest.fn(resolver);
    expect(resolveLeave(input, read)).toEqual(input.resultRecipients);
    expect(read).not.toHaveBeenCalledWith('leave_manager', expect.anything());
    expect(leaveRules.resolveCurrentLeaveAdjustmentApprovers(input as never, read).map(row => row.openId)).toEqual(['ou_escalation']);
  });
});
