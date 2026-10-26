import { createHash } from 'node:crypto';
import type { PersonnelBaselineConfirmation, PersonnelBaselineEvidence, PersonnelBaselinePreview, PersonnelBaselineState } from '../../../shared/personnel-baseline.interface';
import type { ConfigurationDirectorySnapshot } from './access-configuration.directory';
import type { ConfigurationState } from './access-configuration.store';
import { inspectPersonnelSource } from './personnel-source.policy';
import { validPersonnelDutyAssignments } from './personnel-duty-routing';
import { validPersonnelSourceBinding } from '../../../shared/personnel-source.interface';

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=500&&!/[\u0000-\u001f\u007f]/u.test(value);
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

export function buildPersonnelBaselinePreview(directory: ConfigurationDirectorySnapshot, state: ConfigurationState, evidence: Record<string,PersonnelBaselineEvidence>, appId: string, now = Date.now()): PersonnelBaselinePreview {
  const inspected=inspectPersonnelSource(directory,{...state,personnelSource:undefined,personnelBaseline:undefined},appId,now);
  const result:PersonnelBaselinePreview={configurationRevision:state.revision,directoryVersion:inspected.preview.directoryVersion,oldSourceFingerprint:'',previewFingerprint:'',checkedAt:now,canConfirm:false,
    problems:[...inspected.preview.problems],unmanagedKinds:inspected.preview.unmanagedKinds,rows:[],assignments:{}};
  if(state.personnelSource)result.problems.push('岗位来源已启用过，请使用岗位交接维护现有职责');
  const candidates={...inspected.routes,...Object.fromEntries(inspected.pending.flatMap(row=>row.candidate?[[row.dutyRecordId,row.candidate]]:[]))};
  for(const row of inspected.preview.rows){
    const prior=evidence[row.dutyRecordId],candidate=candidates[row.dutyRecordId];
    let problem=prior?.problem;
    if(!prior||!text(prior.source)||!Number.isSafeInteger(prior.observedAt)||prior.observedAt<now-5*60_000||prior.observedAt>now+60_000)problem='现行岗位来源尚未核实，请重新核对';
    if(!problem&&(!candidate||!Array.isArray(prior.members)||!prior.members.length||prior.members.some(person=>!/^ou_[A-Za-z0-9_-]{1,124}$/.test(person.openId))||
      JSON.stringify([...new Set(prior.members.map(person=>person.openId))].sort())!==JSON.stringify(candidate.members.map(person=>person.openId).sort())))problem='现行有效人员与岗位候选不一致，请核对人员关联';
    result.rows.push({...row,source:prior?.source||'待核对',status:problem?'unconfirmed':'aligned',...(problem?{reason:problem}:{reason:undefined})});
    if(problem)result.problems.push(`${row.name}：${problem}`);
    else{const {confirmedBatchId:_handover,baselineConfirmationId:_baseline,...definition}=candidate;result.assignments[row.dutyRecordId]=definition;}
  }
  result.problems=[...new Set(result.problems)];
  result.oldSourceFingerprint=digest(Object.entries(evidence).sort(([a],[b])=>a.localeCompare(b)).map(([id,value])=>[id,value.source,[...new Set(value.members.map(person=>person.openId))].sort(),value.problem||null]));
  result.canConfirm=!result.problems.length&&result.rows.length>0&&result.rows.every(row=>row.status==='aligned');
  result.previewFingerprint=digest([appId,result.configurationRevision,result.directoryVersion,result.oldSourceFingerprint,Object.entries(result.assignments).sort(([a],[b])=>a.localeCompare(b)),result.problems]);
  return result;
}
export function validPersonnelBaseline(value: unknown): value is PersonnelBaselineConfirmation {
  if(!record(value)||Object.keys(value).sort().join(',')!=='actorId,actorName,confirmedAt,directoryVersion,id,oldSourceFingerprint,previewFingerprint,rows,source'||!uuid(value.id)||
    !validPersonnelSourceBinding(value.source)||
    ![value.directoryVersion,value.oldSourceFingerprint,value.previewFingerprint].every(hash)||!Number.isSafeInteger(value.confirmedAt)||Number(value.confirmedAt)<0||!text(value.actorId)||!text(value.actorName)||
    !record(value.rows)||!Object.keys(value.rows).length||Object.keys(value.rows).length>1000)return false;
  try{return validPersonnelDutyAssignments(Object.fromEntries(Object.entries(value.rows).map(([id,row])=>{
    if(!record(row)||row.dutyRecordId!==id||row.appId!==(value.source as Record<string,unknown>).appId||!Array.isArray(row.members)||!row.members.length)throw Error('Invalid baseline row');
    if(row.origin==='personnel_position'&&(value.source as Record<string,unknown>).kind!=='personnel_positions')throw Error('Position baseline requires its actual source kind');
    if(Object.prototype.hasOwnProperty.call(row,'confirmedBatchId')||Object.prototype.hasOwnProperty.call(row,'baselineConfirmationId'))throw Error('Baseline rows cannot claim a different confirmation');
    return [id,{...row,baselineConfirmationId:value.id}];
  })));}catch{return false;}
}
export function validPersonnelBaselines(value:unknown):value is PersonnelBaselineState{
  return record(value)&&Object.keys(value).sort().join(',')==='confirmations,currentId'&&uuid(value.currentId)&&record(value.confirmations)&&Object.keys(value.confirmations).length<=20&&
    Object.entries(value.confirmations).every(([id,row])=>validPersonnelBaseline(row)&&row.id===id)&&Object.prototype.hasOwnProperty.call(value.confirmations,value.currentId);
}
