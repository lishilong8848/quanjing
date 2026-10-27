import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { OvertimeWorkflowStore } from '../../server/modules/overtime-workflow/overtime-workflow.store';
import { OvertimeWorkflowService } from '../../server/modules/overtime-workflow/overtime-workflow.service';
import { issueOvertimeConfirmationTicket, verifyOvertimeConfirmationTicket } from '../../server/modules/overtime-workflow/overtime-workflow.gateway';
import { OvertimePersonnelHandoverAdapter } from '../../server/modules/overtime-workflow/overtime-personnel-handover.adapter';
import type { HandoverContext } from '../../shared/personnel-handover.interface';

const source = { name: '合成前任', openId: 'ou_synthetic_old', position: '设施主管', buildings: ['C楼'] };
const target = { name: '合成接任', openId: 'ou_synthetic_new', personRecordId: 'recNewFixture', position: '设施主管', buildings: ['C楼'] };
const snapshot = { recordId: 'recConfirmationFixture', applicantName: '合成申请人', applicantOpenId: 'ou_synthetic_applicant', building: 'C楼', position: '运维值班员', plannedStartAt: '2026-10-01T09:00:00+08:00', plannedEndAt: '2026-10-01T17:00:00+08:00', plannedHours: 8, reason: '合成验收' };
const oldCard = { recipientOpenId: source.openId, messageId: 'om_synthetic_confirmation', businessKey: `overtime:${snapshot.recordId}:confirmation:initial` };
const draft = { actualStartAt: snapshot.plannedStartAt, actualHours: 8, disposition: '调休' as const };
interface Input { recordId: string; mutationId: string; dutyRecordId: string; sourceOpenId: string; sourcePersonRecordId: string; expectedRevision: number; target: typeof target; }
type Port = OvertimeWorkflowStore & { acceptConfirmationHandover(input: Input): Promise<{ status: string; generation: number; taskBusinessKey: string | null }> };

