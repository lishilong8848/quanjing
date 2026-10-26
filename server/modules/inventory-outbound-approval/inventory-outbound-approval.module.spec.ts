import { HttpModule } from '@nestjs/axios';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { InventoryOutboundApprovalGateway } from './inventory-outbound-approval.gateway';
import { InventoryOutboundApprovalFinalizerRegistry } from './inventory-outbound-approval.finalizer';
import { InventoryOutboundApprovalModule } from './inventory-outbound-approval.module';
import { InventoryOutboundApprovalScheduler } from './inventory-outbound-approval.scheduler';
import { InventoryOutboundApprovalService } from './inventory-outbound-approval.service';
import {
  INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH,
  InventoryOutboundApprovalStore,
} from './inventory-outbound-approval.store';
import { InventoryWarehouseRoleDirectory } from './inventory-warehouse-role-directory';

describe('InventoryOutboundApprovalModule', () => {
  it('owns the complete outbound approval runtime without importing business modules', () => {
    expect(
      Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        InventoryOutboundApprovalModule,
      ),
    ).toEqual([HttpModule]);
    expect(
      Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        InventoryOutboundApprovalModule,
      ),
    ).toEqual([
      {
        provide: INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH,
        useFactory: expect.any(Function),
      },
      InventoryOutboundApprovalStore,
      InventoryOutboundApprovalGateway,
      InventoryOutboundApprovalFinalizerRegistry,
      InventoryWarehouseRoleDirectory,
      InventoryOutboundApprovalService,
      InventoryOutboundApprovalScheduler,
    ]);
    expect(
      Reflect.getMetadata(
        MODULE_METADATA.EXPORTS,
        InventoryOutboundApprovalModule,
      ),
    ).toEqual([
      InventoryOutboundApprovalService,
      InventoryOutboundApprovalStore,
      InventoryWarehouseRoleDirectory,
      InventoryOutboundApprovalGateway,
      InventoryOutboundApprovalFinalizerRegistry,
    ]);
  });
});
