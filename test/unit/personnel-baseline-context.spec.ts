import { verifyPersonnelBaselineContext } from '../../server/common/access/personnel-baseline.context';
import type { ConfigurationState } from '../../server/common/access/access-configuration.store';
import type { AuthorityDuty, AuthorityPerson } from '../../shared/personnel-authority.interface';

const state:ConfigurationState={schemaVersion:1,revision:0,legacySessionsRevoked:false,accounts:{},cardRules:{},audit:[],mutations:{}};
const person:AuthorityPerson={id:'local-external-'+'a'.repeat(64),recordId:'recSupervisor',openId:'ou_supervisor',name:'主管',active:true,type:'employee',position:'设施运维主管',systemPosition:'',buildings:['C楼'],specialties:[],permissionTags:[],dutyRecordIds:['recDuty']};
const duty:AuthorityDuty={recordId:'recDuty',name:'C楼请假主管',kind:'leave_supervisor',personnelIds:[person.id],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1};
const records=()=>[
  {personRecordId:'recApplicant',name:'申请人',openId:'ou_applicant',position:'运维值班员',buildings:['C楼'],supervisorNames:['主管']},
  {personRecordId:'recLegacySupervisor',name:'主管',openId:'ou_supervisor',position:'设施运维主管',buildings:['C楼']},
  {personRecordId:'recManager',name:'经理',openId:'ou_manager',position:'设施运维经理',buildings:['C楼']},
];
describe('首次基线必须保持原动态审批算法',()=>{
  it('用真实原请假算法比较1天和3天审批，稳定身份相同而展示名/主表记录号不同仍等价',()=>{
    expect(()=>verifyPersonnelBaselineContext(duty,[{...person,name:'更新展示名'}],state,'cli_context_synthetic',records(),undefined)).not.toThrow();
  });
  it('同楼栋不同直属关系不能并集或任取一人确认',()=>{
    const mixed=[...records(),{personRecordId:'recOtherApplicant',name:'另一申请人',openId:'ou_other_applicant',position:'运维值班员',buildings:['C楼'],supervisorNames:['另一主管']},
      {personRecordId:'recOtherSupervisor',name:'另一主管',openId:'ou_other_supervisor',position:'设施运维主管',buildings:['C楼']}];
    expect(()=>verifyPersonnelBaselineContext(duty,[person],state,'cli_context_synthetic',mixed,undefined)).toThrow(/同范围/);
  });
  it('没有真实适用上下文或旧关系缺失不能虚构有效基线',()=>{
    expect(()=>verifyPersonnelBaselineContext(duty,[person],state,'cli_context_synthetic',[],undefined)).toThrow(/未找到/);
    const broken=records();broken[0].supervisorNames=['不存在的主管'];
    expect(()=>verifyPersonnelBaselineContext(duty,[person],state,'cli_context_synthetic',broken,undefined)).toThrow(/现行审批关系/);
  });
  it.each([
    ['H楼','值班账号'],
    ['110站','电气主管'],
  ] as const)('保留加班%s的既有特殊上级链，不把岗位记录本人当成其主管', (building,position)=>{
    const target={...duty,kind:'overtime_supervisor' as const,buildings:[building]},holder={...person,buildings:[building]};
    const organization=[{name:'申请人',openId:'ou_applicant',position:'运维值班员',buildings:[building]},
      {name:'原路由岗位',openId:'ou_seat',position,buildings:[building],supervisorNames:['主管']},
      {name:'主管',openId:'ou_supervisor',position:'设施运维主管',buildings:[building]},
      {name:'经理',openId:'ou_manager',position:'设施运维经理',buildings:[building]}];
    expect(()=>verifyPersonnelBaselineContext(target,[holder],state,'cli_context_synthetic',undefined,organization)).not.toThrow();
    expect(()=>verifyPersonnelBaselineContext(target,[{...holder,openId:'ou_seat'}],state,'cli_context_synthetic',undefined,organization)).toThrow(/同范围/);
  });
  it('同一原申请跨两个职责范围不能以部分新岗位冒充全范围',()=>{
    const organization=records();organization[0].buildings=['C楼','D楼'];
    expect(()=>verifyPersonnelBaselineContext(duty,[person],state,'cli_context_synthetic',organization,undefined)).toThrow(/现行审批关系/);
  });
});
