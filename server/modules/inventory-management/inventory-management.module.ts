import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { PurchaseInventoryModule } from '../purchase-inventory/purchase-inventory.module';
import { InventoryManagementController } from './inventory-management.controller';
import { InventoryStocktakeController } from './inventory-stocktake.controller';
import { InventoryStocktakeService } from './inventory-stocktake.service';
import { InventoryStocktakeSource } from './inventory-stocktake.source';
import { InventoryStocktakeStore } from './inventory-stocktake.store';
import { InventoryStocktakeGenerationService } from './inventory-stocktake-generation.service';
import { InventoryStocktakeResultsGateway } from './inventory-stocktake-results.gateway';
import { InventoryStocktakeResultsSync } from './inventory-stocktake-results.sync';
import { InventoryStocktakeBulkService } from './inventory-stocktake-bulk.service';
import { InventoryManagementService } from './inventory-management.service';
import { InventoryInboundTaskLedgerStore } from './inventory-inbound-task-ledger.store';
import { InventoryInboundTaskService } from './inventory-inbound-task.service';
import { InventoryMovementCommandService } from './inventory-movement-command.service';
import { InventoryMovementDeletionService } from './inventory-movement-deletion.service';
import { InventoryMovementDeletionTaskLedgerStore } from './inventory-movement-deletion-task-ledger.store';
import { InventoryMovementOperationCoordinator } from './inventory-movement-operation-coordinator';
import { InventoryOutboundWorkflowService } from './inventory-outbound-workflow.service';
import { InventoryOutboundTaskLedgerStore } from './inventory-outbound-task-ledger.store';
import { InventoryWorkflowGateway } from './inventory-workflow.gateway';
import { InventoryWorkflowScheduler } from './inventory-workflow.scheduler';
import { InventoryWorkflowService } from './inventory-workflow.service';
import { InventoryWorkflowStore } from './inventory-workflow.store';
import { PurchaseInboundConfirmationService } from './purchase-inbound-confirmation.service';
import { PurchaseInboundCategoryTaskLedgerStore } from './purchase-inbound-category-task-ledger.store';
import { PurchaseInboundCategoryTaskService } from './purchase-inbound-category-task.service';
import { InventoryStorageLocationService } from './inventory-storage-location.service';
import { InventoryOutboundApprovalModule } from '../inventory-outbound-approval/inventory-outbound-approval.module';
import { InventoryInboundHandoverAdapter } from './inventory-inbound-handover.adapter';
import { InventoryFullPersonnelHandoverAdapter } from './inventory-full-personnel-handover.adapter';
import { PERSONNEL_PREVIEW_READERS } from '../../common/access/personnel-preview.ports';

@Module({
  imports: [
    HttpModule.register({ timeout: 60_000, maxRedirects: 5 }),
    PurchaseInventoryModule,
    InventoryOutboundApprovalModule,
  ],
  controllers: [InventoryManagementController, InventoryStocktakeController],
  providers: [
    InventoryStocktakeService,
    InventoryStocktakeSource,
    InventoryStocktakeStore,
    InventoryStocktakeGenerationService,
    InventoryStocktakeResultsGateway,
    InventoryStocktakeResultsSync,
    InventoryStocktakeBulkService,
    InventoryManagementService,
    InventoryInboundTaskLedgerStore,
    InventoryInboundHandoverAdapter,
    InventoryFullPersonnelHandoverAdapter,
    { provide: PERSONNEL_PREVIEW_READERS.inventory, useExisting: InventoryFullPersonnelHandoverAdapter },
    InventoryInboundTaskService,
    InventoryMovementCommandService,
    InventoryMovementDeletionTaskLedgerStore,
    InventoryMovementOperationCoordinator,
    InventoryMovementDeletionService,
    InventoryOutboundTaskLedgerStore,
    InventoryOutboundWorkflowService,
    InventoryStorageLocationService,
    PurchaseInboundConfirmationService,
    PurchaseInboundCategoryTaskLedgerStore,
    PurchaseInboundCategoryTaskService,
    InventoryWorkflowGateway,
    InventoryWorkflowStore,
    InventoryWorkflowService,
    InventoryWorkflowScheduler,
  ],
})
export class InventoryManagementModule {}
