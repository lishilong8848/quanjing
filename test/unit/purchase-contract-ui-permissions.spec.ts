import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { BusinessAction, BusinessModule } from '../../shared/business-permissions';
import type { PurchaseInventoryRequestItem } from '../../shared/purchase-inventory.interface';
import { purchaseUiPrincipal, purchaseUiPrincipalKey } from '../../client/src/pages/PurchaseInventoryManagement/purchase-ui-principal';
import { canApprovePurchaseOnline } from '../../client/src/pages/PurchaseInventoryManagement/purchase-online-approval.logic';
import { permittedPurchaseWorkflowActions } from '../../client/src/pages/PurchaseInventoryManagement/purchase-workflow-action.logic';
import { createBlankDraft, getPurchaseApplicationDraftKey, getPurchaseApplicationSubmissionJournalKey, scopePurchaseApplicationDraft } from '../../client/src/pages/PurchaseInventoryManagement/purchase-application.logic';
import { canUseContractAction, contractPaymentPermissions, canOpenContractPayment } from '../../client/src/pages/ContractManagement/contract-permissions';
import { availablePaymentActions } from '../../client/src/pages/ContractManagement/contract-payment-follow-up.logic';

function principal(module:BusinessModule,actions:BusinessAction[],id='synthetic-person-a'):AccessPrincipal {
  return {role:'guest',purchaseBuilding:null,accountId:id,authorizationVersion:3,effectiveAuthorization:{mode:'independent',baseline:{nativeRole:null,pages:[],rules:[{id:'synthetic-scope',module,actions,effect:'allow',buildings:['A楼'],specialties:['电气']}]},overrides:{rules:[],allowPages:[],denyPages:[]}}};
}
const purchase=(changes:Partial<PurchaseInventoryRequestItem>={}):PurchaseInventoryRequestItem=>({recordId:'recSynthetic',executionRecordId:'recExecution',stage:'approval',purchaseCompleted:false,building:'A楼',specialty:'电气',...changes} as PurchaseInventoryRequestItem);
const scope={buildings:['A楼'],specialty:'电气'};

