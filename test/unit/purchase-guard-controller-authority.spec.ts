import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';
import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';
import { canPerformBusinessAction } from '../../shared/business-permissions';

describe('isolated purchase guard and controller authorization', () => {
  const makePrincipal = (role:string, id:string, allowed:boolean, building='C楼') => ({
    role, accountId:id, authorizationVersion:1, purchaseBuilding:null,
    effectiveAuthorization:{mode:'independent', baseline:{nativeRole:null,pages:[],rules:allowed ? [{id:'purchase-approve',module:'purchase',actions:['approve'],effect:'allow',buildings:[building],specialties:['电气']}] : []},overrides:{rules:[],allowPages:[],denyPages:[]}},
  });
  const people:Record<string,any> = {
    named:makePrincipal('guest','local-synthetic-person',true),
    supervisor:makePrincipal('building_admin','local-synthetic-supervisor',true),
    specialist:makePrincipal('professional_engineer','local-synthetic-specialist',true),
    denied:makePrincipal('guest','local-synthetic-denied',false),
    wrongScope:makePrincipal('guest','local-synthetic-wrong',true,'A楼'),
  };
  const access = {cookieName:'synthetic_access',isAccessControlEnabled:()=>true,renew:(token:string)=>people[token] ? {principal:people[token],principalFingerprint:'synthetic'} : null};
  const guard = new UnifiedAccessGuard(new Reflector(),access as never);
  const fakeWorkflow = {prepareWebApprovalAuthority: jest.fn(async (_recordId:string, session:any) => {
    const scope={building:'C楼',specialty:'电气'};
    if (!canPerformBusinessAction(session.permissionPrincipal,{module:'purchase',action:'approve',...scope} as never)) throw new ForbiddenException('scope denied');
    return {recordId:_recordId,scope,principal:session.permissionPrincipal,actorOpenId:session.openId};
  })};
  // This suite checks route forwarding; real signed-session/store/worker acceptance
  // is covered by purchase-platform-guard-http-isolation.spec.ts.
  const owners = new Map<string,string>();
  const runtime = {
    accept: jest.fn(async (recordId:string,_input:unknown,session:any) => {
      await fakeWorkflow.prepareWebApprovalAuthority(recordId, session);
      const taskId=`platform_${recordId}`; owners.set(taskId,session.permissionPrincipal.accountId);
      return {pending:true,taskId,message:'accepted'};
    }),
    status: jest.fn(async(taskId:string,session:any) => {
      if(owners.get(taskId)!==session.permissionPrincipal.accountId)throw new ForbiddenException('task owner');
      return {success:true,task:{id:taskId}};
    }),
  };
  const approval = new PurchaseOnlineApprovalService({} as never, fakeWorkflow as never, runtime as never);
  const controller = new PurchaseInventoryController({} as never,{} as never,{} as never,{} as never,approval,{} as never,{} as never,{} as never,{} as never,{} as never,{} as never,undefined);
  beforeEach(() => { owners.clear(); jest.clearAllMocks(); jest.useFakeTimers(); jest.spyOn(approval as any,'executeDecisionTask').mockResolvedValue(undefined); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });
  function request(who:string, method:string, path:string, handler:Function) {
    const req:any={method,url:path,originalUrl:path,headers:{cookie:`synthetic_access=${who}`},query:{}};
    const ctx:any={switchToHttp:()=>({getRequest:()=>req}),getHandler:()=>handler,getClass:()=>PurchaseInventoryController};
    return {req,allowed:guard.canActivate(ctx)};
  }
  it.each(['named','supervisor','specialist'])('permits %s to reach controller and scoped business authority when explicitly allowed', async who => {
    const {req,allowed}=request(who,'POST','/api/purchase-inventory/records/recFake/approval',PurchaseInventoryController.prototype.approveRecord);
    expect(allowed).toBe(true);
    const session={permissionPrincipal:req.accessPrincipal,platformProof:{subjectAccountId:req.accessPrincipal.accountId}};
    jest.spyOn(controller as any,'getWorkflowSession').mockResolvedValue(session);
    const result=await controller.approveRecord(req,`rec_${who}`,{decision:'approved'} as never);
    expect(result.taskId).toBeTruthy();
    expect(runtime.accept).toHaveBeenCalledWith(`rec_${who}`,{decision:'approved'},session);
  });
  it('rejects no grant at guard and rejects cross-building at actual controller business boundary', async () => {
    expect(request('denied','POST','/api/purchase-inventory/records/recOther/approval',PurchaseInventoryController.prototype.approveRecord).allowed).toBe(false);
    const {req,allowed}=request('wrongScope','POST','/api/purchase-inventory/records/recOther/approval',PurchaseInventoryController.prototype.approveRecord);
    expect(allowed).toBe(true);
    jest.spyOn(controller as any,'getWorkflowSession').mockResolvedValue({permissionPrincipal:req.accessPrincipal,platformProof:{subjectAccountId:req.accessPrincipal.accountId}});
    await expect(controller.approveRecord(req,'recOther',{decision:'approved'} as never)).rejects.toThrow();
  });
  it('denies a different authorized account access to another user task', async () => {
    const named=request('named','POST','/api/purchase-inventory/records/recTask/approval',PurchaseInventoryController.prototype.approveRecord);
    jest.spyOn(controller as any,'getWorkflowSession').mockResolvedValue({permissionPrincipal:named.req.accessPrincipal,platformProof:{subjectAccountId:named.req.accessPrincipal.accountId}});
    const result=await controller.approveRecord(named.req,'recTask',{decision:'approved'} as never);
    const other=request('supervisor','GET',`/api/purchase-inventory/approval/tasks/${result.taskId}`,PurchaseInventoryController.prototype.getApprovalTask);
    expect(other.allowed).toBe(true);
    await expect(approval.getAuthorizedDecisionTaskStatus(result.taskId,other.req.accessPrincipal,{permissionPrincipal:other.req.accessPrincipal,platformProof:{subjectAccountId:other.req.accessPrincipal.accountId}} as never)).rejects.toThrow('task owner');
  });
  it('keeps the two-argument legacy status path when no platform binding is registered', async () => {
    const spy=jest.spyOn(approval,'getAuthorizedDecisionTaskStatus').mockReturnValue({success:false,message:'synthetic'} as never);
    const {req}=request('supervisor','GET','/api/purchase-inventory/approval/tasks/synthetic',PurchaseInventoryController.prototype.getApprovalTask);
    await controller.getApprovalTask(req,'synthetic');
    expect(spy).toHaveBeenCalledWith('synthetic',req.accessPrincipal);
  });
});
