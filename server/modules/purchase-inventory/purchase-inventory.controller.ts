import { businessBuildingsForAction, canPerformBusinessAction, isProfessionalBusinessPrincipal, type BusinessAction } from '../../../shared/business-permissions';
import { canAccessBuilding } from '../../../shared/building-access';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { isPersonalAccessAccount } from '../../../shared/self-service-applicant';
import { bindSelfServiceApplicant } from '../../common/access/self-service-applicant';
import { assertProfessionalRecordScope } from '../../common/access/professional-record-scope';
import { assertGlobalBusinessOperation } from '../../common/access/global-business-operation';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';
import type { Request } from 'express';
import type {
  AccessPrincipal,
  AccessRole,
} from '../../../shared/access-control.interface';
import { AdminOnly, ProfessionalScoped } from '../../common/access/unified-access.decorators';
import type {
  PurchaseApplicationBatchRequest,
  PurchaseBuilding,
} from '../../../shared/purchase-application.interface';
import type {
  PurchaseOnlineApprovalRequest,
  PurchaseRecordBatchDeleteRequest,
  PurchaseRecordUpdateRequest,
} from '../../../shared/purchase-inventory.interface';
import type {
  PurchaseWorkflowApprovalInput,
  PurchaseWorkflowOrderInput,
  PurchaseWorkflowReceiptInput,
  PurchaseWorkflowReminderCode,
} from '../../../shared/purchase-workflow.interface';
import {
  normalizePurchaseApplicationIdempotencyKey,
  normalizePurchaseApplicationSubmissionFingerprint,
  PurchaseApplicationService,
  type PurchaseApplicationUploadFile,
} from './purchase-application.service';
import { PurchaseAccessPolicyService } from './purchase-access-policy.service';
import { PurchaseInventoryService } from './purchase-inventory.service';
import { PurchaseOnlineApprovalService } from './purchase-online-approval.service';
import { PurchaseRecordDeletionService } from './purchase-record-deletion.service';
import { PurchaseRecordEditService } from './purchase-record-edit.service';
import {
  PurchaseWorkflowGateway,
  type PurchaseWorkflowUploadFile,
} from './purchase-workflow.gateway';
import { PurchaseWorkflowScheduler } from './purchase-workflow.scheduler';
import { PurchaseWorkflowReceiptTaskService } from './purchase-workflow-receipt-task.service';
import { PurchaseWorkflowService } from './purchase-workflow.service';
import {
  resolvePurchaseWorkflowReadSession,
  resolvePurchaseWorkflowSession,
} from './purchase-workflow-session';
type AccessRequest = Request & {
  accessPrincipal?: AccessPrincipal;
  accessPrincipalFingerprint?: string;
  accessRole?: AccessRole;
  accessPageRead?: boolean;
};

const FULL_PURCHASE_ROLES = new Set<AccessRole>([
  'admin',
  'editor',
  'purchase_admin',
  'supply_chain_admin',
  'professional_admin',
  'professional_engineer',
]);

@Controller('api/purchase-inventory')
export class PurchaseInventoryController {
  constructor(
    private readonly service: PurchaseInventoryService,
    private readonly accessPolicy: PurchaseAccessPolicyService,
    private readonly recordDeletionService: PurchaseRecordDeletionService,
    private readonly recordEditService: PurchaseRecordEditService,
    private readonly onlineApprovalService: PurchaseOnlineApprovalService,
    private readonly applicationService: PurchaseApplicationService,
    private readonly workflowService: PurchaseWorkflowService,
    private readonly receiptTaskService: PurchaseWorkflowReceiptTaskService,
    private readonly workflowScheduler: PurchaseWorkflowScheduler,
    private readonly workflowGateway: PurchaseWorkflowGateway,
    @Optional() private readonly configuration?: AccessConfigurationService,
  ) {}

  @Get('dashboard')
  @ProfessionalScoped()
  async getDashboard(
    @Req() req: AccessRequest,
    @Query('refresh') refresh?: string,
  ) {
    const principal = requirePrincipal(req);
    const shouldRefresh =
      refresh === 'active'
        ? 'active'
        : principal.role !== 'purchase_applicant' &&
          (refresh === '1' || refresh === 'true');
    const dashboard = await this.service.getDashboard(shouldRefresh);
    return this.accessPolicy.scopeDashboard(principal, dashboard, req.accessPageRead === true);
  }

