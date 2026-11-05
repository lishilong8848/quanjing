import { PurchaseOnlineApprovalService } from '../../server/modules/purchase-inventory/purchase-online-approval.service';

describe('online approval uncertain writes', () => {
  it('does not retry an uncertain write or submit it again in the same process', async () => {
    const gateway = {
      getExecutionRecordAsApp: jest.fn().mockResolvedValue({ building: 'C楼', status: '未开始（待审批）', approvalCompleted: false, purchaseMethod: '综合采购' }),
      updateExecutionRecordAsApp: jest.fn().mockRejectedValue(new Error('response lost')),
    };
    const service = new PurchaseOnlineApprovalService(gateway as never);
    const first = service.acceptDecision('rec_test', { decision: 'approved' });
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(service.getDecisionTaskStatus(first.taskId).task).toMatchObject({ status: 'failed', message: expect.stringContaining('待核对') });
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);
    expect(service.acceptDecision('rec_test', { decision: 'approved' }).taskId).toBe(first.taskId);
    expect(() => service.acceptDecision('rec_test', { decision: 'rejected' })).toThrow();
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);
  });
});
