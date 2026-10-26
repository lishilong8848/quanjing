import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import { LeavePersonnelHandoverAdapter } from '../../server/modules/leave-workflow/leave-personnel-handover.adapter';
import type { HandoverContext } from '../../shared/personnel-handover.interface';
import { Test } from '@nestjs/testing';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { LeaveWorkflowModule } from '../../server/modules/leave-workflow/leave-workflow.module';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { LeaveWorkflowService } from '../../server/modules/leave-workflow/leave-workflow.service';

const source = { name: '合成前任', openId: 'ou_synthetic_old', personRecordId: 'recOldPerson', position: '设施示例人员001', buildings: ['C楼'] };
const target = { name: '合成接任', openId: 'ou_synthetic_new', personRecordId: 'recNewPerson', position: '设施示例人员001', buildings: ['C楼'] };
const person = (value: typeof source, marker: string, active: boolean) => ({ id: `local-external-${marker.repeat(64)}`, recordId: value.personRecordId, name: value.name, openId: value.openId, active, type: 'employee' as const, position: value.position, systemPosition: '', buildings: ['C楼' as const], specialties: [], permissionTags: [], dutyRecordIds: ['recDutyFixture'] });
const context = (): HandoverContext => ({ from: person(source,'a',false), to: person(target,'b',true), directoryVersion: 'synthetic-directory', duties: [{ recordId: 'recDutyFixture', name: 'C楼示例人员001', kind: 'leave_supervisor', personnelIds: [`local-external-${'a'.repeat(64)}`], buildings: ['C楼'], specialties: null, enabled: true, startsAt: 0, endsAt: null, parentDutyIds: [], version: 1 }] });
const mutationId = `handover-${'c'.repeat(64)}`;
describe('请休假真实交接适配器（本地账本，外部零调用）', () => {
  let directory: string, temporaryRoot: string, owner: string, file: string, store: LeaveWorkflowStore, adapter: LeavePersonnelHandoverAdapter, originalApp: string | undefined;
  const configuration = { canUseFeishuBusinessIdentity: jest.fn(() => true) }, workflow = { isEnabled: () => true };
  beforeEach(async () => {
    originalApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_adapter'; configuration.canUseFeishuBusinessIdentity.mockReturnValue(true);
    temporaryRoot = realpathSync(tmpdir()); owner = randomUUID(); directory = mkdtempSync(join(temporaryRoot,'nt-leave-adapter-')); writeFileSync(join(directory,'.test-owner'),owner,{flag:'wx'}); file = join(directory,'ledger.json'); store = new LeaveWorkflowStore(file,file);
    const snapshot = { applicantName: '合成申请人', applicantOpenId: 'ou_synthetic_applicant', applicantPersonRecordId: 'recApplicantFixture', building: 'C楼', position: '运维值班员', leaveType: '年假', startAt: '2026-10-13T09:00:00+08:00', endAt: '2026-10-13T18:00:00+08:00', leaveHours: 8, approvalDayCount: 1, reason: '合成验收' };
    await store.acceptApplication({clientMutationId:'synthetic-adapter-request',recordId:'recLeaveFixture',snapshot});
    await store.setApprovalPlan('recLeaveFixture',{snapshot:(await store.getApplication('recLeaveFixture'))!.snapshot,approvalPlan:{approvalClass:'ordinary',discipline:null,approvalDayCount:1,stages:[{key:'supervisor',approvers:[source],resolutionPolicy:'first_legal_action'}],notificationPlan:{finalResultRecipients:[source],professionalRecipients:[],substituteRecipients:[]}},resultRecipients:[source]});
    await store.setPendingStage('recLeaveFixture',{key:'supervisor',version:1,approverOpenIds:[source.openId]});
    adapter = new LeavePersonnelHandoverAdapter(store,configuration as never,workflow as never);
  });
  afterEach(() => {
    if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalApp;
    const canonical = (value: string) => resolve(value).toLowerCase();
    if (canonical(dirname(directory)) !== canonical(temporaryRoot) || !/^nt-leave-adapter-[A-Za-z0-9]+$/u.test(basename(directory)) || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory)) throw new Error('测试目录归属异常，已保留');
    for (const name of readdirSync(directory)) if (!lstatSync(join(directory,name)).isFile() || lstatSync(join(directory,name)).isSymbolicLink()) throw new Error('测试目录条目异常，已保留');
    if (readFileSync(join(directory,'.test-owner'),'utf8') !== owner) throw new Error('测试目录归属标记异常，已保留'); rmSync(directory,{recursive:true,force:false});
  });
  it('正式模块注册导出适配器，Nest缺鉴权依赖拒绝、显式依赖可实例化且无初始化副作用', async () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS,LeaveWorkflowModule)).toContain(LeavePersonnelHandoverAdapter);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS,LeaveWorkflowModule)).toContain(LeavePersonnelHandoverAdapter);
    const base=[LeavePersonnelHandoverAdapter,{provide:LeaveWorkflowStore,useValue:store},{provide:LeaveWorkflowService,useValue:workflow}];
    await expect(Test.createTestingModule({providers:base}).compile()).rejects.toThrow('AccessConfigurationService');
    const before=readFileSync(file,'utf8');
    const module=await Test.createTestingModule({providers:[...base,{provide:AccessConfigurationService,useValue:configuration}]}).compile();
    try { expect(module.get(LeavePersonnelHandoverAdapter).module).toBe('leave'); expect(readFileSync(file,'utf8')).toBe(before); }
    finally { await module.close(); }
  });
  it('原审批native身份变化时即使OU相同也拒绝受理，回执native身份必须一致', async () => {
    const [item]=await adapter.listPending(context()), before=readFileSync(file,'utf8');
    await expect(adapter.acceptTransfer({...context(),from:{...context().from,recordId:'recWrongSource'}},item,mutationId)).rejects.toThrow('稳定身份');
    expect(readFileSync(file,'utf8')).toBe(before);
    const receipt=await adapter.acceptTransfer(context(),item,mutationId);
    expect((await adapter.reconcile(context(),{...receipt,version:'999'})).status).toBe('error');
    expect((await adapter.reconcile(context(),{...receipt,itemKey:`leave:${item.recordId}:manager:1`})).status).toBe('error');
  });
  it('只列出选定职责的原审批待办，并绑定实际阶段版本', async () => {
    const items = await adapter.listPending(context()); expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ module:'leave',recordId:'recLeaveFixture',dutyRecordId:'recDutyFixture',stageKey:'supervisor',version:'1',status:'pending',recipients:[{name:source.name,openId:source.openId}] });
    expect(await adapter.preflight(context(),items[0])).toEqual({ready:true});
    expect(await adapter.listPending({...context(),duties:context().duties.map(duty=>({...duty,buildings:['A楼']}))})).toEqual([]);
    expect((await adapter.preflight(context(),{...items[0],version:'2'})).ready).toBe(false);
  });
  it('真实主表计划中前任尚未开始的经理阶段也必须可见阻断',async()=>{
    const app=(await store.getApplication('recLeaveFixture'))!,plan=app.approvalPlan!;
    plan.stages.push({key:'manager',approvers:[source],resolutionPolicy:'first_legal_action'});
    await store.setApprovalPlan(app.recordId,{snapshot:app.snapshot,approvalPlan:plan,resultRecipients:app.resultRecipients});
    await store.setPendingStage(app.recordId,{key:'supervisor',version:1,approverOpenIds:[source.openId]});
    const before=readFileSync(file,'utf8');await expect(adapter.listPending(context())).rejects.toThrow('尚未开始');expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('旧预览后出现未完成通知，确认前与实际转办前都阻断且不落盘',async()=>{
    const [item]=await adapter.listPending(context());
    await store.enqueueTask({recordId:item.recordId,businessKey:'synthetic-unfinished-notification',kind:'deliver_result_cards'});
    const before=readFileSync(file,'utf8');expect((await adapter.preflight(context(),item)).ready).toBe(false);
    await expect(adapter.acceptTransfer(context(),item,mutationId)).rejects.toThrow('通知');expect(readFileSync(file,'utf8')).toBe(before);
  });
  it('preflight之后、native CAS之前新增通知仍在同一原子账本中阻断',async()=>{
    const [item]=await adapter.listPending(context());expect((await adapter.preflight(context(),item)).ready).toBe(true);
    const original=store.acceptPersonnelHandover.bind(store);let injected='';
    const spy=jest.spyOn(store,'acceptPersonnelHandover').mockImplementationOnce(async input=>{
      await store.enqueueTask({recordId:item.recordId,businessKey:'synthetic-native-window-notice',kind:'deliver_result_cards'});injected=readFileSync(file,'utf8');return original(input);
    });
    try{await expect(adapter.acceptTransfer(context(),item,mutationId)).rejects.toThrow('通知');expect(readFileSync(file,'utf8')).toBe(injected);}finally{spy.mockRestore();}
  });
  it('真实CAS持久受理，重启只读恢复，主任务完成但新卡未投递仍为同步中', async () => {
    const [item] = await adapter.listPending(context()); const receipt = await adapter.acceptTransfer(context(),item,mutationId);
    expect(receipt).toMatchObject({itemKey:item.key,mutationId,module:'leave',recordId:item.recordId,version:'2',status:'accepted'});
    const restarted = new LeavePersonnelHandoverAdapter(new LeaveWorkflowStore(file,file),configuration as never,workflow as never);
    expect((await restarted.preflight(context(),item,mutationId)).ready).toBe(true);
    expect((await restarted.preflight({...context(),to:{...context().to,recordId:'recWrongTarget'}},item,mutationId)).ready).toBe(false);
    const before = readFileSync(file,'utf8'); expect(await restarted.acceptTransfer(context(),item,mutationId)).toEqual(receipt); expect(readFileSync(file,'utf8')).toBe(before);
    expect(await restarted.reconcile(context(),receipt)).toEqual({status:'syncing'});
    for (let index=0; index<10; index++) { const task=await store.takeNextTask(new Date(Date.now()+60_000)); if(!task) break; await store.completeTask(task.key,task.claimToken); }
    expect(await restarted.reconcile(context(),receipt)).toEqual({status:'syncing'});
    await store.recordStageCardDelivery(item.recordId,{recipientOpenId:target.openId,messageId:'om_synthetic_new',businessKey:`leave:${item.recordId}:stage:supervisor:2:${target.openId}`});
    expect(await restarted.reconcile(context(),receipt)).toEqual({status:'success'});
    expect((await restarted.reconcile({...context(),to:{...context().to,recordId:'recWrongIdentity'}},receipt)).status).toBe('error');
  });
  it('预览后原审批先决议时跳过历史，接任自审批或已收权不受理', async () => {
    const [item]=await adapter.listPending(context());
    expect((await adapter.preflight({...context(),to:{...context().to,recordId:'recApplicantFixture'}},item)).ready).toBe(false);
    configuration.canUseFeishuBusinessIdentity.mockReturnValue(false);
    expect((await adapter.preflight(context(),item)).ready).toBe(false);
    configuration.canUseFeishuBusinessIdentity.mockReturnValue(true);
    await store.claimStageAction({eventId:'synthetic-before-transfer',recordId:item.recordId,stageKey:'supervisor',stageVersion:1,actorOpenId:source.openId,action:'approve'});
    expect(await adapter.preflight(context(),item)).toMatchObject({ready:false,alreadyCompleted:true});
    const before=readFileSync(file,'utf8'); expect((await adapter.acceptTransfer(context(),item,mutationId)).status).toBe('already_completed'); expect(readFileSync(file,'utf8')).toBe(before);
  });
});