  @Get('application-options')
  @ProfessionalScoped()
  getApplicationOptions(@Req() req: AccessRequest) {
    const principal = purchasePrincipal(requirePrincipal(req), 'create');
    const options = this.applicationService.getOptions();
    if (isProfessionalBusinessPrincipal(principal)) {
      const buildings = options.buildings.filter(building => businessBuildingsForAction(principal, principal.permissionContext!).some(allowed => allowed === building));
      return { ...options, buildings, specialties: options.specialties.filter(specialty => buildings.some(building => canPerformBusinessAction(principal, { module: 'purchase', action: 'create', building, specialty }))) };
    }
    if (principal.role === 'purchase_applicant' || principal.role === 'building_admin') {
      return {
        ...options,
        buildings: [this.accessPolicy.requireApplicantBuilding(principal)],
      };
    }
    if (!FULL_PURCHASE_ROLES.has(principal.role) && !isProfessionalBusinessPrincipal(principal)) denyAccess();
    return options;
  }

  @Post('records/batch-delete')
  @ProfessionalScoped()
  async deleteRecords(
    @Req() req: AccessRequest,
    @Body() request: PurchaseRecordBatchDeleteRequest,
  ) {
    const principal = requirePrincipal(req);
    const authorized = await this.accessPolicy.authorizeDelete(
      principal,
      request,
    );
    return this.recordDeletionService.deleteRecords(authorized);
  }

  @Patch('records/:recordId')
  @ProfessionalScoped()
  async updateRecord(
    @Req() req: AccessRequest,
    @Param('recordId') recordId: string,
    @Body() request: PurchaseRecordUpdateRequest,
  ) {
    const principal = requirePrincipal(req);
    const prepared = await this.accessPolicy.prepareUpdate(
      principal,
      recordId,
      request,
    );
    return this.recordEditService.updateRecord(recordId, prepared);
  }

  @AdminOnly()
  @ProfessionalScoped()
  @Post('records/:recordId/approval')
  async approveRecord(
    @Req() req: AccessRequest,
    @Param('recordId') recordId: string,
    @Body() request: PurchaseOnlineApprovalRequest,
  ) {
    return this.onlineApprovalService.acceptAuthorizedDecision(recordId, request, await this.getWorkflowSession(req));
  }

  @AdminOnly()
  @ProfessionalScoped()
  @Get('approval/tasks/:taskId')
  async getApprovalTask(@Req() req: AccessRequest, @Param('taskId') taskId: string) {
    return this.onlineApprovalService.getAuthorizedDecisionTaskStatus(taskId, requirePrincipal(req));
  }

  @Get('catalog-search')
  @ProfessionalScoped()
  async searchCatalog(
    @Req() req: AccessRequest,
    @Query('building') building = '',
    @Query('primaryCategory') primaryCategory = '',
    @Query('secondaryCategory') secondaryCategory = '',
    @Query('query') query = '',
    @Query('limit') limit = '50',
  ) {
    const principal = purchasePrincipal(requirePrincipal(req));
    const requestedBuilding = cleanText(building);
    let scopedBuilding = '';
    if (isProfessionalBusinessPrincipal(principal)) {
      if (!businessBuildingsForAction(principal, principal.permissionContext!).length) denyAccess();
      scopedBuilding = requestedBuilding ? String(this.accessPolicy.assertRequestedBuilding(principal, requestedBuilding)) : '';
    } else if (principal.role === 'purchase_applicant' || principal.role === 'building_admin') {
      scopedBuilding = requestedBuilding
        ? String(
            this.accessPolicy.assertRequestedBuilding(
              principal,
              requestedBuilding,
            ),
          )
        : this.accessPolicy.requireApplicantBuilding(principal);
    } else if (FULL_PURCHASE_ROLES.has(principal.role) || isProfessionalBusinessPrincipal(principal)) {
      scopedBuilding = requestedBuilding
        ? String(
            this.accessPolicy.assertRequestedBuilding(
              principal,
              requestedBuilding,
            ),
          )
        : '';
    } else {
      denyAccess();
    }
    const catalog = await this.applicationService.searchCatalog(
      {
        building: scopedBuilding,
        primaryCategory,
        secondaryCategory,
        query,
        limit: Number(limit),
      },
      false,
    );
    return isProfessionalBusinessPrincipal(principal)
      ? catalog.filter(item => canPerformBusinessAction(principal, { ...principal.permissionContext!, building: item.building, specialty: item.specialty }))
      : catalog;
  }

