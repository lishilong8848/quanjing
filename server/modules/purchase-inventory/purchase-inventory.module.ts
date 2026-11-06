import { HttpModule, HttpService } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { readEnv } from '../../common/config/external-services.config';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { UnifiedAccessService } from '../../common/access/unified-access.service';
import { PurchaseAccessPolicyService } from './purchase-access-policy.service';
import { PurchaseApplicationTaskLedgerStore, PURCHASE_APPLICATION_TASK_LEDGER_OPTIONS } from './purchase-application-task-ledger.store';
import { PurchaseApplicationService, PURCHASE_LIFECYCLE_NEW_APPLICATIONS, PURCHASE_LIFECYCLE_READINESS } from './purchase-application.service';
import { PurchaseCodeService } from './purchase-code.service';
import { PurchaseInventoryController } from './purchase-inventory.controller';
import { PurchaseInventoryService } from './purchase-inventory.service';
import { PurchaseManagerApprovalScheduler } from './purchase-manager-approval.scheduler';
import { PurchaseManagerApprovalService } from './purchase-manager-approval.service';
import { PurchasePersonnelHandoverAdapter } from './purchase-personnel-handover.adapter';
import { PERSONNEL_PREVIEW_READERS } from '../../common/access/personnel-preview.ports';
import { PurchaseBatchAttachmentController } from './purchase-batch-attachment.controller';
import { PurchaseLifecycleAttachmentAccessController } from './purchase-lifecycle-attachment-access.controller';
import { PurchaseLifecycleAttachmentAccessRuntime } from './purchase-lifecycle-attachment-access.runtime';
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
} from '../overtime-workflow/overtime-workflow.card-action.consumer';
import {
  FeishuCardActionConsumer,
  FeishuCardActionHealthController,
} from './feishu-card-action.consumer';
import { FeishuCardActionRouter } from './feishu-card-action.router';
import { FeishuCardCallbackFeedbackService } from '../../common/feishu-card-callback-feedback.service';
import { BitableSyncModule } from '../bitable-sync/bitable-sync.module';
import { InventoryOutboundApprovalModule } from '../inventory-outbound-approval/inventory-outbound-approval.module';
import { ThresholdModule } from '../threshold-management/threshold.module';
import { PurchasePlatformSessionBinding, PURCHASE_PLATFORM_SESSION_BINDING } from './purchase-platform-session-binding';
import {
  PURCHASE_PLATFORM_APPROVAL_RUNTIME,
  PURCHASE_PLATFORM_APPROVAL_SOURCE,
  PURCHASE_PLATFORM_RECOVERY_OPTIONS,
  PURCHASE_PLATFORM_LIFECYCLE_APPROVAL_OPTIONS,
  createPurchasePlatformApprovalRuntime,
} from './purchase-platform-approval-runtime';
import { createPlatformLegacyApprovalGateway } from './purchase-platform-legacy-approval-gateway';
import { PURCHASE_LIFECYCLE_PAYMENT_PROVIDERS, PURCHASE_LIFECYCLE_PAYMENT_CONTROLLERS, PURCHASE_LIFECYCLE_PROCESSING_PORT } from './purchase-lifecycle-payment.providers';
import { PURCHASE_LIFECYCLE_RECEIPT_PROVIDERS } from './purchase-lifecycle-receipt.providers';
import { PurchaseLifecycleCardTransport } from './purchase-lifecycle-card-transport';
import { PurchaseLifecycleComposition, purchaseLifecycleNewApplicationsEnabled } from './purchase-lifecycle-composition';
import { lifecyclePaymentUploadSourceFingerprint } from './purchase-lifecycle-payment-upload-gateway';

/** Background recovery is opt-in only: `/^(1|true|yes|on)$/i` in
 * PURCHASE_PLATFORM_APPROVAL_RECOVERY_ENABLED. Anything else keeps the durable
 * ledger read-only from the website path and never scans/writes in background. */
