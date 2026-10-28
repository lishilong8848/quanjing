import { handoverPermissionGrantKeys, splitHandoverPermissionGrants, type HandoverGrantChoice } from '../../server/common/access/personnel-handover.ownership';
import type { AccountPermissionTemplate } from '../../shared/personnel-handover.interface';
const source=():AccountPermissionTemplate=>({role:'professional_engineer',building:'B楼',buildings:['B楼'],specialties:['电气'],sourceVersion:4,pagePaths:['/nantong-base','/equipment-ledger-management','/inventory-management'],personalRules:[
  {id:'extra-A-electric',effect:'allow',module:'equipment_ledger',actions:['read','export'],buildings:['A楼'],specialties:['电气']},
  {id:'keep-H-hvac',effect:'allow',module:'inventory',actions:['read','confirm'],buildings:['H楼'],specialties:['暖通']},
  {id:'limit-delete',effect:'deny',module:'inventory',actions:['delete'],buildings:['B楼'],specialties:['电气']},
]});
function choices():HandoverGrantChoice[]{return handoverPermissionGrantKeys(source()).map(key=>({key,disposition:key==='rule:extra-A-electric'?'transfer':'retain',...(key==='rule:extra-A-electric'?{dutyRecordId:'recDutyA'}:{})}));}
describe('权限归属按确认清单拆分',()=>{
  it('只转交已确认额外规则，其他任职及原角色不动；双方均保留原限制',()=>{
    expect(handoverPermissionGrantKeys(source())).toEqual(['role','rule:extra-A-electric','rule:keep-H-hvac']);
    const before=source(),bytes=JSON.stringify(before),result=splitHandoverPermissionGrants(before,choices(),['recDutyA']);
    expect(result.retained.role).toBe('professional_engineer');expect(result.retained.personalRules?.map(rule=>rule.id)).toEqual(['keep-H-hvac','limit-delete']);
    expect(result.transfer.role).toBe('site_member');expect(result.transfer.personalRules?.map(rule=>rule.id)).toEqual(['extra-A-electric','limit-delete','handover-base-schedule_assignments','handover-base-non_duty_schedule']);
    expect(result.transfer.personalRules?.slice(2)).toEqual([
      {id:'handover-base-schedule_assignments',effect:'deny',module:'schedule_assignments',actions:['read'],buildings:null,specialties:null},
      {id:'handover-base-non_duty_schedule',effect:'deny',module:'non_duty_schedule',actions:['read'],buildings:null,specialties:null},
    ]);expect(JSON.stringify(before)).toBe(bytes);
  });
  it('默认岗位权限转交后降为基地员工；仍需该默认权限时必须显式选择双方保留',()=>{
    for(const disposition of ['transfer','shared'] as const){const selected=choices().map(row=>row.key==='role'?{...row,disposition,dutyRecordId:'recDutyA'}:row);const result=splitHandoverPermissionGrants(source(),selected,['recDutyA']);expect(result.transfer.role).toBe('professional_engineer');expect(result.retained.role).toBe(disposition==='shared'?'professional_engineer':'site_member');expect(result.transfer.buildings).toEqual(['B楼']);if(disposition==='transfer'){expect(result.retained.building).toBeNull();expect(result.retained.specialties).toBeUndefined();}}
  });
  it('未知、重复、遗漏、其他岗位和未确认的选择均拒绝',()=>{
    const valid=choices();expect(()=>splitHandoverPermissionGrants(source(),valid.slice(1),['recDutyA'])).toThrow();expect(()=>splitHandoverPermissionGrants(source(),[...valid,valid[0]],['recDutyA'])).toThrow();expect(()=>splitHandoverPermissionGrants(source(),valid.map(row=>row.key==='role'?{...row,key:'unknown'}:row),['recDutyA'])).toThrow();expect(()=>splitHandoverPermissionGrants(source(),valid.map(row=>row.dutyRecordId?{...row,dutyRecordId:'recOtherDuty'}:row),['recDutyA'])).toThrow();
  });
  it('不能只转交默认角色而丢失其限制，转交后的业务权限不得大于原授权',()=>{
    const selected=choices().map(row=>row.key==='role'?{...row,disposition:'transfer' as const,dutyRecordId:'recDutyA'}:row),result=splitHandoverPermissionGrants(source(),selected,['recDutyA']);expect(result.transfer.personalRules?.find(rule=>rule.id==='limit-delete')?.effect).toBe('deny');expect(result.transfer.sourceVersion).toBe(4);expect(result.retained.sourceVersion).toBe(4);
  });
});