  @Get('applicant-search')
  @ProfessionalScoped()
  async searchApplicants(
    @Req() req: AccessRequest,
    @Query('building') building = '',
    @Query('query') query = '',
    @Query('limit') limit = '30',
    @Query('self') self = 'false',
  ) {
    const principal = purchasePrincipal(requirePrincipal(req));
    const requestedBuilding = cleanText(building);
    let scopedBuilding = '';
    if (isProfessionalBusinessPrincipal(principal)) {
      if (!businessBuildingsForAction(principal, principal.permissionContext!).length) denyAccess();
      scopedBuilding = requestedBuilding ? String(this.accessPolicy.assertRequestedBuilding(principal, requestedBuilding)) : '';
    } else if (principal.role === 'purchase_applicant' || principal.role === 'building_admin') {
      scopedBuilding = requestedBuilding
        ? String(
            this.accessPolicy.assertRequestedBuilding(
              principal,
              requestedBuilding,
            ),
          )
        : this.accessPolicy.requireApplicantBuilding(principal);
    } else if (principal.role === 'inventory_admin') {
      const sessionBuilding = String(
        this.accessPolicy.assertRequestedBuilding(
          principal,
          principal.purchaseBuilding,
        ),
      );
      const normalizedRequestedBuilding = requestedBuilding
        ? String(
            this.accessPolicy.assertRequestedBuilding(
              principal,
              requestedBuilding,
            ),
          )
        : sessionBuilding;
      if (!canAccessBuilding(principal, normalizedRequestedBuilding)) denyAccess();
      scopedBuilding = normalizedRequestedBuilding;
    } else if (FULL_PURCHASE_ROLES.has(principal.role) || isProfessionalBusinessPrincipal(principal)) {
      scopedBuilding = requestedBuilding
        ? String(
            this.accessPolicy.assertRequestedBuilding(
              principal,
              requestedBuilding,
            ),
          )
        : '';
    } else {
      denyAccess();
    }
    if (self === 'true' && isPersonalAccessAccount(principal)) {
      const applicant = await this.applicationService.resolveCurrentApplicant(principal, scopedBuilding);
      if (isProfessionalBusinessPrincipal(principal) && !canPerformBusinessAction(principal, { ...principal.permissionContext!, building: applicant.building, specialty: applicant.specialty })) denyAccess();
      return [applicant];
    }
    const applicants = await this.applicationService.searchApplicants(
      {
        building: scopedBuilding,
        query,
        limit: Number(limit),
      },
      false,
    );
    return isProfessionalBusinessPrincipal(principal)
      ? applicants.filter(person => canPerformBusinessAction(principal, { ...principal.permissionContext!, building: person.building, specialty: person.specialty }))
      : applicants;
  }

