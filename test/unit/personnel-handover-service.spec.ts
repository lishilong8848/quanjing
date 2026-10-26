import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PersonnelHandoverService, type HandoverAuthorityPort } from '../../server/common/access/personnel-handover.service';
import { PersonnelHandoverStore, handoverItemMutationId } from '../../server/common/access/personnel-handover.store';
import { accountPermissionTemplate, previewPermissionInheritance } from '../../server/common/access/personnel-handover.preview';
import type { HandoverAdapter, HandoverContext, HandoverModule, HandoverPreviewRequest, PendingDuty } from '../../shared/personnel-handover.interface';
import type { PreviewContent } from '../../server/common/access/personnel-handover.baseline';
import { PERSONNEL_HANDOVER_SCOPE } from '../../shared/personnel-handover-scope';
const modules:HandoverModule[]=['purchase','inventory','contracts','leave','overtime'];
const actor={ id:'synthetic-admin',name:'合成管理员' };
const request:HandoverPreviewRequest={ fromPersonId:'old',toPersonId:'new',dutyRecordIds:['synthetic-duty'],mode:'offboarding' };
const person=(id:string,active:boolean)=>({ id,recordId:`rec-${id}`,name:`合成-${id}`,openId:`ou_synthetic_${id}`,active,type:'employee' as const,position:'设施示例人员001',systemPosition:'',buildings:['C楼' as const],specialties:[],permissionTags:[],dutyRecordIds:['synthetic-duty'] });
function fixture() {
  const source=accountPermissionTemplate({ id:'old-account',kind:'feishu',name:'合成前任',role:'building_admin',building:'C楼',enabled:false,deleted:false,version:3,source:'configuration' });
  const before=accountPermissionTemplate({ id:'new-account',kind:'feishu',name:'合成接任',role:'site_member',building:null,enabled:true,deleted:false,version:2,source:'configuration' });
  const from=person('old',false),to=person('new',true);
  const context:HandoverContext={ from,to,directoryVersion:'a'.repeat(64),duties:[{ recordId:'synthetic-duty',name:'合成C楼示例人员001',kind:'building_supervisor',personnelIds:['old'],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:4 }] };
  const content:PreviewContent={ requested:request,baseline:{ configurationRevision:8,directoryVersion:context.directoryVersion,accounts:[{ id:'old-account',version:3 },{ id:'new-account',version:2 }],duties:[{ recordId:'synthetic-duty',version:4 }],pending:[] },from,to,permissions:[{ ...previewPermissionInheritance(source,before),sourceAccountId:'old-account',targetAccountId:'new-account' }],pending:[],excluded:[],conflicts:[],warnings:[] };
  const authority:HandoverAuthorityPort={ assertAdministrator:jest.fn().mockResolvedValue(undefined),snapshot:jest.fn().mockResolvedValue({ ready:true,content,context }),restoreContext:jest.fn().mockResolvedValue(context),applyPermissions:jest.fn().mockResolvedValue(undefined) };
  const item:PendingDuty={ key:'leave:synthetic-item',module:'leave',recordId:'synthetic-item',title:'合成请休假',dutyRecordId:'synthetic-duty',phase:'approval',status:'pending',stageKey:'supervisor',version:'stage-2',recipients:[{ name:from.name,openId:from.openId }] };
  const adapters:HandoverAdapter[]=modules.map(module=>({ module,listPending:jest.fn().mockResolvedValue(module === 'leave' ? [item] : []),preflight:jest.fn().mockResolvedValue({ ready:true }),acceptTransfer:jest.fn().mockImplementation(async (_context,selected,mutationId)=>({ itemKey:selected.key,mutationId,module,recordId:selected.recordId,version:'stage-3',status:'accepted' })),reconcile:jest.fn().mockResolvedValue({ status:'success' }) }));
  return { authority,content,context,item,adapters,leave:adapters[3] };
}
describe('持久交接编排（合成数据）',()=>{
  let directory:string,temporaryRoot:string,owner:string,store:PersonnelHandoverStore;
  beforeEach(()=>{ temporaryRoot=realpathSync(tmpdir()); owner=randomUUID(); directory=mkdtempSync(join(temporaryRoot,'nt-handover-service-')); writeFileSync(join(directory,'.test-owner'),owner,{flag:'wx'}); store=new PersonnelHandoverStore(join(directory,'handover.json')); });
  it('按所选职责读取对应模块，无关停用模块不阻断，处理前复核仍用相同模块范围',async()=>{
    const f=fixture();f.context.duties[0].kind='purchase_executor';
    const purchase=f.adapters[0],item={...f.item,module:'purchase' as const,key:'purchase:synthetic-record',stageKey:'purchase_executor'};
    for(const adapter of f.adapters) (adapter.listPending as jest.Mock).mockRejectedValue(new Error('synthetic unrelated module disabled'));
    (purchase.listPending as jest.Mock).mockResolvedValue([item]);
    const service=new PersonnelHandoverService(store,f.authority,f.adapters,PERSONNEL_HANDOVER_SCOPE);
    const preview=await service.preview(actor,request);expect(preview.pending).toMatchObject([{module:'purchase'}]);
    const batch=await service.confirm(actor,{request,expectedFingerprint:preview.fingerprint,clientMutationId:'synthetic-scoped-purchase-01'});
    expect((await service.process(batch.id)).status).toBe('success');
    for(const adapter of f.adapters.slice(1)) expect(adapter.listPending).not.toHaveBeenCalled();
    expect(purchase.acceptTransfer).toHaveBeenCalledTimes(1);
  });
  afterEach(()=>{
    const canonical=(value:string)=>resolve(value).toLowerCase();
    if (canonical(dirname(directory)) !== canonical(temporaryRoot) || !/^nt-handover-service-[A-Za-z0-9]+$/u.test(basename(directory)) || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory)) throw new Error('临时目录归属异常，已保留');
    for (const name of readdirSync(directory)) if (!lstatSync(join(directory,name)).isFile() || lstatSync(join(directory,name)).isSymbolicLink()) throw new Error('临时目录条目异常，已保留');
    if (readFileSync(join(directory,'.test-owner'),'utf8') !== owner) throw new Error('临时目录归属标记异常，已保留');
    rmSync(directory,{recursive:true,force:false});
  });
  async function accepted(service:PersonnelHandoverService) { const preview=await service.preview(actor,request); return service.confirm(actor,{ request,expectedFingerprint:preview.fingerprint,clientMutationId:'synthetic-confirm-0001' }); }
  const leaveOvertimeScope={ modules:['leave','overtime'] as const,dutyKinds:['building_supervisor','leave_supervisor','leave_manager','overtime_supervisor','overtime_manager'] as const };
  it('同一原申请的交接按阶段收口，等待前一步时仍处理其他申请，重启后继续同一批次',async()=>{
    const f=fixture(),second={...f.item,key:'leave:synthetic-item:second',stageKey:'manager'},independent={...f.item,key:'leave:unrelated',recordId:'unrelated'};
    (f.leave.listPending as jest.Mock).mockResolvedValue([f.item,second,independent]);
    let ready=false;(f.leave.reconcile as jest.Mock).mockImplementation(async(_context,receipt)=>({status:receipt.itemKey===f.item.key&&!ready?'syncing':'success'}));
    const service=new PersonnelHandoverService(store,f.authority,f.adapters,leaveOvertimeScope),batch=await accepted(service),first=await service.process(batch.id);
    expect(first.status).toBe('syncing');expect(first.items.find(row=>row.item.key===second.key)?.status).toBe('pending');
    expect((f.leave.acceptTransfer as jest.Mock).mock.calls.map(row=>row[1].key)).toEqual([f.item.key,independent.key]);
    ready=true;const restarted=new PersonnelHandoverService(new PersonnelHandoverStore(store.filePath),f.authority,f.adapters,leaveOvertimeScope);
    expect((await restarted.process(batch.id)).status).toBe('success');expect(f.authority.applyPermissions).toHaveBeenCalledTimes(1);
    expect((f.leave.acceptTransfer as jest.Mock).mock.calls.map(row=>row[1].key)).toEqual([f.item.key,independent.key,second.key]);
  });
  it('未生效批次取消持久化，重启后不能再次执行',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters,leaveOvertimeScope),batch=await accepted(service);
    const result=await service.cancel(actor,batch.id,batch.version);
    expect(result.status).toBe('cancelled');expect(result.cancelledBy).toBe(actor.id);
    const restarted=new PersonnelHandoverService(new PersonnelHandoverStore(store.filePath),f.authority,f.adapters,leaveOvertimeScope);
    expect((await restarted.process(batch.id)).status).toBe('cancelled');expect(f.authority.applyPermissions).not.toHaveBeenCalled();
  });
  it('权限已实际写入但进度未写时不允许取消',async()=>{
    const f=fixture();Object.assign(f.authority,{permissionsApplied:jest.fn().mockResolvedValue(true)});
    const service=new PersonnelHandoverService(store,f.authority,f.adapters,leaveOvertimeScope),batch=await accepted(service);
    await expect(service.cancel(actor,batch.id,batch.version)).rejects.toThrow('已生效');expect(store.read().batches[batch.id].status).toBe('accepted');
  });
  it('正在执行的批次不能取消或与开始执行交错',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters,leaveOvertimeScope),batch=await accepted(service);
    let release!:()=>void;(f.authority.applyPermissions as jest.Mock).mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
    const operation=service.process(batch.id);while(!release)await new Promise(resolve=>setTimeout(resolve,1));
    try{await expect(service.cancel(actor,batch.id,batch.version)).rejects.toThrow('正在执行');}finally{release();await operation;}
    await expect(service.cancel(actor,batch.id,store.read().batches[batch.id].version)).rejects.toThrow('已生效');
  });
  it('受理后新增范围内待办，首次权限写前重新核对并阻断，不先加权',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters,leaveOvertimeScope),batch=await accepted(service);
    (f.leave.listPending as jest.Mock).mockResolvedValue([f.item,{...f.item,key:'leave:new-item',recordId:'new-item'}]);
    const result=await service.process(batch.id);expect(result.permissionStatus).toBe('error');expect(f.authority.applyPermissions).not.toHaveBeenCalled();expect(f.leave.acceptTransfer).not.toHaveBeenCalled();
  });
  it('预览受理后新出现未支持通知会在首次权限写前阻断',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters,leaveOvertimeScope),batch=await accepted(service);
    (f.leave.listPending as jest.Mock).mockRejectedValue(new Error('通知范围未覆盖'));
    expect((await service.process(batch.id)).permissionStatus).toBe('error');expect(f.authority.applyPermissions).not.toHaveBeenCalled();
  });
  it('原合法审批先受理时不盲加权，也不转交或改写其历史',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters,leaveOvertimeScope),batch=await accepted(service);
    (f.leave.listPending as jest.Mock).mockResolvedValue([{...f.item,status:'in_progress'}]);
    expect((await service.process(batch.id)).permissionStatus).toBe('error');expect(f.authority.applyPermissions).not.toHaveBeenCalled();expect(f.leave.acceptTransfer).not.toHaveBeenCalled();
  });
  it('实际权限已写但进度未写的恢复不重新加权，后续业务冲突显示部分失败',async()=>{
    const f=fixture();Object.assign(f.authority,{permissionsApplied:jest.fn().mockResolvedValue(true)});
    const service=new PersonnelHandoverService(store,f.authority,f.adapters,leaveOvertimeScope),batch=await accepted(service);
    (f.leave.preflight as jest.Mock).mockResolvedValue({ready:false,reason:'审批范围已变化'});
    const result=await service.process(batch.id);expect(result.permissionStatus).toBe('success');expect(result.items[0].status).toBe('error');expect(result.status).toBe('error');
    expect(f.authority.applyPermissions).not.toHaveBeenCalled();expect(f.leave.acceptTransfer).not.toHaveBeenCalled();
  });
  it('明确两模块范围不依赖采购库存合同，确认仅受理且不提前外写',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters.filter(adapter=>['leave','overtime'].includes(adapter.module)),leaveOvertimeScope);
    const batch=await accepted(service);
    expect(batch.status).toBe('accepted');expect(batch.preview.pending.map(item=>item.module)).toEqual(['leave']);
    expect(f.authority.applyPermissions).not.toHaveBeenCalled();expect(f.leave.acceptTransfer).not.toHaveBeenCalled();
  });
  it('其他provider存在也不能在两模块范围查询或执行合同职责',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters,leaveOvertimeScope);
    await service.preview(actor,request);
    for(const adapter of f.adapters.filter(adapter=>!['leave','overtime'].includes(adapter.module)))expect(adapter.listPending).not.toHaveBeenCalled();
    f.context.duties[0].kind='contract_notify';
    await expect(service.preview(actor,request)).rejects.toThrow('所选职责不在已启用交接范围');
    expect(existsSync(store.filePath)).toBe(false);
  });
  it('声明范围缺加班或包含无效模块、重复模块不能消除门禁',async()=>{
    const f=fixture();
    await expect(new PersonnelHandoverService(store,f.authority,[f.leave],leaveOvertimeScope).preview(actor,request)).rejects.toThrow('审批模块尚未全部就绪');
    for(const modules of [['leave','leave'],['leave','unknown'],[]])expect(()=>new PersonnelHandoverService(store,f.authority,f.adapters,{...leaveOvertimeScope,modules:modules as never})).toThrow('交接启用范围无效');
    expect(existsSync(store.filePath)).toBe(false);
  });
  it('两模块恢复器拒绝其他范围持久批次且不应用其权限',async()=>{
    const f=fixture();(f.leave.listPending as jest.Mock).mockResolvedValue([]);
    const purchase=f.adapters.find(adapter=>adapter.module==='purchase')!;
    (purchase.listPending as jest.Mock).mockResolvedValue([{...f.item,key:'purchase:other',module:'purchase'}]);
    const batch=await accepted(new PersonnelHandoverService(store,f.authority,f.adapters));
    const before=readFileSync(store.filePath,'utf8'),scoped=new PersonnelHandoverService(store,f.authority,f.adapters,leaveOvertimeScope);
    await expect(scoped.process(batch.id)).rejects.toThrow('交接批次包含未启用模块');
    expect(f.authority.applyPermissions).not.toHaveBeenCalled();expect(purchase.acceptTransfer).not.toHaveBeenCalled();expect(readFileSync(store.filePath,'utf8')).toBe(before);
  });
  it('请求不能提供启用模块，构造参数后续变更也不扩大范围',async()=>{
    const f=fixture(),scope={modules:[...leaveOvertimeScope.modules],dutyKinds:[...leaveOvertimeScope.dutyKinds]};
    const service=new PersonnelHandoverService(store,f.authority,f.adapters,scope);
    (scope.modules as HandoverModule[]).push('contracts');
    await expect(service.preview(actor,{...request,enabledModules:['contracts']} as never)).rejects.toThrow('交接请求范围无效');
    await service.preview(actor,request);
    expect(f.adapters.find(adapter=>adapter.module==='contracts')!.listPending).not.toHaveBeenCalled();
  });
  it('服务器声明的职责与模块也必须对应，不能把合同职责声明为请休假范围',()=>{
    const f=fixture();expect(()=>new PersonnelHandoverService(store,f.authority,f.adapters,{modules:['leave','overtime'],dutyKinds:['contract_notify']})).toThrow('交接启用范围无效');
  });
  it('预览列全五模块，排除已完成历史；管理员确认只持久受理，不提前外写',async()=>{
    const f=fixture(); (f.leave.listPending as jest.Mock).mockResolvedValue([f.item,{ ...f.item,key:'leave:finished',status:'terminal' }]);
    const service=new PersonnelHandoverService(store,f.authority,f.adapters),preview=await service.preview(actor,request);
    expect(preview.pending).toHaveLength(1); expect(preview.excluded).toEqual([{ key:'leave:finished',reason:'已办结历史保持' }]);
    const batch=await service.confirm(actor,{ request,expectedFingerprint:preview.fingerprint,clientMutationId:'synthetic-confirm-0001' });
    expect(batch.status).toBe('accepted'); expect(new PersonnelHandoverStore(store.filePath).read().batches[batch.id].id).toBe(batch.id);
    expect(f.authority.applyPermissions).not.toHaveBeenCalled(); expect(f.leave.acceptTransfer).not.toHaveBeenCalled();
  });
  it('缺模块、未就绪目录、非管理员和预检失败均不落正式批次',async()=>{
    const f=fixture(); await expect(new PersonnelHandoverService(store,f.authority,f.adapters.slice(1)).preview(actor,request)).rejects.toThrow('审批模块尚未全部就绪');
    (f.authority.snapshot as jest.Mock).mockResolvedValueOnce({ ready:false,content:f.content,context:f.context });
    const service=new PersonnelHandoverService(store,f.authority,f.adapters); await expect(service.preview(actor,request)).rejects.toThrow('人员职责尚未就绪');
    (f.authority.assertAdministrator as jest.Mock).mockRejectedValueOnce(new Error('管理员权限无效')); await expect(service.preview(actor,request)).rejects.toThrow('管理员权限无效');
    const preview=await service.preview(actor,request); (f.leave.preflight as jest.Mock).mockResolvedValue({ ready:false,reason:'该审批刚刚被处理' });
    await expect(service.confirm(actor,{request,expectedFingerprint:preview.fingerprint,clientMutationId:'synthetic-confirm-0001'})).rejects.toThrow('该审批刚刚被处理');
    expect(existsSync(store.filePath)).toBe(false);
  });
  it('目录或权限变化拒绝旧确认；同管理员重复请求恢复原批次',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters),preview=await service.preview(actor,request);
    f.content.baseline.configurationRevision++;
    await expect(service.confirm(actor,{request,expectedFingerprint:preview.fingerprint,clientMutationId:'synthetic-confirm-0001'})).rejects.toThrow('交接清单已变化');
    const batch=await accepted(service); f.content.baseline.configurationRevision++;
    const duplicate=await service.confirm(actor,{request,expectedFingerprint:batch.fingerprint,clientMutationId:batch.clientMutationId}); expect(duplicate.id).toBe(batch.id); expect(store.read().revision).toBe(1);
  });
  it('正式受理后逐项转交，回执落盘；重启只重试通知步骤，不再次转审批',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters),batch=await accepted(service);
    (f.leave.reconcile as jest.Mock).mockResolvedValueOnce({status:'error',error:'synthetic-private-secret'});
    const failed=await service.process(batch.id); expect(failed.status).toBe('error'); expect(failed.items[0].receipt?.mutationId).toBe(handoverItemMutationId(batch.id,f.item.key));
    expect(readFileSync(store.filePath,'utf8')).not.toContain('synthetic-private-secret');
    const restarted=new PersonnelHandoverService(new PersonnelHandoverStore(store.filePath),f.authority,f.adapters),done=await restarted.process(batch.id);
    expect(done.status).toBe('success'); expect(f.leave.acceptTransfer).toHaveBeenCalledTimes(1); expect(f.authority.applyPermissions).toHaveBeenCalledTimes(1);
    await restarted.process(batch.id); expect(f.leave.reconcile).toHaveBeenCalledTimes(2);
  });
  it('业务已在并发中完成时跳过，原历史不复办',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters),batch=await accepted(service);
    (f.leave.acceptTransfer as jest.Mock).mockImplementationOnce(async(_context,item,mutationId)=>({itemKey:item.key,mutationId,module:'leave',recordId:item.recordId,version:'stage-3',status:'already_completed'}));
    expect((await service.process(batch.id)).items[0].status).toBe('skipped'); expect(f.leave.reconcile).not.toHaveBeenCalled();
  });
  it('确认前接任人离职拒绝受理；受理后身份关联变更停止外写',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters),preview=await service.preview(actor,request);
    (f.authority.restoreContext as jest.Mock).mockResolvedValueOnce({ ...f.context,to:{ ...f.context.to,active:false } });
    await expect(service.confirm(actor,{request,expectedFingerprint:preview.fingerprint,clientMutationId:'synthetic-confirm-0001'})).rejects.toThrow('接任人员状态已变化');
    expect(existsSync(store.filePath)).toBe(false);
    const batch=await accepted(service);
    (f.authority.restoreContext as jest.Mock).mockResolvedValueOnce({ ...f.context,to:{ ...f.context.to,openId:'ou_synthetic_unrelated' } });
    expect((await service.process(batch.id)).permissionStatus).toBe('error');
    expect(f.authority.applyPermissions).not.toHaveBeenCalled(); expect(f.leave.acceptTransfer).not.toHaveBeenCalled();
  });
  it('适配器返回伪造回执时保留失败状态，不继续通知或宣称成功',async()=>{
    const f=fixture(),service=new PersonnelHandoverService(store,f.authority,f.adapters),batch=await accepted(service);
    (f.leave.acceptTransfer as jest.Mock).mockResolvedValueOnce({ itemKey:f.item.key,mutationId:'synthetic-forged',module:'leave',recordId:f.item.recordId,version:'stage-3',status:'accepted' });
    const failed=await service.process(batch.id);
    expect(failed.status).toBe('error'); expect(failed.items[0].receipt).toBeUndefined(); expect(f.leave.reconcile).not.toHaveBeenCalled();
  });
});
