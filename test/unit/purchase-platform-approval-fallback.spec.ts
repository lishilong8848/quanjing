import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';

describe('platform approval runtime fallback boundary',()=>{
  const session:any={openId:'ou_test',permissionPrincipal:{accountId:'person'}};
  it('refuses an incomplete module instead of falling back to the independent writer',async()=>{
    const workflow:any={prepareWebApprovalAuthority:jest.fn(async()=>({scope:{building:'C楼'}}))};
    const service=new PurchaseOnlineApprovalService({} as never,workflow);
    const old=jest.spyOn(service,'acceptDecision').mockReturnValue({pending:true,taskId:'old-task',message:'已受理'});
    await expect(service.acceptAuthorizedDecision('rec_test',{decision:'approved'},session)).rejects.toThrow('本人有效账号');
    expect(workflow.prepareWebApprovalAuthority).not.toHaveBeenCalled();expect(old).not.toHaveBeenCalled();
  });
  it('never falls back to the independent writer when the unified provider is present but proof is missing',async()=>{
    const workflow:any={prepareWebApprovalAuthority:jest.fn()};const runtime:any={accept:jest.fn()};
    const service=new PurchaseOnlineApprovalService({} as never,workflow,runtime);const old=jest.spyOn(service,'acceptDecision');
    await expect(service.acceptAuthorizedDecision('rec_test',{decision:'approved'},session)).rejects.toThrow('本人有效账号');
    expect(workflow.prepareWebApprovalAuthority).not.toHaveBeenCalled();expect(old).not.toHaveBeenCalled();expect(runtime.accept).not.toHaveBeenCalled();
  });
  it('delegates a proven identity only to the unified runtime',async()=>{
    const workflow:any={prepareWebApprovalAuthority:jest.fn()},runtime:any={accept:jest.fn(async()=>({pending:true,taskId:'new-task',message:'已受理'}))};
    const service=new PurchaseOnlineApprovalService({} as never,workflow,runtime),proven={...session,platformProof:{source:'platform'}};
    expect(await service.acceptAuthorizedDecision('rec_test',{decision:'approved'},proven)).toMatchObject({taskId:'new-task'});
    expect(workflow.prepareWebApprovalAuthority).not.toHaveBeenCalled();expect(runtime.accept).toHaveBeenCalledTimes(1);
  });
});