  @Post('applications')
  @ProfessionalScoped()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FilesInterceptor('comparisonAttachments', 5, {
      limits: { fileSize: 20 * 1024 * 1024, files: 5 },
    }),
  )
  async submitApplications(
    @Req() req: AccessRequest,
    @Body('payload') payload: string,
    @UploadedFiles() files: PurchaseApplicationUploadFile[] = [],
    @Headers('x-idempotency-key') idempotencyKey?: string,
    @Headers('x-idempotency-fingerprint') submissionFingerprint?: string,
  ) {
    const normalizedIdempotencyKey =
      normalizePurchaseApplicationIdempotencyKey(idempotencyKey);
    const normalizedSubmissionFingerprint =
      normalizePurchaseApplicationSubmissionFingerprint(submissionFingerprint);
    const fingerprintRequest = parsePurchaseApplicationPayload(payload);
    let request = fingerprintRequest;
    const principal = purchasePrincipal(requirePrincipal(req), 'create');
    assertProfessionalRecordScope(principal, request.shared?.specialty, request.shared?.building);
    const principalFingerprint = requireAccessPrincipalFingerprint(req);
    const building = this.accessPolicy.assertRequestedBuilding(
      principal,
      request.shared?.building,
    ) as PurchaseBuilding;
    request = {
      ...request,
      shared: { ...request.shared, building },
    };
    if (isPersonalAccessAccount(principal)) {
      bindSelfServiceApplicant(request.shared.applicantName || '', principal, true, '提交采购申请');
      const applicant = await this.applicationService.resolveCurrentApplicant(principal, building);
      if (request.shared.applicantRecordId !== applicant.recordId || request.shared.applicantOpenId !== applicant.openId) {
        throw new ForbiddenException('采购申请人必须为当前登录本人');
      }
      request = { ...request, shared: { ...request.shared,
        applicantName: applicant.name, applicantEmployeeNo: applicant.employeeNo,
        applicantPosition: applicant.position, applicantBuilding: applicant.building,
      } };
    }
    const accepted = this.applicationService.findAcceptedApplication(
      fingerprintRequest,
      files,
      building,
      normalizedIdempotencyKey,
      normalizedSubmissionFingerprint,
      principalFingerprint,
    );
    if (accepted) return accepted;
    return this.applicationService.acceptApplications(
      request,
      files,
      undefined,
      normalizedIdempotencyKey,
      normalizedSubmissionFingerprint,
      fingerprintRequest,
      principalFingerprint,
      true,
    );
  }

  @Get('applications/tasks/:taskId')
  @ProfessionalScoped()
  getApplicationSubmissionTask(
    @Req() req: AccessRequest,
    @Param('taskId') taskId: string,
  ) {
    const principal = requirePrincipal(req);
    return this.applicationService.getSubmissionTaskStatus(
      taskId,
      principal.role === 'purchase_applicant' || principal.role === 'building_admin'
        ? (principal.buildings && principal.buildings.length > 1 ? undefined : principal.purchaseBuilding)
        : undefined,
      requireAccessPrincipalFingerprint(req),
    );
  }

  @ProfessionalScoped()
  @Get('workflows/status')
  getWorkflowStatus() {
    return this.workflowScheduler.getStatus();
  }

  @AdminOnly()
  @Post('workflows/self-test')
  async selfTestWorkflows(@Req() req: Request) {
    this.workflowService.assertEnabled(requirePrincipal(req).role);
    return this.workflowService.selfTest(await this.getWorkflowSession(req));
  }

  @ProfessionalScoped()
  @Get('workflows/:recordId')
  async getWorkflowDetail(
    @Req() req: Request,
    @Param('recordId') recordId: string,
  ) {
    return this.workflowService.getDetail(
      recordId,
      await this.getWorkflowReadSession(req),
    );
  }

  @ProfessionalScoped()
  @Post('workflows/:recordId/approve')
  async approveWorkflow(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Body() input: PurchaseWorkflowApprovalInput,
  ) {
    this.workflowService.assertEnabled(requirePrincipal(req).role);
    return this.workflowService.approve(
      recordId,
      await this.getWorkflowSession(req),
      input,
    );
  }

  @ProfessionalScoped()
  @Post('workflows/:recordId/start')
  async startWorkflow(
    @Req() req: Request,
    @Param('recordId') recordId: string,
  ) {
    this.workflowService.assertEnabled(requirePrincipal(req).role);
    return this.workflowService.start(
      recordId,
      await this.getWorkflowSession(req),
    );
  }

  @ProfessionalScoped()
  @Post('workflows/:recordId/order')
  @UseInterceptors(
    FilesInterceptor('paymentAttachments', 5, {
      limits: { fileSize: 20 * 1024 * 1024, files: 5 },
    }),
  )
  async orderWorkflow(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Body('payload') payload: string,
    @UploadedFiles() files: PurchaseWorkflowUploadFile[] = [],
  ) {
    if (isProfessionalBusinessPrincipal(requirePrincipal(req))) {
      const record = await this.workflowGateway.getExecutionRecordAsApp(recordId);
      assertProfessionalRecordScope(requirePrincipal(req), record.specialty, record.building);
    }
    const session = await this.getWorkflowSession(req);
    const input = parsePayload<
      Omit<PurchaseWorkflowOrderInput, 'paymentAttachmentTokens'>
    >(payload, '下单结果');
    const paymentAttachmentTokens = await this.uploadWorkflowFiles(
      files,
      session.accessToken,
    );
    return this.workflowService.order(recordId, session, {
      ...input,
      paymentAttachmentTokens,
    });
  }

  @ProfessionalScoped()
  @Post('workflows/:recordId/receive')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'receiptPhotos', maxCount: 5 },
        { name: 'invoices', maxCount: 5 },
      ],
      { limits: { fileSize: 20 * 1024 * 1024, files: 10 } },
    ),
  )
  async receiveWorkflow(
    @Req() req: Request,
    @Param('recordId') recordId: string,
    @Body('payload') payload: string,
    @UploadedFiles()
    files: {
      receiptPhotos?: PurchaseWorkflowUploadFile[];
      invoices?: PurchaseWorkflowUploadFile[];
    } = {},
  ) {
    if (isProfessionalBusinessPrincipal(requirePrincipal(req))) {
      const record = await this.workflowGateway.getExecutionRecordAsApp(recordId);
      assertProfessionalRecordScope(requirePrincipal(req), record.specialty, record.building);
    }
    const session = await this.getWorkflowSession(req);
    const input = parsePayload<
      Omit<PurchaseWorkflowReceiptInput, 'receiptPhotoTokens' | 'invoiceTokens'>
    >(payload, '签收结果');
    return this.receiptTaskService.acceptReceipt(recordId, session, input, {
      receiptPhotos: files.receiptPhotos || [],
      invoices: files.invoices || [],
    });
  }

  @ProfessionalScoped()
  @Get('workflows/receipt-tasks/:taskId')
  async getReceiptTask(@Req() req: Request, @Param('taskId') taskId: string) {
    return this.receiptTaskService.getReceiptTaskStatus(
      taskId,
      await this.getWorkflowSession(req),
    );
  }

  @Post('workflows/reminders/:code/run')
  @ProfessionalScoped()
  async runWorkflowReminder(
    @Req() req: Request,
    @Param('code') code: PurchaseWorkflowReminderCode,
  ) {
    assertGlobalBusinessOperation(requirePrincipal(req), { module: 'purchase', action: 'notify' });
    this.workflowService.assertEnabled(requirePrincipal(req).role);
    await this.getWorkflowSession(req);
    if (!['warehouse', 'order', 'receipt'].includes(code)) {
      throw new BadRequestException('未知采购提醒代码');
    }
    return this.workflowScheduler.run(code);
  }

  private async getWorkflowSession(req: AccessRequest) {
    return resolvePurchaseWorkflowSession({
      principal: requirePrincipal(req),
      professionalOpenId: this.workflowOpenId(requirePrincipal(req)),
      getTenantAccessToken: () =>
        this.workflowGateway.getTenantAccessTokenAsApp(),
    });
  }

  private workflowOpenId(principal: AccessPrincipal): string | undefined {
    const accounts = this.configuration?.snapshot().accounts || [];
    const account = accounts.find(item => item.id === principal.accountId && item.enabled && !item.deleted);
    if (account?.openId) return account.openId;
    if (!account?.siteMember || !account.personnelIdentity || account.external) return undefined;
    return accounts.find(item => item.kind === 'feishu' && item.siteMember && !item.external && item.personnelIdentity === account.personnelIdentity && item.enabled && !item.deleted)?.openId;
  }

  private async getWorkflowReadSession(req: AccessRequest) {
    return resolvePurchaseWorkflowReadSession({
      principal: requirePrincipal(req),
      professionalOpenId: this.workflowOpenId(requirePrincipal(req)),
      getTenantAccessToken: () =>
        this.workflowGateway.getTenantAccessTokenAsApp(),
    });
  }

  private async uploadWorkflowFiles(
    files: PurchaseWorkflowUploadFile[],
    accessToken: string,
  ): Promise<string[]> {
    const tokens: string[] = [];
    for (const file of files) {
      tokens.push(
        await this.workflowGateway.uploadAttachment(file, accessToken),
      );
    }
    return tokens;
  }
}

