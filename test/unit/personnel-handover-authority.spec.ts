import { buildHandoverAuthoritySnapshot } from '../../server/common/access/personnel-handover.authority';
import { accountPermissionTemplate } from '../../server/common/access/personnel-handover.preview';
import { normalizeHandoverPreview, handoverFingerprint } from '../../server/common/access/personnel-handover.baseline';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import type { AccessConfigurationResponse, ManagedAccount } from '../../shared/access-configuration.interface';
import type { AuthorityPerson } from '../../shared/personnel-authority.interface';
import type { PersonnelPermissionArchive } from '../../shared/personnel-handover.interface';
import { handoverPermissionGrantKeys } from '../../server/common/access/personnel-handover.ownership';
import { canPerformBusinessAction } from '../../shared/business-permissions';
import { buildAuthorityDuties } from '../../server/common/access/personnel-authority.duties';

const appId='cli_handover_authority_fixture';
function fixture(){
  const from:AuthorityPerson={id:'local-external-'+ 'a'.repeat(64),recordId:'recOld',name:'合成前任',openId:'ou_old',active:false,type:'employee',position:'C楼主管',systemPosition:'',buildings:['C楼'],specialties:[],permissionTags:[],dutyRecordIds:[]};
  const to:AuthorityPerson={...from,id:'local-external-'+ 'b'.repeat(64),recordId:'recNew',name:'合成接任',openId:'ou_new',active:true};
  const account=(person:AuthorityPerson):ManagedAccount=>({id:'feishu-'+feishuIdentityFingerprint(appId,person.openId!),kind:'feishu',appId,name:person.name,role:'site_member',building:null,version:2,enabled:true,deleted:false,source:'configuration',personnelIdentity:person.id,identityHash:feishuIdentityFingerprint(appId,person.openId!)});
  const source={...account(from),role:'building_admin' as const,building:'C楼' as const,enabled:false,permissionsRevoked:true,guestLoginAllowed:true};
  const state:AccessConfigurationResponse={appId,revision:8,accounts:[source,account(to)],cardRules:[],audit:[]};
  const archive:PersonnelPermissionArchive={accountId:source.id,name:source.name,appId,personnelIdentity:from.id,capturedAt:'2026-10-14T00:00:00Z',configurationRevision:7,template:accountPermissionTemplate({...source,version:1,enabled:true,permissionsRevoked:false})};
  const directory:ConfigurationDirectorySnapshot={appId,people:[],employees:[],snapshotAt:Date.now(),personnelComplete:true,employmentState:{complete:true,entries:[{personnelIdentity:from.id,openId:from.openId,inactive:true},{personnelIdentity:to.id,openId:to.openId,inactive:false}]},personnelAuthority:{mode:'shadow',version:'c'.repeat(64),snapshotAt:Date.now(),source:{appId,appToken:'fixture',tableId:'tblPeople'},people:[from,to],duties:[{recordId:'recDuty',name:'C楼请休假主管',kind:'leave_supervisor',personnelIds:[to.id],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:3}],problems:[],issues:[]}};
  const request={fromPersonId:from.id,toPersonId:to.id,dutyRecordIds:['recDuty'],mode:'offboarding' as const};
  return {from,to,state,archive,directory,request};
}
describe('实际交接authority基线（合成主表）',()=>{
  it('主表派生岗位通过原交接与规范化清单，不冒充云记录或预先转办',()=>{
    const f=fixture(),authority=f.directory.personnelAuthority!;f.to.position='设施运维主管';
    authority.source={...authority.source,kind:'personnel_positions'};
    authority.duties=buildAuthorityDuties([],[f.from,f.to],authority.source).duties;
    const request={...f.request,dutyRecordIds:authority.duties.map(duty=>duty.recordId)};
    const result=buildHandoverAuthoritySnapshot(f.directory,f.state,[f.archive],request);
    expect(result.content.dutyRouting).toHaveLength(3);
    expect(result.content.dutyRouting!.every(row=>row.assignment.origin==='personnel_position'&&row.assignment.dutyRecordId.startsWith('position-'))).toBe(true);
    const preview=normalizeHandoverPreview({...result.content,fingerprint:handoverFingerprint(result.content),createdAt:new Date().toISOString()});
    expect(preview.requested.dutyRecordIds).toEqual(request.dutyRecordIds);expect(preview.dutyRouting).toEqual(result.content.dutyRouting);
    expect(f.state.personnelDutyAssignments).toBeUndefined();
  });
  it('在职轮岗按逐项归属拆分，其他任职额外权限留给前任，不整包复制',()=>{
    const f=fixture();f.from.active=true;f.directory.employmentState!.entries[0].inactive=false;Object.assign(f.state.accounts[0],{enabled:true,permissionsRevoked:false,personalRules:[{id:'other-H-duty',effect:'allow',module:'inventory',actions:['read','confirm'],buildings:['H楼'],specialties:null}]});
    const template=accountPermissionTemplate(f.state.accounts[0]);
    const ownership=[{sourceAccountId:f.state.accounts[0].id,grants:handoverPermissionGrantKeys(template).map(key=>({key,disposition:key==='rule:other-H-duty'?'retain' as const:'transfer' as const,...(key==='rule:other-H-duty'?{}:{dutyRecordId:'recDuty'})}))}];
    const result=buildHandoverAuthoritySnapshot(f.directory,f.state,[],{...f.request,mode:'rotation',ownership});const row=result.content.permissions[0];
    expect(result.content.conflicts).toEqual([]);expect(row.transfer?.personalRules?.some(rule=>rule.id==='other-H-duty')).toBeFalsy();expect(row.sourceRetained?.personalRules?.some(rule=>rule.id==='other-H-duty')).toBe(true);
    expect(canPerformBusinessAction({role:row.after.role,purchaseBuilding:row.after.building,buildings:row.after.buildings,personalRules:row.after.personalRules},{module:'inventory',action:'confirm',building:'H楼',specialty:'电气'})).toBe(false);
    const normalized=normalizeHandoverPreview({...result.content,fingerprint:handoverFingerprint(result.content),createdAt:new Date().toISOString()});expect(normalized.requested.ownership).toEqual(ownership.map(value=>({...value,grants:[...value.grants].sort((a,b)=>a.key.localeCompare(b.key))})));
  });
  it('轮岗没有确认权限归属时列明冲突，不能默认把其他任职一起撤走',()=>{
    const f=fixture();f.from.active=true;f.directory.employmentState!.entries[0].inactive=false;Object.assign(f.state.accounts[0],{enabled:true,permissionsRevoked:false});
    expect(buildHandoverAuthoritySnapshot(f.directory,f.state,[],{...f.request,mode:'rotation'}).content.conflicts.join('')).toContain('归属');
  });
  it('收权前存档与当前双身份版本绑定，输出可规范化且不含凭据',()=>{
    const f=fixture(),result=buildHandoverAuthoritySnapshot(f.directory,f.state,[f.archive],f.request);
    expect(result.context.duties[0].recordId).toBe('recDuty');expect(result.content.permissions[0].source.role).toBe('building_admin');
    expect(result.content.baseline.archives?.[0].accountId).toBe(f.archive.accountId);
    const preview=normalizeHandoverPreview({...result.content,fingerprint:handoverFingerprint(result.content),createdAt:new Date().toISOString()});
    expect(preview.permissions[0].after.role).toBe('building_admin');expect(JSON.stringify(result)).not.toMatch(/passwordHash|appToken|身份证/);
  });
  it('未知任职状态、目录问题、跨应用和无飞书身份都拒绝',()=>{
    for(const alter of [
      (f:ReturnType<typeof fixture>)=>{f.directory.employmentState!.entries.pop();},
      (f:ReturnType<typeof fixture>)=>{f.directory.personnelAuthority!.problems.push('职责表尚未配置');},
      (f:ReturnType<typeof fixture>)=>{f.directory.appId='cli_foreign';},
      (f:ReturnType<typeof fixture>)=>{delete f.to.openId;},
    ]){const f=fixture();alter(f);expect(()=>buildHandoverAuthoritySnapshot(f.directory,f.state,[f.archive],f.request)).toThrow();}
  });
  it('接任者全撤权、手工停用、删除都不能通过继承恢复',()=>{
    for(const flags of [{permissionsRevoked:true,guestLoginAllowed:true},{enabled:false},{deleted:true}]){const f=fixture();Object.assign(f.state.accounts[1],flags);expect(()=>buildHandoverAuthoritySnapshot(f.directory,f.state,[f.archive],f.request)).toThrow();}
  });
  it('全撤权前任不能伪装轮岗；缺收权前存档不复制游客模板',()=>{
    const f=fixture();f.from.active=true;f.directory.employmentState!.entries[0].inactive=false;
    expect(()=>buildHandoverAuthoritySnapshot(f.directory,f.state,[f.archive],{...f.request,mode:'rotation'})).toThrow();
    const g=fixture();expect(()=>buildHandoverAuthoritySnapshot(g.directory,g.state,[],g.request)).toThrow('收权前授权存档');
  });
  it('前任多身份权限不一致会阻断，不静默选一个覆盖接任者',()=>{
    const f=fixture();const extra:ManagedAccount={...f.state.accounts[0],id:f.from.id,kind:'local',loginMethod:'personnel-password',personnelAppId:appId,role:'professional_admin',building:null,specialties:['电气']};f.state.accounts.push(extra);
    const second={...f.archive,accountId:extra.id,template:accountPermissionTemplate({...extra,enabled:true,permissionsRevoked:false,version:1})};
    expect(()=>buildHandoverAuthoritySnapshot(f.directory,f.state,[f.archive,second],f.request)).toThrow('多个登录账号权限不一致');
  });
  it('资料未同步和非本人职责拒绝，保持输入原字节语义',()=>{
    const f=fixture(),before=JSON.stringify(f);f.state.accounts[0].permissionsRevoked=false;
    expect(()=>buildHandoverAuthoritySnapshot(f.directory,f.state,[f.archive],f.request)).toThrow('人员权限状态尚未对齐');
    f.state.accounts[0].permissionsRevoked=true;f.directory.personnelAuthority!.duties[0].personnelIds=['someone-else'];
    expect(()=>buildHandoverAuthoritySnapshot(f.directory,f.state,[f.archive],f.request)).toThrow();
    f.directory.personnelAuthority!.duties[0].personnelIds=[f.to.id];expect(JSON.stringify(f)).toBe(before);
  });
});
