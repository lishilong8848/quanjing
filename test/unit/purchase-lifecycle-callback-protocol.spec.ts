import { parsePurchaseLongConnectionCardAction } from '../../server/modules/purchase-inventory/purchase-workflow-callback';
const config = { verificationToken: 'long_connection', encryptKey: '', legacyApproverOpenIds: [], managerApproverOpenId: 'ou_manager', authorizeFromDeliverySnapshot: true };
const event = (value: Record<string,unknown>) => ({ schema:'2.0', event_type:'card.action.trigger', operator:{open_id:'ou_manager'}, context:{open_message_id:'om_message'}, action:{tag:'button', value} });
const manager = {version:3, action:'approve_pending_comprehensive',approvalBatchId:'purchase-application-123'};
const fulfillment = {version:4,workflowType:'purchase_batch_fulfillment',role:'purchaser',action:'open_order',approvalBatchId:'purchase-application-123',executionRecordId:'rec_item'};
describe('purchase lifecycle callback protocol', () => {
 it.each([manager,fulfillment])('preserves revision and makes replay id stable for same event', value => {
   const result = parsePurchaseLongConnectionCardAction(event({...value,flowVersion:'lifecycle_v1',cardRevision:12}), config);
   expect(result.lifecycle).toEqual({cardRevision:12});
   expect(parsePurchaseLongConnectionCardAction(event({...value,flowVersion:'lifecycle_v1',cardRevision:12}), config).eventId).toBe(result.eventId);
   expect(parsePurchaseLongConnectionCardAction(event({...value,flowVersion:'lifecycle_v1',cardRevision:13}), config).eventId).not.toBe(result.eventId);
 });
 it('preserves legacy shape and rejects forged or incomplete metadata', () => {
   expect(parsePurchaseLongConnectionCardAction(event(manager), config)).not.toHaveProperty('lifecycle');
   for(const value of [{...manager,flowVersion:'lifecycle_v1'}, {...manager,cardRevision:1}, {...manager,flowVersion:'legacy',cardRevision:1}, {...manager,flowVersion:'lifecycle_v1',cardRevision:0}, {...manager,flowVersion:'lifecycle_v1',cardRevision:1,unknown:true}]) {
     expect(() => parsePurchaseLongConnectionCardAction(event(value),config)).toThrow();
   }
 });
 it.each(['approve_item_comprehensive', 'approve_item_building_self'] as const)('accepts lifecycle-only per-item decision %s with exact record binding', action => {
   const value = { version: 3, action, approvalBatchId: 'purchase-application-123', executionRecordId: 'rec_item' };
   const parsed = parsePurchaseLongConnectionCardAction(event({...value, flowVersion:'lifecycle_v1', cardRevision:1}), config);
   expect(parsed).toMatchObject({ kind:'manager_batch_action', action, executionRecordId:'rec_item', lifecycle:{cardRevision:1} });
   expect(() => parsePurchaseLongConnectionCardAction(event(value), config)).toThrow();
 });
 it('parses only a bounded lifecycle page action and separates event keys by page', () => {
   const value = { version:5, workflowType:'purchase_lifecycle_page', action:'page', approvalBatchId:'purchase-application-123', flowVersion:'lifecycle_v1', cardRevision:3, page:2 };
   const result = parsePurchaseLongConnectionCardAction(event(value), config);
   expect(result).toMatchObject({ kind:'lifecycle_page_action', approvalBatchId:value.approvalBatchId, page:2, lifecycle:{cardRevision:3} });
   expect(parsePurchaseLongConnectionCardAction(event({...value,page:3}),config).eventId).not.toBe(result.eventId);
   for (const invalid of [{...value,page:0}, {...value,page:201}, {...value,cardRevision:0}, {...value,extra:true}, {...value,flowVersion:'legacy'}]) expect(() => parsePurchaseLongConnectionCardAction(event(invalid),config)).toThrow();
 });
});
