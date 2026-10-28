import { effectiveCardDuties } from '../../server/common/access/effective-card-duties';
import { filterActivePersonnelDutyMembers } from '../../server/common/access/personnel-duty-eligibility';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import type { ConfigurationState } from '../../server/common/access/access-configuration.store';
import type { PersonnelDutyAssignment } from '../../shared/personnel-duty-routing';

const appId='cli_effective_duties';
const route=():PersonnelDutyAssignment=>({appId,dutyRecordId:'recDutyC',kind:'warehouse_approver',buildings:['C楼'],specialties:null,startsAt:0,endsAt:null,version:1,
  confirmedBatchId:'eb761f03-468f-4a86-b971-1f074fa695cc',members:[{personId:`local-external-${'a'.repeat(64)}`,recordId:'recPersonA',openId:'ou_current',name:'合成现任'}]});
function fixture():ConfigurationState{return {schemaVersion:1,revision:4,legacySessionsRevoked:false,accounts:{},audit:[],mutations:{},
  cardRules:{'warehouse_responsible:C楼':{appId,code:'warehouse_responsible',building:'C楼',version:1,members:[{openId:'ou_old',name:'合成前任'}]}},personnelDutyAssignments:{recDutyC:route()}};}
const duty=(state:ConfigurationState)=>effectiveCardDuties(state,appId).find(item=>item.code==='warehouse_responsible'&&item.building==='C楼')!;

describe('effective card duties use current routing',()=>{
  it('projects the confirmed handover and never displays the obsolete configured recipient',()=>{
    expect(duty(fixture())).toMatchObject({status:'resolved',source:'handover',members:[{openId:'ou_current',name:'合成现任'}],revision:4});
  });
  it('a missing specialty is blocked instead of falling back to an old card rule',()=>{
    const state=fixture();state.personnelDutyAssignments!.recDutyC.specialties=['电气'];
    expect(duty(state)).toMatchObject({status:'blocked',source:'handover',members:[]});
  });
  it('unmanaged defaults stay unknown while an explicitly cleared route stays resolved empty',()=>{
    const state=fixture();expect(effectiveCardDuties(state,appId).find(item=>item.code==='purchase_manager')).toMatchObject({status:'unknown',source:'default',members:[]});
    state.personnelDutyAssignments!.recDutyC.members=[];expect(duty(state)).toMatchObject({status:'resolved',source:'handover',members:[]});
  });
  it('a source read error keeps the still-valid confirmed route and exposes its degraded status',()=>{
    const state=fixture();state.personnelSource={status:'error',error:'合成读取失败',source:{appId,appToken:'syntheticBase',tableId:'tblPeople',dutyTableId:'tblDuties'},
      directoryVersion:'a'.repeat(64),activatedAt:Date.now(),lastSuccessAt:Date.now(),pending:[],routes:{recDutyC:route()}};
    expect(duty(state)).toMatchObject({status:'resolved',source:'personnel',sourceStatus:'error',members:[{openId:'ou_current',name:'合成现任'}]});
    state.personnelSource.status='paused';expect(duty(state)).toMatchObject({status:'blocked',source:'personnel',sourceStatus:'paused',members:[]});
  });
  it('reactivation-required identities remain ineligible even when latest personnel status is active',()=>{
    const id=`feishu-${feishuIdentityFingerprint(appId,'ou_current')}`,state=fixture();
    state.personnelEmployment={appId,snapshotAt:Date.now(),inactive:{[id]:false},loginBlocked:{[id]:true}};
    expect(filterActivePersonnelDutyMembers(state,appId,[{openId:'ou_current',name:'合成现任'}])).toEqual([]);
    expect(duty(state)).toMatchObject({status:'resolved',members:[]});
  });
});