function purchasePlatformRecoveryOptions(): { enabled: boolean } {
  return { enabled: /^(1|true|yes|on)$/i.test(readEnv('PURCHASE_PLATFORM_APPROVAL_RECOVERY_ENABLED')) };
}

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
    ...PURCHASE_LIFECYCLE_PAYMENT_CONTROLLERS,
    PurchaseInventoryController,
    PurchaseBatchAttachmentController,
    PurchaseLifecycleAttachmentAccessController,
    PurchaseWorkflowCallbackController,
    FeishuCardActionHealthController,
  ],
  providers: [
    ...PURCHASE_LIFECYCLE_PAYMENT_PROVIDERS,
    ...PURCHASE_LIFECYCLE_RECEIPT_PROVIDERS,
    PurchaseLifecycleComposition,
    { provide: PURCHASE_LIFECYCLE_NEW_APPLICATIONS, useFactory: purchaseLifecycleNewApplicationsEnabled },
    {
      provide: PURCHASE_APPLICATION_TASK_LEDGER_OPTIONS,
      inject: [PURCHASE_LIFECYCLE_NEW_APPLICATIONS],
      useFactory: (enabled: boolean) => ({ allowLifecycleReservations: enabled === true }),
    },
    { provide: PURCHASE_LIFECYCLE_READINESS, useExisting: PurchaseLifecycleComposition },
    { provide: PURCHASE_LIFECYCLE_PROCESSING_PORT, useExisting: PurchaseLifecycleComposition },
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
    PurchaseLifecycleAttachmentAccessRuntime,
    PurchaseManagerApprovalScheduler,
    FeishuCardActionRouter,
    FeishuCardCallbackFeedbackService,
    {
      provide: FEISHU_CARD_ACTION_TRANSPORT,
      useExisting: PurchaseLifecycleCardTransport,
    },
    FeishuCardActionConsumer,
    // Personal purchase approvals: one signed-session proof binding plus the
    // durable platform ledger runtime. Both are module-scoped singletons so the
    // controller, the runtime and the recovery worker share one verification state.
    PurchasePlatformSessionBinding,
    {
      provide: PURCHASE_PLATFORM_SESSION_BINDING,
      useExisting: PurchasePlatformSessionBinding,
    },
    {
      provide: PURCHASE_PLATFORM_RECOVERY_OPTIONS,
      useFactory: purchasePlatformRecoveryOptions,
    },
    {
      // Real app-token source gateway (metadata check, snapshot read, fenced write).
      provide: PURCHASE_PLATFORM_APPROVAL_SOURCE,
      inject: [PurchaseWorkflowGateway, HttpService],
      useFactory: createPlatformLegacyApprovalGateway,
    },
    {
      provide: PURCHASE_PLATFORM_LIFECYCLE_APPROVAL_OPTIONS,
      inject: [PurchaseWorkflowGateway],
      useFactory: (gateway: PurchaseWorkflowGateway) => ({ gateway, sourceIdentity: () => ({appId:readEnv('FEISHU_APP_ID'),sourceFingerprint:lifecyclePaymentUploadSourceFingerprint()}) }),
    },
    {
      provide: PURCHASE_PLATFORM_APPROVAL_RUNTIME,
      inject: [PurchaseWorkflowStore, PURCHASE_PLATFORM_APPROVAL_SOURCE, PURCHASE_PLATFORM_RECOVERY_OPTIONS, PURCHASE_PLATFORM_LIFECYCLE_APPROVAL_OPTIONS],
      useFactory: createPurchasePlatformApprovalRuntime,
    },
  ],
  exports: [
    PurchaseInventoryService,
    PurchaseWorkflowService,
    PurchaseApplicationService,
    PurchasePersonnelHandoverAdapter,
    PurchaseWorkflowStore,
    PurchasePlatformSessionBinding,
    { provide: PURCHASE_PLATFORM_SESSION_BINDING, useExisting: PurchasePlatformSessionBinding },
  ],
})
export class PurchaseInventoryModule {}
