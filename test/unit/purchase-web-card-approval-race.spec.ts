import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';

// The original race reproduction used the now-retired HTTP fallback writer.
// The shared-runtime race (with a real ledger/card claim) lives in
// purchase-web-card-shared-runtime-race.spec.ts. This test proves omission of
// the runtime cannot accidentally re-enable that former fallback.
it('rejects an approval before reading or writing when the durable runtime is missing', async () => {
  const gateway={getExecutionRecordAsApp:jest.fn(),updateExecutionRecordAsApp:jest.fn()};
  const workflow={prepareWebApprovalAuthority:jest.fn()};
  const service=new PurchaseOnlineApprovalService(gateway as never,workflow as never);
  await expect(service.acceptAuthorizedDecision('recFake',{decision:'approved'},
    {openId:'ou_actor',permissionPrincipal:{accountId:'person',authorizationVersion:1}} as never)).rejects.toThrow();
  expect(workflow.prepareWebApprovalAuthority).not.toHaveBeenCalled();
  expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
  expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
});
