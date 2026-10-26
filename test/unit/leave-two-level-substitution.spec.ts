import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LeaveRequestImpactSchedule, LeaveRequestShiftGroup } from '../../shared/leave-request-impact';
import type { LeaveSubstituteCandidate } from '../../server/modules/leave-workflow/leave-workflow.types';

const helperPath=resolve(__dirname,'../../server/modules/leave-workflow/leave-two-level-substitution.ts');
function helper(){expect(existsSync(helperPath)).toBe(true);return require(helperPath);}
const person=(id:string,name:string):LeaveSubstituteCandidate=>({personRecordId:id,name,openId:`ou_${id}`,position:'运维值班员',buildings:['C楼']});
const applicant=person('rec_liang','梁煊晨'),wu=person('rec_wu','吴亚兵'),free=person('rec_free','示例人员008');
const group:LeaveRequestShiftGroup={shiftKey:'2026-10-16T09:00__2026-10-16T18:00',scheduleDate:'2026-10-16',startAt:'2026-10-16T09:00',endAt:'2026-10-16T18:00',kind:'white',shift:'白班',buildings:['D楼'],teams:['A班'],scheduleRecordIds:['rec_schedule_d'],leaveHours:9};
const schedules:LeaveRequestImpactSchedule[]=[{recordId:'rec_schedule_d',scheduleDate:'2026-10-16',building:'D楼',team:'A班',shift:'白班',dutyStaffActual:['梁煊晨']},{recordId:'rec_schedule_c',scheduleDate:'2026-10-16',building:'C楼',team:'B班',shift:'白班',dutyStaffActual:['吴亚兵']}];
const build=(rows=schedules,people=[applicant,wu,free])=>helper().buildTwoLevelSubstituteCandidates({group,schedules:rows,applicant,people});

describe('two-level leave substitution rules',()=>{
 it('offers the on-duty primary with its own actual post and only free backfill candidates',()=>{
  const candidates=build();const choice=candidates.find((x:any)=>x.person.personRecordId===wu.personRecordId);
  expect(choice.originalGroups).toHaveLength(1);
  expect(choice.originalGroups[0]).toMatchObject({buildings:['C楼'],scheduleRecordIds:['rec_schedule_c']});
  expect(choice.backfillCandidates.map((p:LeaveSubstituteCandidate)=>p.personRecordId)).toEqual(['rec_free']);
 });
 it('does not require a second person for a free primary',()=>{
  const result=helper().resolveTwoLevelSubstitution({candidates:build(),primaryPersonRecordId:'rec_free'});
  expect(result).toMatchObject({valid:true,backfills:[]});
 });
 it('requires backfill and rejects applicant, self and an unknown second person',()=>{
  const candidates=build();
  for(const id of [undefined,'rec_wu','rec_liang','rec_unknown'])expect(helper().resolveTwoLevelSubstitution({candidates,primaryPersonRecordId:'rec_wu',backfillPersonRecordId:id}).valid).toBe(false);
 });
 it('builds both sides of the confirmed Liang to Wu to free-person chain',()=>{
  const result=helper().resolveTwoLevelSubstitution({candidates:build(),primaryPersonRecordId:'rec_wu',backfillPersonRecordId:'rec_free'});
  expect(result).toMatchObject({valid:true,primary:{personRecordId:'rec_wu'},backfills:[{person:{personRecordId:'rec_free'},group:{buildings:['C楼'],scheduleRecordIds:['rec_schedule_c']}}]});
 });
 it('does not allow a third level when the second person has a conflicting shift',()=>{
  const rows=[...schedules,{recordId:'rec_free_shift',scheduleDate:'2026-10-16',building:'A楼',shift:'白班',dutyStaffActual:['示例人员008']}];
  const candidates=build(rows);
  expect(helper().resolveTwoLevelSubstitution({candidates,primaryPersonRecordId:'rec_wu',backfillPersonRecordId:'rec_free'}).valid).toBe(false);
 });
 it('preserves the adjacent-night restriction rather than treating it as a replaceable post',()=>{
  const rows=[schedules[0],{...schedules[1],scheduleDate:'2026-10-15',shift:'夜班'}];
  expect(build(rows).some((x:any)=>x.person.personRecordId==='rec_wu')).toBe(false);
 });
 it('fails closed for an unknown original shift or ambiguous personnel names',()=>{
  expect(build([schedules[0],{...schedules[1],shift:'未知班次'}]).some((x:any)=>x.person.personRecordId==='rec_wu')).toBe(false);
  expect(build(schedules,[applicant,wu,person('rec_other_wu','吴亚兵'),free]).some((x:any)=>x.person.personRecordId==='rec_wu')).toBe(false);
 });
});