function parsePayload<T>(payload: string, label: string): T {
  try {
    const value = JSON.parse(payload || '');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as T;
  } catch {
    throw new BadRequestException(`${label} payload 不是有效 JSON`);
  }
}

function parsePurchaseApplicationPayload(
  payload: string,
): PurchaseApplicationBatchRequest {
  const value = parsePayload<unknown>(payload, '采购申请');
  if (
    !isRecord(value) ||
    !isRecord(value.shared) ||
    !Array.isArray(value.items)
  ) {
    throw new BadRequestException('采购申请 payload 结构无效');
  }
  return value as unknown as PurchaseApplicationBatchRequest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requirePrincipal(req: AccessRequest): AccessPrincipal {
  if (!req?.accessPrincipal) denyAccess();
  return req.accessPrincipal;
}

function purchasePrincipal(principal: AccessPrincipal, action: BusinessAction = principal.permissionContext?.action || 'read'): AccessPrincipal {
  return { ...principal, permissionContext: { module: 'purchase', action } };
}

function requireAccessPrincipalFingerprint(req: AccessRequest): string {
  const fingerprint = cleanText(req?.accessPrincipalFingerprint);
  if (
    fingerprint.length < 8 ||
    fingerprint.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(fingerprint)
  ) {
    throw new ForbiddenException('当前提交会话无法验证，请重新登录');
  }
  return fingerprint;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function denyAccess(): never {
  throw new ForbiddenException('无权访问或操作该采购数据');
}
