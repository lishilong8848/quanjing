import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { OvertimeWorkflowService } from '../../server/modules/overtime-workflow/overtime-workflow.service';
import { OvertimeWorkflowStore } from '../../server/modules/overtime-workflow/overtime-workflow.store';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';

const actor = { name: '合成审批人', openId: 'ou_synthetic_approver', position: '设施示例人员001' };
const snapshot = { recordId: 'rec_synthetic_overtime', applicantName: '合成申请人', applicantOpenId: 'ou_synthetic_applicant', building: 'B楼', position: '运维值班员', plannedStartAt: '2026-08-13T09:00:00+08:00', plannedEndAt: '2026-08-13T17:00:00+08:00', plannedHours: 8, reason: '合成验收' };
const action = { eventId: 'synthetic-approval', recordId: snapshot.recordId, action: 'approve' as const, actorOpenId: actor.openId, messageId: 'om_synthetic_approval' };
const submission = { recordId: snapshot.recordId, ticket: 'synthetic-ticket', mutationId: 'synthetic-confirmation', actualStartAt: '2026-08-13T09:00:00+08:00', actualHours: 8, disposition: 'overtime_pay' as const };

describe('加班旧卡片及确认票据人员权限', () => {
  let directory: string, temporaryRoot: string, owner: string, file: string, store: OvertimeWorkflowStore;
  let originalApp: string | undefined, originalEnabled: string | undefined;
  beforeEach(() => {
    originalApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_overtime';
    originalEnabled = process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED; process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED = 'true';
    temporaryRoot = realpathSync(tmpdir()); owner = randomUUID(); directory = mkdtempSync(join(temporaryRoot, 'nt-overtime-access-'));
    writeFileSync(join(directory, '.test-owner'), owner, { flag: 'wx' }); file = join(directory, 'ledger.json'); store = new OvertimeWorkflowStore(file, file);
  });
  afterEach(() => {
    if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalApp;
    if (originalEnabled === undefined) delete process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED; else process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED = originalEnabled;
    const canonical = (value: string) => resolve(value).toLowerCase();
    if (canonical(dirname(directory)) !== canonical(temporaryRoot) || !/^nt-overtime-access-[A-Za-z0-9]+$/u.test(basename(directory)) || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory)) throw new Error('测试目录归属异常，已保留');
    for (const name of readdirSync(directory)) if (!lstatSync(join(directory, name)).isFile() || lstatSync(join(directory, name)).isSymbolicLink()) throw new Error('测试目录条目异常，已保留');
    if (readFileSync(join(directory, '.test-owner'), 'utf8') !== owner) throw new Error('测试目录标记异常，已保留'); rmSync(directory, { recursive: true, force: false });
  });
  const service = (store: OvertimeWorkflowStore, allowed: boolean) => {
    const configuration = { canUseFeishuBusinessIdentity: jest.fn().mockReturnValue(allowed) };
    const gateway = { verifyConfirmationTicket: jest.fn().mockReturnValue({ approverOpenId: actor.openId }), readOvertimeRecord: jest.fn() };
    return { instance: Reflect.construct(OvertimeWorkflowService, [store, gateway, {}, configuration]) as OvertimeWorkflowService, configuration, gateway };
  };
  async function pendingApproval() {
    await store.acceptApplication({ clientMutationId: 'synthetic-request', snapshot });
    await store.patchApplication(snapshot.recordId, { phase: 'approval_pending', approvers: [actor], approvalCards: [{ recipientOpenId: actor.openId, messageId: action.messageId, businessKey: 'synthetic-card' }] });
  }
  async function pendingConfirmation() {
    await store.recoverAwaitingConfirmationApplication({ snapshot, actualApprover: actor, managerRecipients: [], approvedAt: '2026-08-13T08:00:00+08:00' });
  }
  it('收回权限后旧审批卡拒绝，账本与外部系统不变', async () => {
    await pendingApproval(); const before = readFileSync(file, 'utf8'), context = service(store, false);
    await expect(context.instance.acceptApprovalAction(action)).rejects.toThrow('当前人员不可办理');
    expect(readFileSync(file, 'utf8')).toBe(before); expect(context.gateway.readOvertimeRecord).not.toHaveBeenCalled();
    expect(context.configuration.canUseFeishuBusinessIdentity).toHaveBeenCalledWith(`feishu-${feishuIdentityFingerprint('cli_synthetic_overtime', actor.openId)}`, 'cli_synthetic_overtime');
  });
  it('缺少状态依赖不允许新的审批', async () => {
    await pendingApproval(); const before = readFileSync(file, 'utf8');
    await expect(new OvertimeWorkflowService(store, {} as never, {} as never).acceptApprovalAction(action)).rejects.toThrow('人员权限状态未就绪');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('原合法审批重放只返回原终态', async () => {
    await pendingApproval(); await store.claimApprovalAction(action); const before = readFileSync(file, 'utf8');
    expect((await service(store, false).instance.acceptApprovalAction(action)).claimed).toBe(false); expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('收回权限后有效确认票据也不能新提交或读取待办', async () => {
    await pendingConfirmation(); const before = readFileSync(file, 'utf8'), context = service(store, false);
    await expect(context.instance.submitConfirmation(submission)).rejects.toThrow('当前人员不可办理');
    await expect(context.instance.getConfirmationDetail(snapshot.recordId, submission.ticket)).rejects.toThrow('当前人员不可办理');
    expect(readFileSync(file, 'utf8')).toBe(before); expect(context.gateway.readOvertimeRecord).not.toHaveBeenCalled();
  });
  it('确认受理后的相同重试保持原结果，改变草稿或幂等键拒绝', async () => {
    await pendingConfirmation(); await service(store, true).instance.submitConfirmation(submission); const before = readFileSync(file, 'utf8'), context = service(store, false);
    await expect(context.instance.submitConfirmation(submission)).resolves.toMatchObject({ accepted: true });
    await expect(context.instance.submitConfirmation({ ...submission, actualHours: 7 })).rejects.toThrow('当前人员不可办理');
    await expect(context.instance.submitConfirmation({ ...submission, mutationId: 'synthetic-other' })).rejects.toThrow('当前人员不可办理');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
