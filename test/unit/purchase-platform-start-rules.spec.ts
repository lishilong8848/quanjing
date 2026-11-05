import { buildStartPatch } from '../../server/modules/purchase-inventory/purchase-workflow.rules';
describe('platform start preserves procurement assignee',()=>{
 const actor:any={openId:'',name:'平台人员',positions:[],buildings:[],platformActions:['start']};
 const base:any={recordId:'rec_one',status:'审批通过（待库房确认）',building:'C楼',purchaseMethod:'需求自采',requesterOpenId:'ou_requester',purchaserOpenId:'ou_assigned'};
 it('keeps the existing assigned purchaser even when another person starts',()=>{expect(buildStartPatch(base,actor,actor)['采购人']).toEqual([{id:'ou_assigned'}]);});
 it('uses the original requester for self purchase when unassigned',()=>{expect(buildStartPatch({...base,purchaserOpenId:''},actor,actor)['采购人']).toEqual([{id:'ou_requester'}]);});
 it('uses the routed purchaser for comprehensive purchase when unassigned',()=>{expect(buildStartPatch({...base,purchaseMethod:'综合采购',purchaserOpenId:''},actor,{...actor,openId:'ou_buyer'})['采购人']).toEqual([{id:'ou_buyer'}]);});
 it('rejects missing purchaser, invalid method and wrong stage',()=>{expect(()=>buildStartPatch({...base,purchaserOpenId:'',requesterOpenId:''},actor,actor)).toThrow();expect(()=>buildStartPatch({...base,purchaseMethod:'驳回'},actor,actor)).toThrow();expect(()=>buildStartPatch({...base,status:'驳回申请'},actor,actor)).toThrow();});
});
