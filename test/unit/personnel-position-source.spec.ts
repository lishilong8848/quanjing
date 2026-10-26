import { buildAuthorityPeople } from '../../server/common/access/personnel-authority.people';
import { buildAuthorityDuties } from '../../server/common/access/personnel-authority.duties';
import { validPersonnelDutyAssignments } from '../../server/common/access/personnel-duty-routing';
import { buildPersonnelBaselinePreview, validPersonnelBaseline } from '../../server/common/access/personnel-baseline.policy';
import { inspectPersonnelSource, reconcilePersonnelSource } from '../../server/common/access/personnel-source.policy';
import type { AuthorityDuty, AuthorityPerson } from '../../shared/personnel-authority.interface';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import type { ConfigurationState } from '../../server/common/access/access-configuration.store';

const appId='cli_position_synthetic', binding={appId,appToken:'syntheticPositionBase',tableId:'tblPersonnel'}, now=Date.now();
const row=(record_id:string,position:string,scope:string[],extra={})=>({record_id,fields:{姓名:record_id,岗位:position,'机楼/专业':scope,'飞书 open_id':`ou_${record_id}`,'离职/异动情况':false,...extra}});
const people=(rows:ReturnType<typeof row>[])=>buildAuthorityPeople(rows,appId,binding.appToken,binding.tableId).people;
const parse=(members:AuthorityPerson[],records:unknown[]=[])=>Reflect.apply(buildAuthorityDuties,null,[records,members,binding]) as {duties:AuthorityDuty[];problems:string[];issues:{recordId?:string;message:string}[]};
const state=():ConfigurationState=>({schemaVersion:1,revision:0,legacySessionsRevoked:false,accounts:{},cardRules:{},audit:[],mutations:{}});
function directory(members:AuthorityPerson[],duties:AuthorityDuty[]):ConfigurationDirectorySnapshot {
  return {appId,people:[],employees:[],snapshotAt:now,personnelComplete:true,employmentState:{complete:true,entries:members.map(p=>({personnelIdentity:p.id,openId:p.openId,inactive:!p.active}))},
    personnelAuthority:{mode:'shadow',source:{...binding,kind:'personnel_positions'} as never,version:'a'.repeat(64),snapshotAt:now,people:members,duties,problems:[],issues:[]}};
}