describe('加班已批准待确认的责任交接', () => {
  it('岗位更新后CAS内拒绝旧确认，原来合法受理的相同mutation不重验或重复执行',async()=>{
    const value={recordId:input.recordId,mutationId:'synthetic-role-fence-confirmation',actorOpenId:source.openId,draft},before=readFileSync(file,'utf8');
    await expect(store.claimConfirmationSubmission(value,new Date(),()=>false)).rejects.toThrow('岗位');expect(readFileSync(file,'utf8')).toBe(before);expect((await store.claimConfirmationSubmission(value,new Date(),()=>true)).claimed).toBe(true);
    const check=jest.fn(()=>false);expect((await store.claimConfirmationSubmission(value,new Date(),check)).claimed).toBe(false);expect(check).not.toHaveBeenCalled();
  });
  let directory: string, temporaryRoot: string, owner: string, file: string, store: Port, input: Input, originalApp: string | undefined, originalEnabled: string | undefined;
  beforeEach(async () => {
    originalApp = process.env.FEISHU_APP_ID; originalEnabled = process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED;
    process.env.FEISHU_APP_ID = 'cli_synthetic_confirmation'; process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED = 'true';
    temporaryRoot = realpathSync(tmpdir()); owner = randomUUID(); directory = mkdtempSync(join(temporaryRoot, 'nt-confirmation-handover-'));
    writeFileSync(join(directory, '.test-owner'), owner, { flag: 'wx' }); file = join(directory, 'ledger.json'); store = new OvertimeWorkflowStore(file, file) as Port;
    await store.recoverAwaitingConfirmationApplication({ snapshot, actualApprover: source, managerRecipients: [], approvedAt: '2026-10-01T08:00:00+08:00' });
    await store.patchApplication(snapshot.recordId, { confirmationCards: [oldCard] });
    input = { recordId: snapshot.recordId, mutationId: `handover-${'c'.repeat(64)}`, dutyRecordId: 'recDutyFixture', sourceOpenId: source.openId, sourcePersonRecordId: 'recOldFixture', expectedRevision: (await store.getApplication(snapshot.recordId))!.revision, target };
  });
  afterEach(() => {
    if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalApp;
    if (originalEnabled === undefined) delete process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED; else process.env.OVERTIME_WORKFLOW_PROGRAM_ENABLED = originalEnabled;
    const canonical = (value: string) => resolve(value).toLowerCase();
    if (canonical(dirname(directory)) !== canonical(temporaryRoot) || !/^nt-confirmation-handover-[A-Za-z0-9]+$/u.test(basename(directory)) || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory)) throw new Error('测试目录归属异常，已保留');
    for (const name of readdirSync(directory)) if (!lstatSync(join(directory, name)).isFile() || lstatSync(join(directory, name)).isSymbolicLink()) throw new Error('测试目录条目异常，已保留');
    if (readFileSync(join(directory, '.test-owner'), 'utf8') !== owner) throw new Error('测试目录归属标记异常，已保留');
    rmSync(directory, { recursive: true, force: false });
  });
  it('独立确认负责人CAS不改批准历史，旧确认被拒绝且重启幂等', async () => {
    const before = (await store.getApplication(input.recordId))!;
    const receipt = await store.acceptConfirmationHandover(input);
    expect(receipt).toMatchObject({ status: 'accepted', generation: 2 });
    const application = (await store.getApplication(input.recordId))!;
    expect(application).toMatchObject({ phase: 'awaiting_confirmation', actualApproverOpenId: before.actualApproverOpenId, actualApproverName: before.actualApproverName, approvedAt: before.approvedAt, confirmationResponsible: { openId: target.openId, name: target.name, personRecordId: target.personRecordId, generation: 2 }, confirmationCards: [] });
    expect(application.approvers).toEqual(before.approvers);
    await expect(store.claimConfirmationSubmission({ recordId: input.recordId, mutationId: 'synthetic-old-confirmation', actorOpenId: source.openId, draft })).rejects.toThrow();
    const bytes = readFileSync(file, 'utf8');
    expect(await (new OvertimeWorkflowStore(file, file) as Port).acceptConfirmationHandover(input)).toEqual(receipt);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    const task = (await store.listTasks()).find(entry => entry.businessKey === receipt.taskBusinessKey)!;
    expect(task).toMatchObject({ kind: 'sync_confirmation_handover', payload: { oldCards: [oldCard], targetGeneration: 2 } });
  });
  it('合法确认先受理时跳过交接，不改提交和批准字节', async () => {
    const confirmation = await store.claimConfirmationSubmission({ recordId: input.recordId, mutationId: 'synthetic-first-confirmation', actorOpenId: source.openId, draft });
    const bytes = readFileSync(file, 'utf8');
    expect((await store.acceptConfirmationHandover(input)).status).toBe('already_completed');
    expect(await store.getConfirmation(input.recordId)).toEqual(confirmation.entry);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });
  it('版本变化、自确认和投递结果不明均不覆盖', async () => {
    const bytes = readFileSync(file, 'utf8');
    await expect(store.acceptConfirmationHandover({ ...input, expectedRevision: 1 })).rejects.toThrow();
    await expect(store.acceptConfirmationHandover({ ...input, target: { ...target, openId: snapshot.applicantOpenId } })).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    await store.enqueueTask({ recordId: input.recordId, businessKey: 'synthetic-delivery', kind: 'deliver_confirmation', payload: {} });
    const running = await store.takeNextTask(); expect(running?.kind).toBe('deliver_confirmation');
    const active = readFileSync(file, 'utf8');
    await expect(store.acceptConfirmationHandover(input)).rejects.toThrow('投递');
    expect(readFileSync(file, 'utf8')).toBe(active);
  });
  it('实际签名票据绑定确认代际，同时保留原无代际票据验证', () => {
    const secret = 'synthetic-confirmation-ticket-secret-only', issuedAt = Date.now();
    const legacy = issueOvertimeConfirmationTicket({ recordId: input.recordId, approverOpenId: source.openId, issuedAt }, secret);
    expect(verifyOvertimeConfirmationTicket(legacy, secret, { expectedRecordId: input.recordId, now: issuedAt })).toEqual({ recordId: input.recordId, approverOpenId: source.openId, issuedAt });
    const ticket = issueOvertimeConfirmationTicket({ recordId: input.recordId, approverOpenId: target.openId, issuedAt, confirmationGeneration: 2 } as never, secret);
    expect(verifyOvertimeConfirmationTicket(ticket, secret, { expectedRecordId: input.recordId, now: issuedAt })).toMatchObject({ confirmationGeneration: 2 });
    expect(ticket).not.toBe(legacy);
  });
  it('回任同一Open ID仍拒绝旧代际票据，只接受新代际确认', async () => {
    const first = await store.acceptConfirmationHandover(input);
    const task = await store.takeNextTask(); expect(task?.businessKey).toBe(first.taskBusinessKey); await store.completeTask(task!.key, task!.claimToken);
    const second = await store.acceptConfirmationHandover({ ...input, mutationId: `handover-${'d'.repeat(64)}`, sourceOpenId: target.openId, sourcePersonRecordId: target.personRecordId, expectedRevision: (await store.getApplication(input.recordId))!.revision, target: { ...source, personRecordId: input.sourcePersonRecordId } });
    expect(second.generation).toBe(3);
    const secret = 'synthetic-rotation-ticket-secret-only', gateway = { verifyConfirmationTicket: (ticket: string, recordId: string) => verifyOvertimeConfirmationTicket(ticket, secret, { expectedRecordId: recordId, now: Date.now() }) };
    const service = new OvertimeWorkflowService(store, gateway as never, {} as never, { canUseFeishuBusinessIdentity: () => true } as never);
    const legacy = issueOvertimeConfirmationTicket({ recordId: input.recordId, approverOpenId: source.openId, issuedAt: Date.now() }, secret);
    await expect(service.getConfirmationDetail(input.recordId, legacy)).rejects.toThrow();
    await expect(store.claimConfirmationSubmission({ recordId: input.recordId, mutationId: 'synthetic-stale-generation', actorOpenId: source.openId, confirmationGeneration: 1, draft })).rejects.toThrow();
    const fresh = issueOvertimeConfirmationTicket({ recordId: input.recordId, approverOpenId: source.openId, issuedAt: Date.now(), confirmationGeneration: 3 }, secret);
    await expect(service.submitConfirmation({ recordId: input.recordId, ticket: fresh, mutationId: 'synthetic-current-generation', actualStartAt: snapshot.plannedStartAt, actualHours: 8, disposition: 'compensatory_leave' })).resolves.toMatchObject({ accepted: true });
  });
  it('旧确认卡迟到只补终态，新代际每日提醒不被旧幂等键吞掉', async () => {
    const now = new Date('2026-10-13T08:00:00+08:00');
    const original = await store.enqueueDailyConfirmationReminder(input.recordId, source.openId, now);
    await store.acceptConfirmationHandover(input);
    await store.recordConfirmationCardDelivery(input.recordId, { ...oldCard, messageId: 'om_synthetic_late_confirmation', businessKey: 'synthetic-late-confirmation' }, 1);
    expect((await store.getApplication(input.recordId))!.confirmationCards).toEqual([]);
    expect((await store.listTasks()).filter(task => task.kind === 'sync_confirmation_handover' && task.payload.patchOnly === true)).toHaveLength(1);
    const next = await store.enqueueDailyConfirmationReminder(input.recordId, target.openId, now);
    expect(next.created).toBe(true); expect(next.task.businessKey).not.toBe(original.task.businessKey);
    expect(next.task.payload).toMatchObject({ recipientOpenId: target.openId, confirmationGeneration: 2 });
    await expect(store.enqueueDailyConfirmationReminder(input.recordId, source.openId, now)).rejects.toThrow();
  });
  it('真实确认adapter提供独立执行阶段，路由完成不冒充新卡投递成功', async () => {
    await store.enqueueTask({ businessKey: 'synthetic-route-evidence', recordId: input.recordId, kind: 'deliver_approval_cards', payload: { routeKind: 'building_supervisor' } });
    const person = (value: typeof source, recordId: string, marker: string, active: boolean) => ({ id: `local-external-${marker.repeat(64)}`, recordId, name: value.name, openId: value.openId, active, type: 'employee' as const, position: value.position, systemPosition: '', buildings: ['C楼' as const], specialties: [], permissionTags: [], dutyRecordIds: [input.dutyRecordId] });
    const context: HandoverContext = { from: person(source, input.sourcePersonRecordId, 'a', false), to: person(target, target.personRecordId, 'b', true), directoryVersion: 'synthetic-directory', duties: [{ recordId: input.dutyRecordId, name: 'C楼主管', kind: 'overtime_supervisor', personnelIds: [`local-external-${'a'.repeat(64)}`], buildings: ['C楼'], specialties: null, enabled: true, startsAt: 0, endsAt: null, parentDutyIds: [], version: 1 }] };
    const adapter = new OvertimePersonnelHandoverAdapter(store, { canUseFeishuBusinessIdentity: () => true } as never, { isEnabled: () => true } as never);
    const item = (await adapter.listPending(context)).find(entry => entry.stageKey === 'confirmation')!;
    expect(item).toMatchObject({ phase: 'execution', status: 'pending', recipients: [{ name: source.name, openId: source.openId }] });
    expect(await adapter.preflight(context, item)).toEqual({ ready: true });
    const receipt = await adapter.acceptTransfer(context, item, input.mutationId);
    expect((await adapter.preflight(context,item,input.mutationId)).ready).toBe(true);
    expect((await adapter.preflight({...context,to:{...context.to,recordId:'recWrongPerson'}},item,input.mutationId)).ready).toBe(false);
    expect(await adapter.reconcile(context, receipt)).toEqual({ status: 'syncing' });
    expect((await adapter.reconcile({ ...context, to: { ...context.to, recordId: 'recWrongPerson' } }, receipt)).status).toBe('error');
    while (true) { const task = await store.takeNextTask(new Date(Date.now() + 60_000)); if (!task) break; await store.completeTask(task.key, task.claimToken); }
    expect(await adapter.reconcile(context, receipt)).toEqual({ status: 'syncing' });
    await store.recordConfirmationCardDelivery(input.recordId, { recipientOpenId: target.openId, messageId: 'om_synthetic_new_confirmation', businessKey: `overtime:${input.recordId}:confirmation:initial:v2` }, 2);
    expect(await adapter.reconcile(context, receipt)).toEqual({ status: 'success' });
  });
  it('真实确认worker终态化旧卡后发新卡，失败重启不重补旧卡且旧签名失效', async () => {
    const receipt = await store.acceptConfirmationHandover(input), before = (await store.getApplication(input.recordId))!;
    const secret = 'synthetic-worker-ticket-secret-only'; let failSend = true, ticket = '';
    const gateway = {
      readOvertimeRecordIfExists: jest.fn(async () => ({ recordId: input.recordId, fields: {} })),
      updateOvertimeRecord: jest.fn(async (_id: string, fields: Record<string, unknown>) => { expect(fields).not.toHaveProperty('加班审批人'); expect(fields).not.toHaveProperty('加班审批时间'); }),
      patchInteractiveCard: jest.fn(async (messageId: string, card: Record<string, unknown>) => { expect(messageId).toBe(oldCard.messageId); expect(JSON.stringify(card)).toContain('确认已转交'); expect(JSON.stringify(card)).not.toContain('url'); }),
      issueConfirmationTicket: jest.fn((value: never) => { ticket = issueOvertimeConfirmationTicket({ ...(value as object), issuedAt: Date.now() } as never, secret); return ticket; }),
      verifyConfirmationTicket: jest.fn((value: string, recordId: string) => verifyOvertimeConfirmationTicket(value, secret, { expectedRecordId: recordId, now: Date.now() })),
      buildConfirmationUrl: jest.fn((_recordId: string, value: string) => `https://synthetic.invalid/confirmation?ticket=${value}`),
      sendInteractiveCard: jest.fn(async (openId: string, _card: unknown, key: string) => { expect(openId).toBe(target.openId); expect(key).toContain(':v2'); if (failSend) { failSend = false; throw new Error('synthetic-send-failure'); } return 'om_synthetic_new_confirmation'; }),
    };
    const configuration = { canUseFeishuBusinessIdentity: () => true };
    const service = new OvertimeWorkflowService(store, gateway as never, {} as never, configuration as never);
    expect(await service.runPendingTasks(new Date(), 2)).toEqual({ processed: 1, failed: 1 });
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
    const restarted = new OvertimeWorkflowService(new OvertimeWorkflowStore(file, file), gateway as never, {} as never, configuration as never);
    expect(await restarted.runPendingTasks(new Date(Date.now() + 60_000), 2)).toEqual({ processed: 1, failed: 0 });
    expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(1);
    expect((await store.listTasks()).find(task => task.businessKey === receipt.taskBusinessKey)?.payload.patchedMessageIds).toEqual([oldCard.messageId]);
    const legacy = issueOvertimeConfirmationTicket({ recordId: input.recordId, approverOpenId: source.openId, issuedAt: Date.now() }, secret);
    await expect(restarted.getConfirmationDetail(input.recordId, legacy)).rejects.toThrow();
    await expect(restarted.getConfirmationDetail(input.recordId, ticket)).resolves.toMatchObject({ staffName: snapshot.applicantName });
    await expect(restarted.submitConfirmation({ recordId: input.recordId, ticket, mutationId: 'synthetic-target-confirmation', actualStartAt: snapshot.plannedStartAt, actualHours: 8, disposition: 'compensatory_leave' })).resolves.toMatchObject({ accepted: true });
    expect(await store.getConfirmation(input.recordId)).toMatchObject({ actorOpenId: target.openId });
    expect(await store.getApplication(input.recordId)).toMatchObject({ actualApproverOpenId: before.actualApproverOpenId, actualApproverName: before.actualApproverName, approvedAt: before.approvedAt, confirmationCards: [expect.objectContaining({ recipientOpenId: target.openId })] });
  });
});
