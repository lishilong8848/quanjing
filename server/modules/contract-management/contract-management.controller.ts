import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import { assertGlobalBusinessOperation } from '../../common/access/global-business-operation';
import { Req, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { assertProfessionalBitableRecord, assertProfessionalRecordScope } from '../../common/access/professional-record-scope';
import { scopeProfessionalContracts } from './contract-professional-access';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AdminOnly, ProfessionalScoped } from '../../common/access/unified-access.decorators';
import type {
  ContractCreateKind,
  ContractCreateRequest,
  ContractEditRequest,
  ContractExpiryDispositionRequest,
  ContractNoPaymentRequiredRequest,
  ContractPaymentPlanAdjustRequest,
  ContractPaymentPlanConfirmRequest,
  ContractPaymentPlanCreateRequest,
  ContractWorkflowCode,
} from '../../../shared/contract-management.interface';
import { ContractManagementService } from './contract-management.service';
import { ContractAttachmentStorageService } from './contract-attachment-storage.service';
import { ContractWorkflowScheduler } from './contract-workflow.scheduler';
import { ContractWorkflowService } from './contract-workflow.service';
import { ContractExpiryDispositionService } from './contract-expiry-disposition.service';
import { isContractWorkflowCode } from './contract-workflow.rules';
import { ContractCreationService } from './contract-creation.service';
import type { ContractCreateUploadFile } from './contract-creation.gateway';
import { ContractPaymentFollowUpService } from './contract-payment-follow-up.service';
import { ContractEditService } from './contract-edit.service';

@AdminOnly()
@Controller('api/contract-management')
export class ContractManagementController {
  constructor(
    private readonly service: ContractManagementService,
    private readonly workflowService: ContractWorkflowService,
    private readonly workflowScheduler: ContractWorkflowScheduler,
    private readonly attachmentStorage: ContractAttachmentStorageService,
    private readonly expiryDisposition: ContractExpiryDispositionService,
    private readonly contractCreation: ContractCreationService,
    private readonly paymentFollowUp: ContractPaymentFollowUpService,
    private readonly contractEdit: ContractEditService,
  ) {}

  @Get('dashboard')
  @ProfessionalScoped()
  async getDashboard(@Query('refresh') refresh?: string, @Req() request?: Request) {
    return scopeProfessionalContracts(this.principal(request), await this.service.getDashboard(refresh === '1' || refresh === 'true'));
  }

  @ProfessionalScoped()
  @Get('workflows')
  getWorkflowStatus() {
    return this.workflowScheduler.getStatus();
  }

  @Get('attachments/storage')
  @ProfessionalScoped()
  getAttachmentStorageStatus() {
    // Shared storage health/capability metadata; no contract records are returned.
    return this.attachmentStorage.getStatus();
  }

  @Patch('contracts/:recordId/expiry-disposition')
  @ProfessionalScoped()
  async updateContractExpiryDisposition(
    @Param('recordId') recordId: string,
    @Body() body: ContractExpiryDispositionRequest,
    @Req() request?: Request) {
    await this.assertContractScope(request, recordId);
    return this.expiryDisposition.submit(recordId, body, new Date(), this.principal(request));
  }

  @Get('contracts/expiry-disposition-tasks/:taskId')
  @ProfessionalScoped()
  async getContractExpiryDispositionTask(@Param('taskId') taskId: string, @Req() request?: Request) {
    const result = await this.expiryDisposition.getTaskStatus(taskId);
    if (result.task) await this.assertContractScope(request, result.task.recordId);
    return result;
  }

  @Get('contracts/create-options')
  @ProfessionalScoped()
  getContractCreateOptions(@Query('kind') kind: ContractCreateKind, @Req() request?: Request) {
    if (kind !== 'framework' && kind !== 'execution') {
      throw new BadRequestException('合同类型无效');
    }
    if (this.principal(request)?.role === 'professional_admin' && kind !== 'execution') throw new ForbiddenException('框架合同尚未维护专业归属');
    return this.contractCreation.getOptions(kind);
  }

  @Post('contracts')
  @ProfessionalScoped()
  @UseInterceptors(
    FilesInterceptor('attachments', 5, {
      limits: { fileSize: 20 * 1024 * 1024, files: 5 },
    }),
  )
  createContract(
    @Body('payload') payload: string,
    @UploadedFiles() files: ContractCreateUploadFile[] = [],
    @Req() request?: Request,
  ) {
    let createRequest: ContractCreateRequest;
    try {
      createRequest = JSON.parse(payload) as ContractCreateRequest;
    } catch {
      throw new BadRequestException('新增合同 payload 不是有效 JSON');
    }
    assertProfessionalBitableRecord(this.principal(request), { record_id: '', fields: createRequest.kind === 'execution' ? { 专业类别: createRequest.fields?.fldGqKUOPN, 对应楼栋设备: createRequest.fields?.fldvkLAuxc } : {} });
    return this.contractCreation.create(createRequest, files, { principal: this.principal(request) });
  }

  @Get('contracts/:recordId/payment-follow-up-options')
  @ProfessionalScoped()
  async getContractPaymentFollowUpOptions(@Param('recordId') recordId: string, @Req() request?: Request) {
    return this.paymentFollowUp.getOptions(recordId,this.principal(request));
  }

  @Get('contracts/:recordId/edit-options')
  @ProfessionalScoped()
  async getContractEditOptions(@Param('recordId') recordId: string, @Req() request?: Request) {
    return this.contractEdit.getOptions(recordId,this.principal(request));
  }

