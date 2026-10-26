jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const decorator = () => () => undefined;
  return {
    ...actual,
    Body: decorator,
    Controller: decorator,
    Get: decorator,
    HttpCode: decorator,
    Injectable: decorator,
    Optional: decorator,
    Param: decorator,
    Post: decorator,
    Query: decorator,
    Req: decorator,
    SetMetadata: decorator,
  };
});

import { BadRequestException } from '@nestjs/common';
import { InventoryManagementController } from '../../server/modules/inventory-management/inventory-management.controller';
import type {
  InventoryOutboundMovementCreateRequest,
  PurchaseExistingInboundConfirmRequest,
} from '../../shared/inventory-management.interface';

const accessRequest = {
  accessPrincipal: { role: 'inventory_admin', purchaseBuilding: 'A楼' },
  accessPrincipalFingerprint: 'A'.repeat(43),
};

function controller(
  outbound: jest.Mock,
  inbound: jest.Mock,
): InventoryManagementController {
  return new (InventoryManagementController as unknown as new (
    ...dependencies: unknown[]
  ) => InventoryManagementController)(
    {},
    {},
    {},
    {},
    {},
    {},
    { acceptPending: outbound },
    undefined,
    undefined,
    { acceptPurchase: inbound },
  );
}

function outbound(id: string): InventoryOutboundMovementCreateRequest {
  return {
    type: 'outbound',
    clientMutationId: id,
    catalogRecordId: `catalog-${id}`,
    sku: `SKU-${id}`,
    building: 'A楼',
    quantity: 1,
    occurredAt: '2026-09-29T00:00:00.000Z',
    applicantOpenId: 'ou_applicant',
    reason: '批量领用',
  };
}

function purchase(id: string): PurchaseExistingInboundConfirmRequest {
  return {
    mode: 'existing',
    clientMutationId: id,
    executionRecordId: `execution-${id}`,
    catalogRecordId: `catalog-${id}`,
    sku: `SKU-${id}`,
    building: 'A楼',
    quantity: 1,
    occurredAt: '2026-09-29T00:00:00.000Z',
  };
}

describe('inventory batch acceptance controller', () => {
  it('accepts outbound requests with the same stable per-item ids', async () => {
    const acceptPending = jest
      .fn()
      .mockResolvedValueOnce({ taskId: 'task-first', message: '已受理' })
      .mockRejectedValueOnce(new BadRequestException('库存不足'));
    const api = controller(acceptPending, jest.fn());
    const result = await api.createInventoryOutboundsBatch(
      accessRequest as never,
      [outbound('first'), outbound('second')],
    );
    expect(
      result.items.map((item) => [
        item.clientMutationId,
        item.accepted,
        item.taskId,
      ]),
    ).toEqual([
      ['first', true, 'task-first'],
      ['second', false, undefined],
    ]);
    expect(acceptPending).toHaveBeenCalledTimes(2);
    expect(acceptPending.mock.calls[0][0].clientMutationId).toBe('first');
  });

  it('rejects duplicate ids before any outbound task is accepted', async () => {
    const acceptPending = jest.fn();
    const api = controller(acceptPending, jest.fn());
    await expect(
      api.createInventoryOutboundsBatch(accessRequest as never, [
        outbound('same'),
        outbound('same'),
      ]),
    ).rejects.toThrow('不同的客户端编号');
    expect(acceptPending).not.toHaveBeenCalled();
  });

  it('rejects the same stock item twice before scheduling deductions', async () => {
    const acceptPending = jest.fn();
    const api = controller(acceptPending, jest.fn());
    const second = outbound('second');
    second.catalogRecordId = 'catalog-first';
    await expect(
      api.createInventoryOutboundsBatch(accessRequest as never, [
        outbound('first'),
        second,
      ]),
    ).rejects.toThrow('同一物品');
    expect(acceptPending).not.toHaveBeenCalled();
  });

  it('accepts purchase items separately and retains a definite item rejection', async () => {
    const acceptPurchase = jest
      .fn()
      .mockResolvedValueOnce({ taskId: 'task-first', message: '已受理' })
      .mockRejectedValueOnce(new BadRequestException('采购记录已入库'));
    const api = controller(jest.fn(), acceptPurchase);
    const result = await api.confirmPurchaseInboundsBatch(
      accessRequest as never,
      [purchase('first'), purchase('second')],
    );
    expect(result.items.map((item) => item.accepted)).toEqual([true, false]);
    expect(acceptPurchase).toHaveBeenCalledTimes(2);
  });

  it('propagates ambiguous errors so the client retries the complete original batch', async () => {
    const api = controller(
      jest
        .fn()
        .mockResolvedValueOnce({ taskId: 'task-first', message: '已受理' })
        .mockRejectedValueOnce(new Error('connection reset')),
      jest.fn(),
    );
    await expect(
      api.createInventoryOutboundsBatch(accessRequest as never, [
        outbound('first'),
        outbound('second'),
      ]),
    ).rejects.toThrow('connection reset');
  });
});