describe('purchase and contract action affordances use the full authorization snapshot',()=>{
  it('keeps profile layers and isolates equal-role accounts and changed authorization versions',()=>{
    const access={...principal('purchase',['approve']),principalFingerprint:'synthetic-session'};
    const copied=purchaseUiPrincipal(access);expect(copied.effectiveAuthorization).toEqual(access.effectiveAuthorization);
    expect(purchaseUiPrincipalKey(copied)).not.toBe(purchaseUiPrincipalKey({...access,accountId:'synthetic-person-b'}));
    expect(purchaseUiPrincipalKey(copied)).not.toBe(purchaseUiPrincipalKey({...access,authorizationVersion:4}));
    copied.effectiveAuthorization!.baseline.rules[0].actions.push('delete');expect(access.effectiveAuthorization!.baseline.rules[0].actions).toEqual(['approve']);
  });
  it('create-only never implies approval/order/receipt; approval still requires the valid stage and live record',()=>{
    expect(canApprovePurchaseOnline(principal('purchase',['create']),purchase())).toBe(false);
    const actor=principal('purchase',['approve']);expect(canApprovePurchaseOnline(actor,purchase())).toBe(true);
    for(const item of [purchase({stage:'executing'}),purchase({executionRecordId:null}),purchase({purchaseCompleted:true}),purchase({building:'B楼'})]) expect(canApprovePurchaseOnline(actor,item)).toBe(false);
  });
  it('a baseline purchase applicant is not silently promoted to approver by attaching a profile',()=>{
    const actor:AccessPrincipal={role:'purchase_applicant',purchaseBuilding:'A楼',effectiveAuthorization:{mode:'independent',baseline:{nativeRole:'purchase_applicant',pages:[],rules:[]},overrides:{rules:[],allowPages:[],denyPages:[]}}};
    expect(canApprovePurchaseOnline(actor,purchase())).toBe(false);
    actor.effectiveAuthorization!.overrides.rules=principal('purchase',['approve']).effectiveAuthorization!.baseline.rules;
    expect(canApprovePurchaseOnline(actor,purchase())).toBe(true);
    actor.effectiveAuthorization!.overrides.rules=[];
    actor.effectiveAuthorization!.baseline.rules=principal('purchase',['approve']).effectiveAuthorization!.baseline.rules;
    expect(canApprovePurchaseOnline(actor,purchase())).toBe(true);
    actor.effectiveAuthorization!.overrides.rules=[{...actor.effectiveAuthorization!.baseline.rules[0],id:'deny-explicit-approval',effect:'deny'}];
    expect(canApprovePurchaseOnline(actor,purchase())).toBe(false);
  });
  it('filters server-offered workflow actions individually and never invents a missing stage/duty action',()=>{
    const actor=principal('purchase',['order']);
    expect(permittedPurchaseWorkflowActions(actor,['approve','start','order','receive'],{building:'A楼',specialty:'电气'},true)).toEqual(['order']);
    expect(permittedPurchaseWorkflowActions(principal('purchase',['create']),['start','order'],{building:'A楼',specialty:'电气'},true)).toEqual(['start']);
    expect(permittedPurchaseWorkflowActions(actor,[],{building:'A楼',specialty:'电气'},true)).toEqual([]);
    expect(permittedPurchaseWorkflowActions(actor,['order'],{building:'B楼',specialty:'电气'},true)).toEqual([]);
    expect(permittedPurchaseWorkflowActions(actor,['order'],{building:'A楼',specialty:'电气'},false)).toEqual([]);
  });
  it('personal denial overrides the matching record action',()=>{
    const actor=principal('purchase',['approve']);actor.effectiveAuthorization!.overrides.rules=[{...actor.effectiveAuthorization!.baseline.rules[0],id:'deny-approval',effect:'deny'}];
    expect(canApprovePurchaseOnline(actor,purchase())).toBe(false);
  });
  it('contract list reading does not enable create/edit/confirmation/export buttons',()=>{
    const actor=principal('contracts',['read']);expect(canUseContractAction(actor,'read',scope)).toBe(true);
    for(const action of ['create','update','confirm','export'] as const)expect(canUseContractAction(actor,action,scope)).toBe(false);
    expect(contractPaymentPermissions(actor,{create:true,adjust:true,confirm:true,noPaymentRequired:true},scope)).toEqual({create:false,adjust:false,confirm:false,noPaymentRequired:false});
  });
  it('confirm-only payment permission retains the existing paid-plan and record-scope constraints',()=>{
    const actor=principal('contracts',['confirm']);
    expect(contractPaymentPermissions(actor,{create:true,adjust:true,confirm:true,noPaymentRequired:false},scope)).toEqual({create:false,adjust:false,confirm:true,noPaymentRequired:false});
    const paid=availablePaymentActions([{recordId:'recPayment',status:'已付款'}] as never);
    expect(contractPaymentPermissions(actor,paid,scope).confirm).toBe(false);
    expect(canUseContractAction(actor,'confirm',{...scope,buildings:['B楼']})).toBe(false);expect(canUseContractAction(actor,'confirm',null)).toBe(false);
    expect(canOpenContractPayment(actor,{unpaidPlanCount:0} as never,scope)).toBe(false);
  });
  it('create affordances require some permitted scope while submission checks its exact scope',()=>{
    const actor=principal('contracts',['create']);expect(canUseContractAction(actor,'create')).toBe(true);
    expect(canUseContractAction(actor,'create',scope)).toBe(true);expect(canUseContractAction(actor,'create',{buildings:['B楼'],specialty:'电气'})).toBe(false);
  });
  it('purchase drafts no longer collide for different custom guest-base accounts',()=>{
    const a=principal('purchase',['create']),b=principal('purchase',['create'],'synthetic-person-b');
    expect(getPurchaseApplicationDraftKey(a)).not.toBe(getPurchaseApplicationDraftKey(b));
    expect(getPurchaseApplicationSubmissionJournalKey(a)).not.toBe(getPurchaseApplicationSubmissionJournalKey(b));
    expect(getPurchaseApplicationDraftKey(a)).toBe(getPurchaseApplicationDraftKey({...a,authorizationVersion:4}));
  });
  it('explicit cross-building application scope is not silently replaced by the legacy building',()=>{
    const actor:AccessPrincipal={...principal('purchase',['create']),role:'building_admin',purchaseBuilding:'A楼'};
    actor.effectiveAuthorization!.baseline.nativeRole='building_admin';actor.effectiveAuthorization!.overrides.rules=[{id:'allow-b',module:'purchase',actions:['create'],effect:'allow',buildings:['B楼'],specialties:['电气']}];
    const draft=createBlankDraft('B楼');draft.shared.specialty='电气';
    expect(scopePurchaseApplicationDraft(actor,draft)).toBe(draft);expect(draft.shared.building).toBe('B楼');
    expect(scopePurchaseApplicationDraft({role:'building_admin',purchaseBuilding:'A楼'},draft).shared.building).toBe('A楼');
  });
});
