import { buildPurchasePlatformResolvedFields as build, PURCHASE_MANAGER_APPROVAL_FIELDS as field } from '../../server/modules/purchase-inventory/purchase-manager-approval.fields';
describe('platform approval resolved fields',()=>{
 const base={choice:'comprehensive' as const,eventId:'platform_event_1',approvalTime:new Date('2026-11-04T10:00:00Z')};
 it('does not forge or clear an actual Feishu approver for a local account',()=>{const patch=build(base);expect(patch).not.toHaveProperty(field.actualApprover);expect(patch).not.toHaveProperty(field.source);expect(patch[field.state]).toBe('已通过');expect(patch[field.actionId]).toBe('platform_event_1');});
 it('uses only a validated actual actor when a real Feishu identity is available',()=>{expect(build({...base,actorFeishuOpenId:'ou_admin'})[field.actualApprover]).toEqual([{id:'ou_admin'}]);expect(()=>build({...base,actorFeishuOpenId:'person-local'})).toThrow();});
 it('records rejected outcome and rejects invalid timestamps',()=>{expect(build({...base,choice:'reject'})[field.state]).toBe('已驳回');expect(()=>build({...base,approvalTime:new Date('bad')})).toThrow();});
});
