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
    Param: decorator,
    Post: decorator,
    Query: decorator,
    Req: decorator,
    SetMetadata: decorator,
  };
});

jest.mock(
  '../../server/modules/purchase-inventory/purchase-inventory.module',
  () => ({ PurchaseInventoryModule: class PurchaseInventoryModule {} }),
);

import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { CreateInventoryMovementDeletionRequest } from '../../shared/inventory-management.interface';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InventoryManagementController } from '../../server/modules/inventory-management/inventory-management.controller';
import { InventoryManagementModule } from '../../server/modules/inventory-management/inventory-management.module';
import { InventoryMovementDeletionService } from '../../server/modules/inventory-management/inventory-movement-deletion.service';
import { InventoryMovementDeletionTaskLedgerStore } from '../../server/modules/inventory-management/inventory-movement-deletion-task-ledger.store';
import { InventoryMovementOperationCoordinator } from '../../server/modules/inventory-management/inventory-movement-operation-coordinator';

describe('inventory movement deletion controller', () => {
  const deletionService = {
    accept: jest.fn().mockResolvedValue({
      accepted: true,
      taskId: 'inventory-movement-deletion-task-1',
      status: 'pending',
      message: '已受理',
    }),
    getTaskStatus: jest.fn().mockResolvedValue({
      success: true,
      task: {
        id: 'inventory-movement-deletion-task-1',
        status: 'pending',
      },
    }),
  };
  const controller = new (InventoryManagementController as unknown as new (
    ...dependencies: unknown[]
  ) => InventoryManagementController)(
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    deletionService,
  );
  const principal: AccessPrincipal = {
    role: 'inventory_admin',
    purchaseBuilding: 'A楼',
  };
  const request: CreateInventoryMovementDeletionRequest = {
    clientMutationId: 'movement-delete-controller-1',
    movementType: 'inbound',
    recordId: 'rec-inbound-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts deletion with the authenticated principal fingerprint', async () => {
    await controller.createInventoryMovementDeletion(
      {
        accessPrincipal: principal,
        accessPrincipalFingerprint: 'principal-fingerprint-controller-a',
      } as never,
      request,
    );

    expect(deletionService.accept).toHaveBeenCalledWith(
      request,
      principal,
      'principal-fingerprint-controller-a',
    );
  });

  it('queries deletion status with the authenticated task owner', async () => {
    await controller.getInventoryMovementDeletionTask(
      {
        accessPrincipal: principal,
        accessPrincipalFingerprint: 'principal-fingerprint-controller-a',
      } as never,
      'inventory-movement-deletion-task-1',
    );

    expect(deletionService.getTaskStatus).toHaveBeenCalledWith(
      'inventory-movement-deletion-task-1',
      principal,
      'principal-fingerprint-controller-a',
    );
  });

  it.each([
    ['HTTP 400', new BadRequestException('删除请求格式无效')],
    ['HTTP 403', new ForbiddenException('无权删除该楼栋记录')],
    ['HTTP 409', new ConflictException('该记录已有删除任务')],
  ])(
    'marks a movement deletion rejected before acceptance as definitely not written: %s',
    async (_label, failure) => {
      deletionService.accept.mockRejectedValueOnce(failure);

      let caught: unknown;
      try {
        await controller.createInventoryMovementDeletion(
          {
            accessPrincipal: principal,
            accessPrincipalFingerprint: 'principal-fingerprint-controller-a',
          } as never,
          request,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(failure.getStatus());
      expect((caught as HttpException).getResponse()).toMatchObject({
        message: failure.message,
        definitelyNotWritten: true,
        writeDisposition: 'definitely-not-written',
      });
    },
  );

  it('keeps an unclassified movement deletion acceptance failure outcome unknown', async () => {
    const failure = new ServiceUnavailableException('任务账本响应结果未知');
    deletionService.accept.mockRejectedValueOnce(failure);

    await expect(
      controller.createInventoryMovementDeletion(
        {
          accessPrincipal: principal,
          accessPrincipalFingerprint: 'principal-fingerprint-controller-a',
        } as never,
        request,
      ),
    ).rejects.toBe(failure);
    expect(failure.getResponse()).not.toMatchObject({
      definitelyNotWritten: true,
    });
  });

  it('registers the durable deletion worker dependencies', () => {
    const providers = Reflect.getMetadata(
      'providers',
      InventoryManagementModule,
    );

    expect(providers).toContain(InventoryMovementDeletionTaskLedgerStore);
    expect(providers).toContain(InventoryMovementOperationCoordinator);
    expect(providers).toContain(InventoryMovementDeletionService);
  });
});
