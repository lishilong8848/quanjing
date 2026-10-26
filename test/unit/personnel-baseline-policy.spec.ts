import { buildPersonnelBaselinePreview, validPersonnelBaseline } from '../../server/common/access/personnel-baseline.policy';
import { inspectPersonnelSource } from '../../server/common/access/personnel-source.policy';
import { resolveCurrentPersonnelDutyMembers } from '../../server/common/access/personnel-duty-current';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import type { ConfigurationState } from '../../server/common/access/access-configuration.store';

const appId='cli_baseline_synthetic', now=Date.UTC(2026,9,17,2), id='local-external-'+ 'a'.repeat(64);
const person={id,recordId:'recPerson',name:'合成负责人',openId:'ou_baseline_person',active:true,type:'employee' as const,position:'',systemPosition:'',buildings:['C楼' as const],specialties:[],permissionTags:[],dutyRecordIds:['recDuty']};
const duty={recordId:'recDuty',name:'C楼库房审批',kind:'warehouse_approver' as const,personnelIds:[id],buildings:['C楼' as const],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1};
const source={appId,appToken:'syntheticBase',tableId:'tblPeople',dutyTableId:'tblDuties'};
const directory=():ConfigurationDirectorySnapshot=>({appId,people:[person],employees:[],snapshotAt:now,personnelComplete:true,employmentState:{complete:true,entries:[{personnelIdentity:id,openId:person.openId,inactive:false}]},personnelAuthority:{mode:'shadow',version:'d'.repeat(64),source,snapshotAt:now,people:[person],duties:[duty],problems:[],issues:[]}});
const state=():ConfigurationState=>({schemaVersion:1,revision:0,legacySessionsRevoked:false,accounts:{},cardRules:{},audit:[],mutations:{}});
const evidence=()=>({recDuty:{source:'原楼栋库房职责',members:[{openId:person.openId,name:'旧展示名'}],observedAt:now}});

describe('首次独立基线，确认不改变现行路由',()=>{
  it('同应用稳定身份与现行岗位完全一致才给出可批量确认清单，姓名只展示',()=>{
    const preview=buildPersonnelBaselinePreview(directory(),state(),evidence(),appId,now);
    expect(preview).toMatchObject({canConfirm:true,rows:[{status:'aligned',members:[person.name]}]});
    expect(preview.previewFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('空表、跨应用、缺人或有效原来源不同都不能确认，不按姓名猜映射',()=>{
    const empty=directory();empty.personnelAuthority!.duties=[];
    expect(buildPersonnelBaselinePreview(empty,state(),{},appId,now).canConfirm).toBe(false);
    expect(buildPersonnelBaselinePreview(directory(),state(),evidence(),'cli_other',now).canConfirm).toBe(false);
    expect(buildPersonnelBaselinePreview(directory(),state(),{},appId,now).canConfirm).toBe(false);
    const different=evidence();different.recDuty.members=[{openId:'ou_other',name:person.name}];
    expect(buildPersonnelBaselinePreview(directory(),state(),different,appId,now).canConfirm).toBe(false);
  });
  it('独立基线存储与route确认引用严格验证，不接受仅有UUID的伪交接',()=>{
    expect(validPersonnelBaseline({id:'f3f2249e-6f5d-47c2-bc9d-1ef9422f2002',rows:{}})).toBe(false);
  });
  it('合法首次确认只让source具备独立激活资格，不改变Stage3有效路由或写入assignment',()=>{
    const before=state(), preview=buildPersonnelBaselinePreview(directory(),before,evidence(),appId,now);
    const confirmation={id:'f3f2249e-6f5d-47c2-bc9d-1ef9422f2002',source,directoryVersion:preview.directoryVersion,oldSourceFingerprint:preview.oldSourceFingerprint,previewFingerprint:preview.previewFingerprint,confirmedAt:now,actorId:'synthetic-admin',actorName:'合成管理员',rows:preview.assignments};
    const next={...before,personnelBaseline:{currentId:confirmation.id,confirmations:{[confirmation.id]:confirmation}}};
    expect(validPersonnelBaseline(confirmation)).toBe(true);
    expect(resolveCurrentPersonnelDutyMembers(before,appId,'warehouse_approver',{building:'C楼'})).toBeNull();
    expect(resolveCurrentPersonnelDutyMembers(next,appId,'warehouse_approver',{building:'C楼'})).toBeNull();
    expect(next.personnelDutyAssignments).toBeUndefined();expect(next.personnelSource).toBeUndefined();
    expect(inspectPersonnelSource(directory(),next,appId,now).preview.canActivate).toBe(true);
  });
});