describe('主表岗位来源：无需先补空职责表',()=>{
  it('从主表识别楼栋示例人员001、专业示例人员001和工程师；不伪造云记录身份',()=>{
    const result=parse(people([row('recLead','设施运维示例人员001',['B楼']),row('recPro','暖通示例人员001',['H楼','暖通']),row('recEng','电气工程师',['B楼'])]));
    expect(result.problems).toEqual([]);
    expect(result.duties).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:'building_supervisor',buildings:['B楼'],specialties:null,origin:'personnel_position'}),
      expect.objectContaining({kind:'building_executor',buildings:['B楼'],specialties:null,origin:'personnel_position'}),
      expect.objectContaining({kind:'professional_supervisor',buildings:null,specialties:['暖通'],origin:'personnel_position'}),
      expect.objectContaining({kind:'professional_engineer',buildings:['B楼'],specialties:['电气'],origin:'personnel_position'}),
    ]));
    expect(result.duties.every(d=>/^position-[a-f0-9]{64}$/.test(d.recordId))).toBe(true);
  });
  it('更换同岗位人员保留岗位键，改变楼栋得到新键，姓名变化不影响任职身份',()=>{
    const a=parse(people([row('recOld','设施运维示例人员001',['C楼'])])).duties.find(d=>d.kind==='building_supervisor')!;
    const b=parse(people([row('recNew','设施运维示例人员001',['C楼'])])).duties.find(d=>d.kind==='building_supervisor')!;
    const c=parse(people([row('recNew','设施运维示例人员001',['A楼'])])).duties.find(d=>d.kind==='building_supervisor')!;
    expect(a).toBeDefined();expect(b.recordId).toBe(a.recordId);expect(b.personnelIds).not.toEqual(a.personnelIds);expect(c.recordId).not.toBe(a.recordId);
  });
  it('同语义楼栋专业集合仅调整顺序不改变岗位键或制造新任职，来源不同不碰撞',()=>{
    const a=parse(people([row('recScope','库房审批',['B楼','A楼','暖通','电气'])]));
    const b=parse(people([row('recScope','库房审批',['电气','A楼','暖通','B楼'])]));
    expect(a.duties).toHaveLength(1);expect(b.duties).toEqual(a.duties);
    const another=Reflect.apply(buildAuthorityDuties,null,[[],people([row('recScope','库房审批',['B楼','A楼'])]),{...binding,tableId:'tblAnother'}]) as typeof a;
    expect(another.duties[0].recordId).not.toBe(a.duties[0].recordId);
  });
  it('人员缺稳定身份、工程师范围缺失或专业字段冲突时列具体例外，不按姓名补人',()=>{
    const result=parse(people([row('recNoId','设施运维示例人员001',['A楼'],{'飞书 open_id':''}),row('recNoFloor','电气工程师',[]),row('recWrong','暖通工程师',['B楼','电气'])]));
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.issues.map(x=>x.recordId)).toEqual(expect.arrayContaining(['recNoId','recNoFloor','recWrong']));
    expect(result.duties).toHaveLength(0);
  });
  it('同范围两位单人示例人员001不任取一人；异动勾选者不再成为候选',()=>{
    const conflict=parse(people([row('recOne','设施运维示例人员001',['D楼']),row('recTwo','设施运维示例人员001',['D楼'])]));
    expect(conflict.problems.length).toBeGreaterThan(0);
    expect(parse(people([row('recOff','设施运维示例人员001',['D楼'],{'离职/异动情况':true})])).duties).toEqual([]);
  });
  it('不把未标专业的实习助理岗位当作专业工程师，也不因此阻断其他明确岗位',()=>{
    const result=parse(people([row('recAssistant','设施运维助理工程师',['A楼']),row('recLead','设施运维示例人员001',['B楼'])]));
    expect(result.problems).toEqual([]);expect(result.duties.every(d=>d.kind!=='professional_engineer')).toBe(true);
  });
  it('体系岗位明确专业示例人员001时，结合专业职位识别全基地职责，不以H楼驻地收窄',()=>{
    const result=parse(people([row('recProfessional','安全&消防工程师',['H楼','安全'],{体系岗位:'专业示例人员001'})]));
    expect(result.problems).toEqual([]);expect(result.duties.filter(d=>d.kind==='professional_supervisor')).toEqual(expect.arrayContaining([
      expect.objectContaining({buildings:null,specialties:['消防']}),expect.objectContaining({buildings:null,specialties:['EHS']}),
    ]));
    expect(result.duties.some(d=>d.kind==='professional_engineer')).toBe(false);
  });
  it('任职标签不把采购申请人变成审批人或管理员，不覆盖已批准的其他任职',()=>{
    const result=parse(people([row('recApplicant','运维值班员',['B楼'],{权限身份:['采购人','库房管理员']}),row('recSafe','安全&消防工程师',['H楼','安全'])]));
    expect(result.duties.some(d=>['purchase_approver','purchase_manager','warehouse_approver'].includes(d.kind))).toBe(false);
    expect(result.duties.find(d=>d.kind==='professional_engineer')).toMatchObject({specialties:['消防','EHS'],buildings:['H楼']});
  });
  it('真实额外职责保留原record ID和双向关联规则，不复制派生键进云关联',()=>{
    const members=people([row('recLead','设施运维示例人员001',['A楼'],{任职职责:['recNotify']})]);
    const result=parse(members,[{record_id:'recNotify',fields:{职责名称:'额外知会',职责类型:'库房知会',在任人员:['recLead'],楼栋范围:['C楼'],启用:true,任职版本:1}}]);
    expect(result.problems).toEqual([]);
    expect(result.duties).toEqual(expect.arrayContaining([expect.objectContaining({recordId:'recNotify',kind:'warehouse_notify',buildings:['C楼']})]));
    expect(members[0].dutyRecordIds).toEqual(['recNotify']);
  });
  it('沿既定业务语义区分楼栋责任审批、库房管理知会、综合采购执行；采购人标签不变成审批',()=>{
    const members=people([row('recLead','设施运维示例人员001',['B楼']),row('recWarehouse','电气工程师',['B楼'],{权限身份:['库房管理员','采购人']}),row('recPurchase','综合管理',['H楼','综合'])]);
    const result=parse(members);
    expect(result.problems).toEqual([]);
    expect(result.duties).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:'warehouse_approver',personnelIds:[members[0].id],buildings:['B楼']}),
      expect.objectContaining({kind:'warehouse_notify',personnelIds:[members[1].id],buildings:['B楼']}),
      expect.objectContaining({kind:'purchase_executor',personnelIds:[members[2].id],buildings:null,specialties:null}),
    ]));
    expect(result.duties.some(d=>d.kind==='purchase_approver')).toBe(false);
  });
  it('独立派生来源经过真实首次批量确认才具备启用资格，引用仍严格校验',()=>{
    const members=people([row('recLead','设施运维示例人员001',['B楼'])]),duties=parse(members).duties,d=directory(members,duties),s=state();
    const evidence=Object.fromEntries(duties.map(duty=>[duty.recordId,{source:'现行有效岗位已核对',members:[{openId:members[0].openId!,name:members[0].name}],observedAt:now}]));
    const preview=buildPersonnelBaselinePreview(d,s,evidence,appId,now);
    expect(preview.canConfirm).toBe(true);expect(inspectPersonnelSource(d,s,appId,now).preview.canActivate).toBe(false);
    const proof={id:'ec014470-5213-4217-9279-e7d560a379ca',source:d.personnelAuthority!.source,directoryVersion:preview.directoryVersion,oldSourceFingerprint:preview.oldSourceFingerprint,previewFingerprint:preview.previewFingerprint,confirmedAt:now,actorId:'syntheticAdmin',actorName:'合成管理员',rows:preview.assignments};
    expect(validPersonnelBaseline(proof)).toBe(true);
    expect(validPersonnelBaseline({...proof,source:{...binding,dutyTableId:'tbl78a2f0ea7118d08'}})).toBe(false);
    s.personnelBaseline={currentId:proof.id,confirmations:{[proof.id]:proof as never}};
    const checked=inspectPersonnelSource(d,s,appId,now);expect(checked.preview.canActivate).toBe(true);
    expect(validPersonnelDutyAssignments(checked.routes)).toBe(true);
    const invalid=structuredClone(checked.routes);delete (Object.values(invalid)[0] as unknown as {origin?:string}).origin;
    expect(validPersonnelDutyAssignments(invalid)).toBe(false);expect(s.personnelDutyAssignments).toBeUndefined();
  });
  it('主表换人只生成待确认差异，人工停用和个人deny等账号数据原字节保留',()=>{
    const original=people([row('recOld','设施运维示例人员001',['C楼'])]),duties=parse(original).duties,s=state(),d=directory(original,duties);
    const evidence=Object.fromEntries(duties.map(duty=>[duty.recordId,{source:'已核对',members:[{openId:original[0].openId!,name:original[0].name}],observedAt:now}]));
    const p=buildPersonnelBaselinePreview(d,s,evidence,appId,now),proof={id:'ec014470-5213-4217-9279-e7d560a379ca',source:d.personnelAuthority!.source,directoryVersion:p.directoryVersion,oldSourceFingerprint:p.oldSourceFingerprint,previewFingerprint:p.previewFingerprint,confirmedAt:now,actorId:'syntheticAdmin',actorName:'合成管理员',rows:p.assignments};
    s.personnelBaseline={currentId:proof.id,confirmations:{[proof.id]:proof as never}};
    const initial=inspectPersonnelSource(d,s,appId,now);expect(initial.preview.canActivate).toBe(true);
    s.personnelSource={status:'active',source:initial.source!,directoryVersion:p.directoryVersion,activatedAt:now-1,lastSuccessAt:now,routes:initial.routes,pending:[]};
    s.accounts.unrelated={id:'unrelated',kind:'feishu',appId,identityHash:'b'.repeat(64),openId:'ou_unrelated',name:'其他任职',role:'professional_admin',building:null,specialties:['暖通'],enabled:false,deleted:false,version:7,
      personalRules:[{id:'synthetic-deny',effect:'deny',module:'inventory',actions:['read'],buildings:['A楼'],specialties:['电气']}] as never};
    const accountsBefore=JSON.stringify(s.accounts),replacement=people([row('recNew','设施运维示例人员001',['C楼'])]);
    reconcilePersonnelSource(s,directory(replacement,parse(replacement).duties));
    expect(s.personnelSource.status).toBe('pending');expect(s.personnelSource.pending.length).toBeGreaterThan(0);
    expect(JSON.stringify(s.accounts)).toBe(accountsBefore);expect(s.personnelDutyAssignments).toBeUndefined();
  });
});
