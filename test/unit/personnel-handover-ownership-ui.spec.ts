import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { completeHandoverOwnership, PersonnelHandoverOwnership, updateHandoverGrantChoice } from '../../client/src/pages/SystemConfiguration/PersonnelHandoverOwnership';
import type { HandoverPermissionOwnership, PersonnelHandoverPreview } from '../../shared/personnel-handover.interface';
jest.mock('../../client/src/pages/SystemConfiguration/model',()=>({ROLE_LABELS:{professional_engineer:'专业工程师',site_member:'基地成员'}}));
const source={role:'professional_engineer' as const,building:'B楼' as const,buildings:['B楼' as const],specialties:['电气' as const],sourceVersion:2,pagePaths:['/equipment-ledger-management'],personalRules:[{id:'extra-A',effect:'allow' as const,module:'equipment_ledger' as const,actions:['read' as const],buildings:['A楼' as const],specialties:['电气' as const]}]};
const preview=()=>({from:{name:'合成前任'},requested:{dutyRecordIds:['recDutyA'],mode:'rotation'},permissionOwnership:[{sourceAccountId:'feishu-synthetic',kind:'feishu',source,required:true,grantKeys:['role','rule:extra-A']},{sourceAccountId:'local-synthetic',kind:'local',source:{...source,sourceVersion:7},required:true,grantKeys:['role','rule:extra-A']}]} as unknown as PersonnelHandoverPreview);
describe('管理员权限归属编辑',()=>{
  it('同一人员两种登录方式一次选择同步，全部归属明确后才能重新预览',()=>{
    const p=preview();let value:HandoverPermissionOwnership[]=[];expect(completeHandoverOwnership(p,value)).toBe(false);
    value=updateHandoverGrantChoice(p,value,'feishu-synthetic','role',{disposition:'transfer',dutyRecordId:'recDutyA'});expect(value).toHaveLength(2);expect(completeHandoverOwnership(p,value)).toBe(false);
    value=updateHandoverGrantChoice(p,value,'local-synthetic','rule:extra-A',{disposition:'retain'});expect(completeHandoverOwnership(p,value)).toBe(true);expect(value[0].grants).toEqual(value[1].grants);
    value=updateHandoverGrantChoice(p,value,'feishu-synthetic','role',{disposition:'shared',dutyRecordId:'recOtherDuty'});expect(completeHandoverOwnership(p,value)).toBe(false);
  });
  it('展示姓名、岗位范围和业务动作，稳定编号只作内部关联',()=>{
    const html=renderToStaticMarkup(React.createElement(PersonnelHandoverOwnership,{preview:preview(),value:[],onChange:()=>{},onReload:()=>{},disabled:false,dutyNames:new Map([['recDutyA','A楼电气工程师']])}));
    expect(html).toContain('合成前任');expect(html).toContain('两种登录方式同步调整');expect(html).toContain('设备台账');expect(html).toContain('前任保留');expect(html).toContain('双方保留');expect(html).not.toContain('feishu-synthetic');expect(html).not.toContain('local-synthetic');expect((html.match(/aria-label="权限1归属"/g)||[]).length).toBe(1);
  });
});