  @Patch('contracts/:recordId')
  @ProfessionalScoped()
  async updateContractInformation(
    @Param('recordId') recordId: string,
    @Body() body: ContractEditRequest,
    @Req() request?: Request) {
    await this.assertContractScope(request, recordId);
    return this.contractEdit.update(recordId, body, this.principal(request));
  }

  @Post('contracts/:recordId/payment-plans')
  @ProfessionalScoped()
  async createContractPaymentPlan(
    @Param('recordId') recordId: string,
    @Body() body: ContractPaymentPlanCreateRequest,
    @Req() request?: Request) {
    await this.assertContractScope(request, recordId);
    return this.paymentFollowUp.createPlan(recordId, body, this.principal(request));
  }

  @Patch('contracts/:recordId/payment-plans/:paymentRecordId')
  @ProfessionalScoped()
  async adjustContractPaymentPlan(
    @Param('recordId') recordId: string,
    @Param('paymentRecordId') paymentRecordId: string,
    @Body() body: ContractPaymentPlanAdjustRequest,
    @Req() request?: Request) {
    await this.assertContractScope(request, recordId);
    return this.paymentFollowUp.adjustPlan(recordId, paymentRecordId, body, this.principal(request));
  }

  @Post('contracts/:recordId/payment-plans/:paymentRecordId/confirm')
  @ProfessionalScoped()
  async confirmContractPaymentPlan(
    @Param('recordId') recordId: string,
    @Param('paymentRecordId') paymentRecordId: string,
    @Body() body: ContractPaymentPlanConfirmRequest,
    @Req() request?: Request) {
    await this.assertContractScope(request, recordId);
    return this.paymentFollowUp.confirmPlan(recordId, paymentRecordId, body, this.principal(request));
  }

  @Patch('contracts/:recordId/payment-follow-up-disposition')
  @ProfessionalScoped()
  async markContractNoPaymentRequired(
    @Param('recordId') recordId: string,
    @Body() body: ContractNoPaymentRequiredRequest,
    @Req() request?: Request) {
    await this.assertContractScope(request, recordId);
    return this.paymentFollowUp.markNoPaymentRequired(recordId, body, this.principal(request));
  }

  @Get('attachments/:accessId/manifest')
  @ProfessionalScoped()
  async getAttachmentManifest(@Param('accessId') accessId: string, @Req() request?: Request) {
    await this.assertAttachmentScope(request, accessId);
    return this.attachmentStorage.getManifest(accessId);
  }

  @Get('attachments/:accessId/pages/:page')
  @ProfessionalScoped()
  async getAttachmentPage(
    @Param('accessId') accessId: string,
    @Param('page') pageValue: string,
    @Res() response: Response,
    @Req() request?: Request) {

    await this.assertAttachmentScope(request, accessId);
    const page = Number(pageValue);
    if (!Number.isInteger(page) || page < 1 || page > 300) {
      throw new BadRequestException('合同预览页码无效');
    }
    const result = await this.attachmentStorage.getPreviewPage(accessId, page);
    response.setHeader('Content-Type', result.contentType);
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(result.buffer);
  }

  @Get('attachments/:accessId/download')
  @ProfessionalScoped()
  async downloadAttachment(
    @Param('accessId') accessId: string,
    @Query('disposition') disposition: string | undefined,
    @Res() response: Response,
    @Req() request?: Request) {

    await this.assertAttachmentScope(request, accessId);
    const result = await this.attachmentStorage.getOriginal(accessId);
    response.setHeader('Content-Type', result.contentType);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Disposition',
      `${disposition === 'inline' ? 'inline' : 'attachment'}; filename="contract.pdf"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
    );
    response.send(result.buffer);
  }

  @AdminOnly()
  @Post('workflows/self-test')
  selfTestWorkflows() {
    return this.workflowService.selfTest();
  }

  @Post('workflows/:code/run')
  @ProfessionalScoped()
  runWorkflow(@Param('code') code: string, @Req() request?: Request) {
    if (!isContractWorkflowCode(code)) {
      throw new BadRequestException(`未知合同工作流：${code}`);
    }
    assertGlobalBusinessOperation(this.principal(request), { module: 'contracts', action: 'notify' });
    return this.workflowService.run(code, { trigger: 'manual' });
  }
  private principal(request?: Request): AccessPrincipal | undefined { return (request as (Request & { accessPrincipal?: AccessPrincipal }) | undefined)?.accessPrincipal; }
  private async assertContractScope(request: Request | undefined, recordId: string): Promise<void> {
    const principal = this.principal(request);
    if (!isProfessionalBusinessPrincipal(principal)) return;
    await this.contractEdit.authorize(recordId, principal);
  }
  private async assertAttachmentScope(request: Request | undefined, accessId: string): Promise<void> {
    const principal = this.principal(request);
    if (!isProfessionalBusinessPrincipal(principal)) return;
    const dashboard = await this.service.getDashboard(false);
    const matches = [...dashboard.contracts, ...dashboard.unsignedContracts].filter(item => item.attachments.some(attachment => attachment.accessId === accessId));
    assertProfessionalRecordScope(principal, matches.length === 1 ? matches[0].specialty : undefined, matches.length === 1 ? matches[0].buildings : undefined);
    await this.contractEdit.authorize(matches[0].recordId, principal);
  }

}
