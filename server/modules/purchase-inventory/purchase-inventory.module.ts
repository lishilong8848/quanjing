import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { PurchaseAccessPolicyService } from './purchase-access-policy.service';
import { PurchaseApplicationTaskLedgerStore } from './purchase-application-task-ledger.store';
import { PurchaseApplicationService } from './purchase-application.service';
import { PurchaseCodeService } from './purchase-code.service';
import { PurchaseInventoryController } from './purchase-inventory.controller';
import { PurchaseInventoryService } from './purchase-inventory.service';
import { PurchaseManagerApprovalScheduler } from './purchase-manager-approval.scheduler';
import { PurchaseManagerApprovalService } from './purchase-manager-approval.service';
import { PurchasePersonnelHandoverAdapter } from './purchase-personnel-handover.adapter';
import { PERSONNEL_PREVIEW_READERS } from '../../common/access/personnel-preview.ports';
import { PurchaseBatchAttachmentController } from './purchase-batch-attachment.controller';
import { PurchaseBatchAttachmentTicketService } from './purchase-batch-attachment-ticket';
import { PurchaseOnlineApprovalService } from './purchase-online-approval.service';
import { PurchaseRecordDeletionService } from './purchase-record-deletion.service';
import { PurchaseRecordEditService } from './purchase-record-edit.service';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import { PurchaseWorkflowReceiptTaskService } from './purchase-workflow-receipt-task.service';
import { PurchaseWorkflowCallbackController } from './purchase-workflow-callback.controller';
import { PurchaseWorkflowScheduler } from './purchase-workflow.scheduler';
import { PurchaseWorkflowService } from './purchase-workflow.service';
import { PurchaseWorkflowStore } from './purchase-workflow.store';
import { WarehouseInboundHandoverService } from './warehouse-inbound-handover.service';
import { OvertimeWorkflowModule } from '../overtime-workflow/overtime-workflow.module';
import { LeaveWorkflowModule } from '../leave-workflow/leave-workflow.module';
import {
  FEISHU_CARD_ACTION_TRANSPORT,
  FeishuCardActionLongConnectionTransport,
} from '../overtime-workflow/overtime-workflow.card-action.consumer';
import {
  FeishuCardActionConsumer,
  FeishuCardActionHealthController,
} from './feishu-card-action.consumer';
import { FeishuCardActionRouter } from './feishu-card-action.router';
import { BitableSyncModule } from '../bitable-sync/bitable-sync.module';
import { InventoryOutboundApprovalModule } from '../inventory-outbound-approval/inventory-outbound-approval.module';
import { ThresholdModule } from '../threshold-management/threshold.module';

@Module({
  imports: [
    HttpModule.register({ timeout: 60_000, maxRedirects: 5 }),
    OvertimeWorkflowModule,
    LeaveWorkflowModule,
    BitableSyncModule,
    InventoryOutboundApprovalModule,
    ThresholdModule,
  ],
  controllers: [
    PurchaseInventoryController,
    PurchaseBatchAttachmentController,
    PurchaseWorkflowCallbackController,
    FeishuCardActionHealthController,
  ],
  providers: [
    PurchaseInventoryService,
    PurchaseAccessPolicyService,
    PurchaseRecordDeletionService,
    PurchaseRecordEditService,
    PurchaseOnlineApprovalService,
    PurchaseCodeService,
    PurchaseApplicationTaskLedgerStore,
    PurchaseApplicationService,
    PurchaseWorkflowGateway,
    PurchaseWorkflowStore,
    PurchaseWorkflowService,
    WarehouseInboundHandoverService,
    PurchaseWorkflowReceiptTaskService,
    PurchaseWorkflowScheduler,
    PurchaseManagerApprovalService,
    PurchasePersonnelHandoverAdapter,
    { provide: PERSONNEL_PREVIEW_READERS.purchase, useExisting: PurchasePersonnelHandoverAdapter },
    PurchaseBatchAttachmentTicketService,
    PurchaseManagerApprovalScheduler,
    FeishuCardActionRouter,
    FeishuCardActionLongConnectionTransport,
    {
      provide: FEISHU_CARD_ACTION_TRANSPORT,
      useExisting: FeishuCardActionLongConnectionTransport,
    },
    FeishuCardActionConsumer,
  ],
  exports: [PurchaseInventoryService, PurchaseWorkflowService, PurchaseApplicationService, PurchasePersonnelHandoverAdapter, PurchaseWorkflowStore],
})
export class PurchaseInventoryModule {}
