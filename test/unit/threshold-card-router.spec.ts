import {FeishuCardActionRouter} from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { currentHotfixActivation, closeHotfixActivation } from '../../server/common/hotfix-runtime-activation';
const card={schema:'2.0',header:{title:{tag:'plain_text',content:'阈值验收'}},body:{elements:[]}};
describe('统一飞书回调接入阈值审批',()=>{
  beforeAll(async()=>{const gate=currentHotfixActivation();gate.completeBootstrap();await gate.refresh();expect(gate.isAcceptingNewWork()).toBe(true);});
  afterAll(async()=>{await closeHotfixActivation();});
  const create=()=>{const threshold={isEnabled:jest.fn(()=>true),handleCardAction:jest.fn(async()=>({claimed:true,card}))};const unused={isEnabled:()=>false};const router=new FeishuCardActionRouter(unused as never,unused as never,unused as never,{} as never,unused as never,unused as never,unused as never,threshold as never);return {router,threshold};};
  test('审批和工程师确认送到阈值服务，立即返回只读raw卡',async()=>{
    const {router,threshold}=create();for(const role of ['building','professional','engineer']){const payload={action:{tag:'button',value:{workflowType:'threshold_adjustment',role,action:role==='engineer'?'complete':'approve'}}};const result=await router.handle(payload);expect(result.card).toEqual({type:'raw',data:card});expect(threshold.handleCardAction).toHaveBeenLastCalledWith(payload);}expect(router.isAnyEnabled()).toBe(true);
  });
  test('驳回表单按表单名路由，导航只返回toast，不误入其他审批业务',async()=>{
    const {router,threshold}=create();threshold.handleCardAction.mockResolvedValueOnce({claimed:false,toast:'请填写驳回原因'} as never);const payload={action:{tag:'button',name:'threshold_reject_submit:ta-00000000-0000-4000-8000-000000000001:building',form_value:{threshold_rejection_reason:'验收原因'}}};const result=await router.handle(payload);expect(threshold.handleCardAction).toHaveBeenCalledWith(payload);expect(result.card).toBeUndefined();expect(result.toast.content).toBe('请填写驳回原因');
  });
  test('阈值服务未启用时明确报错，不调用审批处理',async()=>{
    const {router,threshold}=create();threshold.isEnabled.mockReturnValue(false);const result=await router.handle({action:{tag:'button',value:{workflowType:'threshold_adjustment'}}});expect(result.toast.type).toBe('error');expect(threshold.handleCardAction).not.toHaveBeenCalled();
  });
});
