import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { PersonnelBaselineService } from '../../server/common/access/personnel-baseline.service';
import { PersonnelSourceService } from '../../server/common/access/personnel-source.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { resolveCurrentPersonnelDutyMembers } from '../../server/common/access/personnel-duty-current';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { PersonnelBaselineEvidence } from '../../shared/personnel-baseline.interface';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import { buildAuthorityDuties } from '../../server/common/access/personnel-authority.duties';

const appId='cli_baseline_service_synthetic', person={id:'local-external-'+'a'.repeat(64),recordId:'recPerson',openId:'ou_baseline_person',name:'合成岗位人员',active:true,type:'employee' as const,position:'值班人员',systemPosition:'',buildings:['C楼' as const],specialties:[],permissionTags:[],dutyRecordIds:['recDuty']};
const directory=():ConfigurationDirectorySnapshot=>({appId,people:[person],employees:[],snapshotAt:Date.now(),personnelComplete:true,employmentState:{complete:true,entries:[{personnelIdentity:person.id,openId:person.openId,inactive:false}]},
  personnelAuthority:{mode:'shadow',version:'d'.repeat(64),snapshotAt:Date.now(),source:{appId,appToken:'syntheticBase',tableId:'tblPeople',dutyTableId:'tblDuties'},people:[person],problems:[],issues:[],duties:[{recordId:'recDuty',name:'C楼库房审批',kind:'warehouse_approver',personnelIds:[person.id],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]}});

describe('首次基线原配置事务与独立激活',()=>{
  let store:stores.AccessConfigurationStore,configuration:AccessConfigurationService,service:PersonnelBaselineService,actor:AccessPrincipal,prior:Record<string,PersonnelBaselineEvidence>,current:ConfigurationDirectorySnapshot;
  let root:string,folder:string,owner:string,previous:NodeJS.ProcessEnv,read:jest.Mock,readPrior:jest.Mock;
  beforeEach(async()=>{
    previous={...process.env};process.env.FEISHU_APP_ID=appId;process.env.LOCAL_ACCESS_SESSION_SECRET=randomBytes(32).toString('base64');
    root=realpathSync(tmpdir());folder=mkdtempSync(join(root,'nt-baseline-'));owner=randomUUID();writeFileSync(join(folder,'.test-owner'),owner,{flag:'wx'});
    store=new stores.AccessConfigurationStore(join(folder,'configuration.json'));jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(store);jest.spyOn(defaults,'defaultAccessAccounts').mockReturnValue({});
    const hash=feishuIdentityFingerprint(appId,'ou_baseline_admin'),id=`feishu-${hash}`;
    await store.mutate(0,'seed-baseline-admin','seed',state=>{state.accounts[id]={id,appId,identityHash:hash,openId:'ou_baseline_admin',name:'合成管理员',kind:'feishu',role:'admin',building:null,enabled:true,deleted:false,source:'configuration',version:1};
      state.cardRules['warehouse_responsible:C楼']={appId,code:'warehouse_responsible',building:'C楼',version:1,members:[{openId:person.openId,name:person.name}]};});
    configuration=new AccessConfigurationService();actor={role:'admin',purchaseBuilding:null,accountId:id,authorizationVersion:1,displayName:'合成管理员'};current=directory();
    prior={recDuty:{source:'原库房审批',observedAt:Date.now(),members:[{openId:person.openId,name:person.name}]}};
    read=jest.fn(async()=>({...structuredClone(current),snapshotAt:Date.now(),personnelAuthority:{...structuredClone(current.personnelAuthority!),snapshotAt:Date.now()}}));
    readPrior=jest.fn(async()=>({...structuredClone(prior),recDuty:{...structuredClone(prior.recDuty),observedAt:Date.now()}}));
    service=new PersonnelBaselineService(configuration,{read} as never,{read:readPrior} as never);
  });
  afterEach(()=>{jest.restoreAllMocks();process.env=previous;if(resolve(dirname(folder)).toLowerCase()!==resolve(root).toLowerCase()||realpathSync(folder)!==folder||lstatSync(folder).isSymbolicLink()||readFileSync(join(folder,'.test-owner'),'utf8')!==owner)throw Error('测试目录归属异常');rmSync(folder,{recursive:true});});
  const input=(preview:{configurationRevision:number;previewFingerprint:string})=>({clientMutationId:randomUUID(),expectedRevision:preview.configurationRevision,expectedFingerprint:preview.previewFingerprint});
  it('空额外职责表的主表岗位经一次确认落盘，重试不重复写，单独启用后重启保留同一来源',async()=>{
    const member={...person,position:'设施运维主管',dutyRecordIds:[]},source={appId,appToken:'syntheticBase',tableId:'tblPeople',kind:'personnel_positions' as const};
    current=directory();current.personnelAuthority!.source=source;current.personnelAuthority!.people=[member];current.personnelAuthority!.duties=buildAuthorityDuties([],[member],source).duties;
    prior=Object.fromEntries(current.personnelAuthority!.duties.map(duty=>[duty.recordId,{source:'合成现行路由已核对',members:[{openId:member.openId,name:member.name}],observedAt:Date.now()}]));
    readPrior.mockImplementation(async()=>Object.fromEntries(Object.entries(prior).map(([id,value])=>[id,{...structuredClone(value),observedAt:Date.now()}])));
    const before=store.read(),operation=input(await service.preview(actor)),confirmed=await service.confirm(operation,actor);
    expect(confirmed.personnelBaseline!.count).toBe(3);expect(store.read().personnelSource).toBeUndefined();
    const revision=store.read().revision,calls=read.mock.calls.length;await service.confirm({...operation},actor);expect(store.read().revision).toBe(revision);expect(read).toHaveBeenCalledTimes(calls);
    expect(store.read().accounts).toEqual(before.accounts);expect(store.read().cardRules).toEqual(before.cardRules);
    const sourceService=new PersonnelSourceService(configuration,{read} as never,service);
    await sourceService.change({action:'activate',clientMutationId:randomUUID(),expectedRevision:store.read().revision,expectedDirectoryVersion:current.personnelAuthority!.version},actor);
    const persisted=new stores.AccessConfigurationStore(store.filePath).read();expect(persisted.personnelSource!.source).toEqual(source);
    expect(Object.values(persisted.personnelSource!.routes).every(route=>route.origin==='personnel_position'&&route.baselineConfirmationId===confirmed.personnelBaseline!.id)).toBe(true);
    expect(resolveCurrentPersonnelDutyMembers(persisted,appId,'warehouse_approver',{building:'C楼'})).toEqual([{openId:member.openId,name:member.name}]);
    expect(persisted.accounts).toEqual(before.accounts);expect(persisted.personnelDutyAssignments).toBeUndefined();
  });
  it('只读预览与一次确认均保持账号、旧卡片、assignment和当前Stage3路由，摘要不泄露凭证',async()=>{
    const before=store.read(),bytes=readFileSync(store.filePath),preview=await service.preview(actor);expect(preview.canConfirm).toBe(true);expect(readFileSync(store.filePath)).toEqual(bytes);
    const result=await service.confirm(input(preview),actor),after=store.read();
    expect(after.accounts).toEqual(before.accounts);expect(after.cardRules).toEqual(before.cardRules);expect(after.personnelDutyAssignments).toBeUndefined();expect(after.personnelSource).toBeUndefined();
    expect(resolveCurrentPersonnelDutyMembers(after,appId,'warehouse_approver',{building:'C楼'})).toEqual(resolveCurrentPersonnelDutyMembers(before,appId,'warehouse_approver',{building:'C楼'}));
    expect(result.personnelBaseline).toMatchObject({count:1,actorName:'合成管理员'});expect(JSON.stringify(result)).not.toContain('passwordHash');
    expect(new stores.AccessConfigurationStore(store.filePath).read().personnelBaseline?.currentId).toBe(result.personnelBaseline!.id);
  });
  it('同mutation跨重启重试不再核源、不重复确认；同id改内容拒绝',async()=>{
    const operation=input(await service.preview(actor));await service.confirm(operation,actor);const calls=readPrior.mock.calls.length,revision=store.read().revision;
    const restored=new PersonnelBaselineService(configuration,{read} as never,{read:readPrior} as never);await restored.confirm({...operation},actor);
    expect(readPrior).toHaveBeenCalledTimes(calls);expect(store.read().revision).toBe(revision);
    await expect(restored.confirm({...operation,expectedFingerprint:'e'.repeat(64)},actor)).rejects.toThrow(/重复请求/);
  });
  it('旧源变化或配置版本变化时拒绝，不留下半确认',async()=>{
    const operation=input(await service.preview(actor));prior.recDuty.members=[{openId:'ou_other',name:person.name}];await expect(service.confirm(operation,actor)).rejects.toThrow(/已变化/);expect(store.read().personnelBaseline).toBeUndefined();
    prior.recDuty.members=[{openId:person.openId,name:person.name}];await store.mutate(store.read().revision,'baseline-other-version','change',state=>{state.audit.push({id:randomUUID(),at:new Date().toISOString(),actorId:actor.accountId!,actorName:'合成管理员',target:'合成',action:'版本变化',before:'',after:''});});
    await expect(service.confirm(operation,actor)).rejects.toThrow(/已变化|版本/);expect(store.read().personnelBaseline).toBeUndefined();
  });
  it('人工停用在职负责人仍会阻断首次确认，不被人员表在职覆盖',async()=>{
    const operation=input(await service.preview(actor)),identityHash=feishuIdentityFingerprint(appId,person.openId),id=`feishu-${identityHash}`;
    await store.mutate(store.read().revision,'baseline-holder-disabled','disable',state=>{state.accounts[id]={id,appId,identityHash,openId:person.openId,name:person.name,personnelIdentity:person.id,kind:'feishu',role:'site_member',building:null,enabled:false,deleted:false,source:'configuration',version:1};});
    expect((await service.preview(actor)).canConfirm).toBe(false);await expect(service.confirm(operation,actor)).rejects.toThrow(/已变化/);expect(store.read().personnelBaseline).toBeUndefined();
  });
  it('baseline不能塞入Stage3 assignments，虚构source确认UUID也不能持久化',async()=>{
    await service.confirm(input(await service.preview(actor)),actor);const state=store.read(),proof=state.personnelBaseline!.confirmations[state.personnelBaseline!.currentId],row=proof.rows.recDuty;
    await expect(store.mutate(state.revision,'baseline-not-stage-three','forged',current=>{current.personnelDutyAssignments={recDuty:{...row,baselineConfirmationId:proof.id}};})).rejects.toThrow(/配置/);
    await expect(store.mutate(state.revision,'baseline-no-fake-proof','forged',current=>{current.personnelSource={status:'active',source:proof.source,directoryVersion:proof.directoryVersion,activatedAt:Date.now(),lastSuccessAt:Date.now(),pending:[],routes:{recDuty:{...row,baselineConfirmationId:randomUUID()}}};})).rejects.toThrow(/配置/);
    expect(store.read().revision).toBe(state.revision);expect(store.read().personnelSource).toBeUndefined();expect(store.read().personnelDutyAssignments).toBeUndefined();
  });
  it('异步核源期间管理员撤权，不能用旧会话完成确认',async()=>{
    const operation=input(await service.preview(actor));let release!:()=>void;readPrior.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});return prior;});
    const pending=service.confirm(operation,actor);for(let index=0;index<10&&!release;index++)await Promise.resolve();expect(release).toBeDefined();
    await store.mutate(store.read().revision,'baseline-admin-revoked','change',state=>{state.accounts[actor.accountId!].version++;});release();await expect(pending).rejects.toThrow(/管理权限/);expect(store.read().personnelBaseline).toBeUndefined();
  });
  it('只有独立启用才接管baseline路由；启用后核对不再回读旧源',async()=>{
    await service.confirm(input(await service.preview(actor)),actor);const source=new PersonnelSourceService(configuration,{read} as never,service);
    const preview=await source.preview(actor);expect(preview.canActivate).toBe(true);
    await source.change({action:'activate',clientMutationId:randomUUID(),expectedRevision:configuration.snapshot().revision,expectedDirectoryVersion:preview.directoryVersion},actor);
    const persisted=store.read();expect(persisted.personnelSource?.routes.recDuty).toMatchObject({baselineConfirmationId:persisted.personnelBaseline!.currentId});expect(persisted.personnelSource?.routes.recDuty.confirmedBatchId).toBeUndefined();expect(persisted.personnelDutyAssignments).toBeUndefined();
    readPrior.mockRejectedValue(new Error('旧源不能再被读取'));expect((await source.preview(actor)).canActivate).toBe(true);
  });
  it('首次确认后启用前旧源变化，独立启用仍拒绝且不授予新路由',async()=>{
    await service.confirm(input(await service.preview(actor)),actor);prior.recDuty.members=[{openId:'ou_other',name:person.name}];const source=new PersonnelSourceService(configuration,{read} as never,service);
    await expect(source.change({action:'activate',clientMutationId:randomUUID(),expectedRevision:configuration.snapshot().revision,expectedDirectoryVersion:'d'.repeat(64)},actor)).rejects.toThrow(/首次确认已变化/);expect(store.read().personnelSource).toBeUndefined();
  });
});
