import {
  BadRequestException,
  Controller,
  Inject,
  Get,
  Headers,
  Logger,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { PublicAccess } from '../../common/access/unified-access.decorators';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { assertFeishuBusinessIdentity } from '../../common/access/feishu-business-identity';
import {
  processPurchaseBatchAttachmentUpload,
  renderPurchaseBatchAttachmentPage,
  type PurchaseBatchAttachmentUploadFiles,
} from './purchase-batch-attachment.logic';
import { PurchaseBatchAttachmentTicketService } from './purchase-batch-attachment-ticket';
import { PurchaseManagerApprovalService } from './purchase-manager-approval.service';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import { PurchaseWorkflowStore } from './purchase-workflow.store';

@Controller('purchase-card-attachments')
export class PurchaseBatchAttachmentController {
  private readonly logger = new Logger(PurchaseBatchAttachmentController.name);

  constructor(
    private readonly tickets: PurchaseBatchAttachmentTicketService,
    private readonly gateway: PurchaseWorkflowGateway,
    private readonly store: PurchaseWorkflowStore,
    private readonly managerApprovalService: PurchaseManagerApprovalService,
    @Inject(AccessConfigurationService)
    private readonly accessConfiguration?: AccessConfigurationService,
  ) {}

  @PublicAccess()
  @Get()
  async page(
    @Query('ticket') ticket: string,
    @Res({ passthrough: true }) response?: Response,
  ): Promise<string> {
    response?.setHeader('Cache-Control', 'no-store');
    response?.type('html');
    const payload = this.tickets.verify(ticket);
    assertFeishuBusinessIdentity(this.accessConfiguration, payload.actorOpenId);
    const batch = await this.store.findManagerApprovalBatch(
      payload.approvalBatchId,
    );
    const item = batch?.items.find(
      (candidate) =>
        candidate.executionRecordId === payload.executionRecordId &&
        candidate.status === 'approved',
    );
    if (!batch || !item) throw new BadRequestException('采购附件明细不存在');
    const hasReceiptPhoto = item.receiptPhotoTokens.length > 0;
    return renderPurchaseBatchAttachmentPage({
      ticket,
      purpose: payload.purpose,
      hasReceiptPhoto,
      hasInvoice: item.invoiceTokens.length > 0,
      purchaseMethod: item.choice === 'building_self' ? '需求自采' : '综合采购',
    });
  }

  @PublicAccess()
  @Post()
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'paymentAttachments', maxCount: 5 },
        { name: 'receiptPhotos', maxCount: 5 },
        { name: 'invoices', maxCount: 5 },
      ],
      { limits: { fileSize: 20 * 1024 * 1024, files: 10 } },
    ),
  )
  async upload(
    @Headers('x-purchase-attachment-ticket') ticket: string,
    @UploadedFiles()
    files: PurchaseBatchAttachmentUploadFiles = {},
    @Res({ passthrough: true }) response?: Response,
  ): Promise<{
    success: true;
    receiptPhotoCount: number;
    invoiceCount: number;
  }> {
    response?.setHeader('Cache-Control', 'no-store');
    const payload = this.tickets.verify(ticket);
    assertFeishuBusinessIdentity(this.accessConfiguration, payload.actorOpenId);
    const result = await processPurchaseBatchAttachmentUpload(payload, files, {
      gateway: this.gateway,
      store: this.store,
    });
    void this.managerApprovalService
      .runPendingTasks()
      .catch((error: unknown) => {
        this.logger.error(
          `采购卡片附件上传后的通知任务唤醒失败: ${safeErrorMessage(error)}`,
        );
      });
    return result;
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}
