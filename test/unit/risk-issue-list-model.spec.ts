import type { AliRiskIssue } from '../../shared/risk-inspection.interface';
const model=()=>require('../../client/src/pages/RiskInspectionDashboard/issue-list-model');
const issues=[{id:'1',building:'A楼',owner:'甲、乙',specialty:'电气',status:'rectifying',description:'水泵'},
  {id:'2',building:'B楼',owner:'乙',specialty:'暖通',status:'completed',description:'空调'},
  {id:'3',building:'',owner:'',specialty:'电气',status:'rectifying',description:'其他'}] as AliRiskIssue[];
describe('risk issue list local filtering and grouping',()=>{
  it('combines field filters with search and exact person membership',()=>{
    expect(model().filterIssueList(issues,{building:'A楼',owner:'乙',specialty:'电气',status:'rectifying'},'水泵').map((x:AliRiskIssue)=>x.id)).toEqual(['1']);
    expect(model().filterIssueList(issues,{owner:'甲乙'},'')).toEqual([]);
  });
  it('groups without duplication and orders largest groups first, with empty fallback',()=>{
    const groups=model().groupIssueList(issues,'building');
    expect(groups.map((x:{label:string})=>x.label)).toContain('未填写');
    expect(groups.flatMap((x:{issues:AliRiskIssue[]})=>x.issues).length).toBe(3);
    expect(model().groupIssueList(issues,'none')).toHaveLength(1);
  });
});
