import { ForbiddenException } from '@nestjs/common';

const mockSession = { accessToken: 'synthetic-token', openId: 'ou_synthetic', accessRole: 'admin', authenticationMode: 'delegated-app' };
jest.mock('../../server/modules/purchase-inventory/purchase-workflow-session', () => ({
  resolvePurchaseWorkflowSession: jest.fn(async () => mockSession),
  resolvePurchaseWorkflowReadSession: jest.fn(async () => mockSession),
}));
import { PurchaseInventoryController } from '../../server/modules/purchase-inventory/purchase-inventory.controller';

function fixture() {
  const sequence: string[] = [];
  const workflow = {
    assertCanUploadOrderAttachments: jest.fn(async () => { sequence.push('authorize'); }),
    order: jest.fn(async () => { sequence.push('order'); return { success: true }; }),
  };
  const gateway = { getTenantAccessTokenAsApp: jest.fn(async () => 'synthetic-token'), uploadAttachment: jest.fn(async () => { sequence.push('upload'); return 'file_synthetic'; }) };
  const controller = new PurchaseInventoryController({} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    workflow as never, {} as never, {} as never, gateway as never);
  const req = { accessPrincipal: { role: 'admin', purchaseBuilding: null, accountId: 'synthetic-admin', authorizationVersion: 1 } } as never;
  const file = { originalname: 'synthetic.png', mimetype: 'image/png', buffer: Buffer.from('synthetic-image') } as never;
  const call = (files = [file]) => controller.orderWorkflow(req, 'rec-synthetic', JSON.stringify({ actualQuantity: 1, actualAmount: 10, note: '' }), files);
  return { workflow, gateway, sequence, call };
}

describe('purchase order attachment upload preflight', () => {
  it('does not upload any attachment when the record or live permission check rejects the order', async () => {
    const f = fixture();
    f.workflow.assertCanUploadOrderAttachments.mockRejectedValueOnce(new ForbiddenException('当前权限或状态不可用'));
    await expect(f.call()).rejects.toThrow('当前权限或状态不可用');
    expect(f.gateway.uploadAttachment).not.toHaveBeenCalled();
    expect(f.workflow.order).not.toHaveBeenCalled();
  });
  it('checks the exact record and authenticated session before upload, and still performs the real order check afterward', async () => {
    const f = fixture();
    await f.call();
    expect(f.workflow.assertCanUploadOrderAttachments).toHaveBeenCalledWith('rec-synthetic', mockSession);
    expect(f.sequence).toEqual(['authorize', 'upload', 'order']);
    expect(f.workflow.order).toHaveBeenCalledWith('rec-synthetic', mockSession, expect.objectContaining({ paymentAttachmentTokens: ['file_synthetic'] }));
  });
  it('does not upload when a matching latest-state precheck rejects even if the later order would also reject', async () => {
    const f = fixture();
    f.workflow.assertCanUploadOrderAttachments.mockRejectedValueOnce(new ForbiddenException('单据阶段已变化'));
    f.workflow.order.mockRejectedValueOnce(new ForbiddenException('单据阶段已变化'));
    await expect(f.call()).rejects.toThrow('单据阶段已变化');
    expect(f.gateway.uploadAttachment).not.toHaveBeenCalled();
  });
  it('keeps the existing no-attachment order path without an unnecessary preflight', async () => {
    const f = fixture(); await f.call([]);
    expect(f.workflow.assertCanUploadOrderAttachments).not.toHaveBeenCalled();
    expect(f.gateway.uploadAttachment).not.toHaveBeenCalled();
    expect(f.workflow.order).toHaveBeenCalledWith('rec-synthetic', mockSession, expect.objectContaining({ paymentAttachmentTokens: [] }));
  });
});
