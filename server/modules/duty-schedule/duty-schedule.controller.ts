import { toGuestScheduleOverview } from './guest-schedule-overview';
import { bindLeaveRequestApplicant } from './leave-request-applicant';
import { bindSelfServiceApplicant } from '@server/common/access/self-service-applicant';
import { bindWorkforceRequestApplicant } from '@server/common/access/workforce-request-applicant';
import { isPersonalAccessAccount } from '@shared/self-service-applicant';
import {
  BadRequestException,
  Controller,
  type CallHandler,
  type ExecutionContext,
  ForbiddenException,
  Get,
  Logger,
  type NestInterceptor,
  Optional,
  Post,
  Body,
  Query,
  Param,
  Req,
  Res,
  ServiceUnavailableException,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  AnyFilesInterceptor,
  FileInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { diskStorage } from 'multer';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import {
  canStageChangeAttachmentForRole,
  canSubmitChangeDrillReportForRole,
  canSubmitChangeSummaryReportForRole,
  type AccessRole,
  type AccessPrincipal,
} from '@shared/access-control.interface';
import {
  AdminOnly,
  GuestReadable,
  GuestSubmittable,
  PublicAccess,
  ProfessionalScoped,
} from '@server/common/access/unified-access.decorators';
import { assertProfessionalRecordScope } from '@server/common/access/professional-record-scope';
import { readEnv } from '@server/common/config/external-services.config';
import {
  DutyScheduleService,
  type ChangeSelfTestBoundAttachmentCleanupRequest,
  type ChangeSelfTestBoundAttachmentCleanupResponse,
} from '@server/modules/duty-schedule/duty-schedule.service';
import { DutyScheduleAutomationService } from '@server/modules/duty-schedule/duty-schedule.automation';
import { DutyScreenshotService } from '@server/modules/duty-schedule/duty-screenshot.service';
import { TyphoonWarningMonitorService } from '@server/modules/duty-schedule/typhoon-warning-monitor.service';
import { OvertimeWorkflowService } from '@server/modules/overtime-workflow/overtime-workflow.service';
import { LeaveWorkflowService } from '@server/modules/leave-workflow/leave-workflow.service';
import type {
  AdditionalMatterCreateRequest,
  AdditionalMatterCreateResponse,
  Building,
  BatchDutyScheduleRequest,
  BatchDutyScheduleResponse,
  ChangeScheduleAdjustmentRequest,
  ChangeScheduleAdjustmentResponse,
  ConstructionApplicationCreateRequest,
  ConstructionApplicationCreateResponse,
  ConstructionAttachmentDeleteRequest,
  ConstructionAttachmentDeleteResponse,
  ConstructionChangeOrderCandidatesResponse,
  ConstructionCrewRosterOutlookSyncRequest,
  ConstructionCrewRosterOutlookSyncResponse,
  ConstructionCrewRosterUploadSyncRequest,
  ConstructionCrewRosterUploadSyncResponse,
  ConstructionFollowupCreateRequest,
  ConstructionFollowupCreateResponse,
  ConstructionIsolationPhotoManualReviewUpdateRequest,
  ConstructionIsolationPhotoManualReviewUpdateResponse,
  ConstructionManagementResponse,
  ConstructionPermitManualReviewRequest,
  ConstructionPermitManualReviewResponse,
  ConstructionPermitManualReviewUpdateRequest,
  ConstructionPermitManualReviewUpdateResponse,
  ConstructionProjectDeleteRequest,
  ConstructionProjectDeleteResponse,
  ConstructionProjectTerminateRequest,
  ConstructionProjectTerminateResponse,
  ConstructionStaffCandidatesResponse,
  DutyStaffActualRepairRequest,
  DutyStaffActualRepairResponse,
  DutyStaffActualRepairScanResponse,
  DutyStaffAdjustmentRequest,
  DutyStaffAdjustmentResponse,
  DutyOverviewScreenshotResponse,
  TyphoonPathGroupScreenshotRequest,
  TyphoonPathGroupScreenshotResponse,
  TyphoonPathScreenshotPreviewResponse,
  TyphoonPathScreenshotResponse,
  ExceptionFollowUpCreateRequest,
  ExceptionFollowUpCreateResponse,
  ExceptionFollowUpDeleteRequest,
  ExceptionFollowUpDeleteResponse,
  ExceptionFollowUpListResponse,
  ExceptionFollowUpUpdateRequest,
  ExceptionFollowUpUpdateResponse,
  LeaveRequestCreateRequest,
  LeaveRequestCreateResponse,
  OvertimeRequestCreateRequest,
  OvertimeRequestCreateResponse,
  SealingRegistrationCreateRequest,
  SealingRegistrationCreateResponse,
  LongWhiteDutyStaffResponse,
  PersonnelMovementCreateRequest,
  PersonnelMovementCreateResponse,
  MonthlyScheduleResponse,
  MonthlyScheduleScreenshotAccessRequest,
  MonthlyScheduleScreenshotAccessResponse,
  TodayFocusChecklistResponse,
  TravelStaffAdjustRequest,
  TravelStaffDetailResponse,
  TravelStaffMutationResponse,
  TravelStaffRevokeRequest,
  TravelStaffUpdateRequest,
  TravelStaffUpdateResponse,
  VacancySubstituteUpdateRequest,
  VacancySubstituteUpdateResponse,
  YearlyChangeInfoResponse,
  YearlySealingInfoResponse,
} from '@shared/api.interface';
import {
  isAllowedChangeRequestDocument,
  parseChangeRequestPayload,
  validateChangeRequest,
  type ChangeAttachmentDeleteResponse,
  type ChangeAttachmentStageResponse,
  type ChangeRequestCreateRequest,
  type ChangeRequestCreateResponse,
} from '@shared/change-request';
import type {
  ChangeAdjustmentRequest,
  ChangeAdjustmentResponse,
} from '@shared/change-adjustment';
import type {
  ChangeDrillReportCreateRequest,
  ChangeDrillReportCreateResponse,
} from '@shared/change-drill-report';
import type {
  ChangeSummaryReportAbandonRequest,
  ChangeSummaryReportAbandonResponse,
  ChangeSummaryReportCreateRequest,
  ChangeSummaryReportCreateResponse,
  ChangeSummaryReportSyncTaskResponse,
} from '@shared/change-summary-report';
import type {
  ChangeSummaryReportSelfTestCleanupRequest,
  ChangeSummaryReportSelfTestCleanupResponse,
} from './change-summary-report.service';
import type { FailedChangeSummarySelfTestCleanupRequest } from './change-summary-report-failed-self-test-finalizer';
import type { ConstructionUploadFile } from './construction-management';
import {
  CHANGE_ATTACHMENT_MAX_BYTES,
  ChangeAttachmentStorageService,
} from './change-attachment-storage.service';
import {
  prepareChangeAttachmentTempDirectory,
  removeExactChangeAttachmentTempFile,
} from './change-attachment-temp-directory';
import {
  compactConstructionManagementResponse,
  type ConstructionManagementTransportResponse,
} from '@shared/construction-management-transport';

type DutyScheduleAccessRequest = Request & {
  accessPrincipal?: AccessPrincipal;
  accessRole?: AccessRole;
  accessPrincipalFingerprint?: string;
};

const ACCESS_PRINCIPAL_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function requireAccessPrincipalFingerprint(
  request: DutyScheduleAccessRequest,
): string {
  const fingerprint = String(request.accessPrincipalFingerprint || '').trim();
  if (!ACCESS_PRINCIPAL_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new ForbiddenException('当前提交会话无法验证，请重新登录');
  }
  return fingerprint;
}

interface ChangeAttachmentTempUploadFile extends ConstructionUploadFile {
  path: string;
}

const CHANGE_ATTACHMENT_OWNER_MUTATION_ID_PATTERN =
  /^(?:change-request|change-adjustment|change-drill-report|change-summary-report)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANGE_ATTACHMENT_UPLOAD_ADMISSION_DEFAULT_CONCURRENCY = 2;
const CHANGE_ATTACHMENT_UPLOAD_ADMISSION_DEFAULT_QUEUE_LIMIT = 4;

interface UploadAdmissionReservation {
  permit: Promise<() => void>;
  cancel: () => void;
}

class ChangeAttachmentUploadAdmissionGate {
  private active = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly queueLimit: number,
  ) {}

  reserve(): UploadAdmissionReservation {
    let release: (() => void) | null = null;
    let cancelled = false;
    let queued: ((value: () => void) => void) | null = null;
    const accept = (nextRelease: () => void) => {
      if (cancelled) {
        nextRelease();
        return;
      }
      release = nextRelease;
      queued?.(nextRelease);
    };
    let permit: Promise<() => void>;
    if (this.active < this.concurrency) {
      this.active += 1;
      const granted = this.createRelease();
      release = granted;
      permit = Promise.resolve(granted);
    } else if (this.waiters.length >= this.queueLimit) {
      permit = Promise.reject(
        new ServiceUnavailableException('变更附件上传繁忙，请稍后重试'),
      );
    } else {
      permit = new Promise<() => void>((resolvePermit) => {
        queued = resolvePermit;
        this.waiters.push(accept);
      });
    }
    return {
      permit,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        const index = this.waiters.indexOf(accept);
        if (index >= 0) this.waiters.splice(index, 1);
        release?.();
      },
    };
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(this.createRelease());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}

export class ChangeAttachmentUploadAdmissionInterceptor implements NestInterceptor {
  private readonly gate: ChangeAttachmentUploadAdmissionGate;

  constructor(
    options: { concurrency: number; queueLimit: number } = {
      concurrency: readBoundedUploadAdmissionSetting(
        'CHANGE_ATTACHMENT_ROUTE_UPLOAD_CONCURRENCY',
        CHANGE_ATTACHMENT_UPLOAD_ADMISSION_DEFAULT_CONCURRENCY,
        1,
        8,
      ),
      queueLimit: readBoundedUploadAdmissionSetting(
        'CHANGE_ATTACHMENT_ROUTE_UPLOAD_QUEUE_LIMIT',
        CHANGE_ATTACHMENT_UPLOAD_ADMISSION_DEFAULT_QUEUE_LIMIT,
        0,
        32,
      ),
    },
  ) {
    if (
      !Number.isSafeInteger(options.concurrency) ||
      options.concurrency < 1 ||
      options.concurrency > 8 ||
      !Number.isSafeInteger(options.queueLimit) ||
      options.queueLimit < 0 ||
      options.queueLimit > 32
    ) {
      throw new Error('变更附件路由上传门控配置无效');
    }
    this.gate = new ChangeAttachmentUploadAdmissionGate(
      options.concurrency,
      options.queueLimit,
    );
  }

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return new Observable((subscriber) => {
      const reservation = this.gate.reserve();
      let downstream: { unsubscribe: () => void } | null = null;
      let release: (() => void) | null = null;
      let closed = false;
      const releaseOnce = () => {
        release?.();
        release = null;
      };
      void reservation.permit.then(
        (grantedRelease) => {
          if (closed) {
            grantedRelease();
            return;
          }
          release = grantedRelease;
          try {
            downstream = next.handle().subscribe({
              next: (value) => subscriber.next(value),
              error: (error) => {
                releaseOnce();
                subscriber.error(error);
              },
              complete: () => {
                releaseOnce();
                subscriber.complete();
              },
            });
          } catch (error) {
            releaseOnce();
            subscriber.error(error);
          }
        },
        (error) => subscriber.error(error),
      );
      return () => {
        closed = true;
        reservation.cancel();
        downstream?.unsubscribe();
        releaseOnce();
      };
    });
  }
}

function readBoundedUploadAdmissionSetting(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`变更附件配置 ${name} 无效`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`变更附件配置 ${name} 无效`);
  }
  return value;
}

function isDirectLoopbackRequest(request: Request): boolean {
  const address = String(request.socket?.remoteAddress || '').trim();
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

const changeAttachmentUploadAdmissionInterceptor =
  new ChangeAttachmentUploadAdmissionInterceptor();

function normalizeChangeAttachmentOwnerMutationId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!CHANGE_ATTACHMENT_OWNER_MUTATION_ID_PATTERN.test(normalized)) {
    throw new BadRequestException('变更附件请求标识无效');
  }
  return normalized;
}

function changeAttachmentTempDestination(
  _request: Request,
  _file: unknown,
  callback: (error: Error | null, destination: string) => void,
): void {
  void prepareChangeAttachmentTempDirectory().then(
    (destination) => callback(null, destination),
    (error: unknown) => callback(error as Error, ''),
  );
}

function parseChangeRequestBody(
  payload: unknown,
  body: unknown,
): ChangeRequestCreateRequest {
  const candidate =
    typeof payload === 'string' && payload.trim().length > 0 ? payload : body;
  return parseChangeRequestPayload(candidate);
}

function changeRequestDocumentFileFilter(
  _request: Request,
  file: ConstructionUploadFile,
  callback: (error: Error | null, acceptFile: boolean) => void,
): void {
  const fileName = String(file.originalname || '').trim();
  if (
    !fileName ||
    fileName.length > 180 ||
    /[\u0000-\u001f\u007f/\\]/.test(fileName)
  ) {
    callback(new BadRequestException('变更文档文件名无效'), false);
    return;
  }
  if (!isAllowedChangeRequestDocument(file)) {
    callback(
      new BadRequestException(
        '变更文档仅支持 PDF、Word、Excel、PNG、JPG、JPEG',
      ),
      false,
    );
    return;
  }
  callback(null, true);
}

function leaveRequestScreenshotFileFilter(
  _request: Request,
  file: ConstructionUploadFile,
  callback: (error: Error | null, acceptFile: boolean) => void,
): void {
  const fileName = String(file.originalname || '').trim();
  if (
    !fileName ||
    fileName.length > 180 ||
    /[\u0000-\u001f\u007f/\\]/.test(fileName)
  ) {
    callback(new BadRequestException('流程截图文件名无效'), false);
    return;
  }
  const extension = /\.[^.]+$/.exec(fileName.toLowerCase())?.[0] || '';
  const expectedMimeByExtension: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  if (expectedMimeByExtension[extension] !== file.mimetype) {
    callback(
      new BadRequestException('流程截图仅支持 PNG、JPG、JPEG、WebP 图片'),
      false,
    );
    return;
  }
  callback(null, true);
}

function overtimeRequestScreenshotFileFilter(
  _request: Request,
  file: ConstructionUploadFile,
  callback: (error: Error | null, acceptFile: boolean) => void,
): void {
  const fileName = String(file.originalname || '').trim();
  if (
    !fileName ||
    fileName.length > 180 ||
    /[\u0000-\u001f\u007f/\\]/.test(fileName)
  ) {
    callback(new BadRequestException('加班举证截图文件名无效'), false);
    return;
  }
  const extension = /\.[^.]+$/.exec(fileName.toLowerCase())?.[0] || '';
  const expectedMimeByExtension: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };
  if (expectedMimeByExtension[extension] !== file.mimetype) {
    callback(
      new BadRequestException('加班举证截图仅支持 PNG、JPG、JPEG、WebP 图片'),
      false,
    );
    return;
  }
  callback(null, true);
}

function parseLeaveRequestPayload(payload: string): LeaveRequestCreateRequest {
  if (typeof payload !== 'string' || !payload.trim()) {
    throw new Error('请休假 payload 不能为空');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('请休假 payload 不是有效 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请休假 payload 必须是对象');
  }
  return parsed as LeaveRequestCreateRequest;
}

function parseOvertimeRequestPayload(
  payload: string,
): OvertimeRequestCreateRequest {
  if (typeof payload !== 'string' || !payload.trim()) {
    throw new Error('加班 payload 不能为空');
  }
  if (Buffer.byteLength(payload, 'utf8') > 16 * 1024) {
    throw new Error('加班 payload 不能超过 16 KiB');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('加班 payload 不是有效 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('加班 payload 必须是对象');
  }
  return parsed as OvertimeRequestCreateRequest;
}

function hasOwnRuntimeProperty(
  value: unknown,
  property: string,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, property)
  );
}

@Controller('api')
export class DutyScheduleController {
  private readonly logger = new Logger(DutyScheduleController.name);

  constructor(
    private readonly dutyScheduleService: DutyScheduleService,
    private readonly dutyScheduleAutomationService: DutyScheduleAutomationService,
    private readonly dutyScreenshotService: DutyScreenshotService,
    private readonly typhoonWarningMonitorService: TyphoonWarningMonitorService,
    @Optional()
    private readonly changeAttachmentStorage?: ChangeAttachmentStorageService,
    @Optional()
    private readonly overtimeWorkflowService?: OvertimeWorkflowService,
    @Optional()
    private readonly leaveWorkflowService?: LeaveWorkflowService,
  ) {
    this.typhoonWarningMonitorService.start();
  }

  @GuestReadable()
  @Get('buildings')
  async getBuildings(): Promise<Building[]> {
    return this.dutyScheduleService.getBuildings();
  }

  @GuestReadable()
  @Get('duty-schedules')
  async getDutySchedules(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.dutyScheduleService.getDutySchedules(startDate, endDate);
  }

  @Post('duty-schedules/batch')
  async batchUpsertDutySchedules(
    @Body() body: BatchDutyScheduleRequest,
  ): Promise<BatchDutyScheduleResponse> {
    return this.dutyScheduleService.batchUpsertDutySchedules(body.schedules);
  }

  @PublicAccess()
  @Post('monthly-schedules/access/screenshot-check')
  async checkMonthlyScheduleScreenshotAccess(
    @Body() body: MonthlyScheduleScreenshotAccessRequest,
  ): Promise<MonthlyScheduleScreenshotAccessResponse> {
    return this.dutyScheduleService.verifyMonthlyScheduleScreenshotAccess(
      body || {},
    );
  }

  @GuestReadable()
  @Get('monthly-schedules/:year/:month')
  async getMonthlySchedules(
    @Param('year') year: string,
    @Param('month') month: string,
    @Query('refresh') refresh?: string,
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<MonthlyScheduleResponse> {
    const schedules = await this.dutyScheduleService.getMonthlySchedules(
      parseInt(year, 10),
      parseInt(month, 10),
      refresh === '1' || refresh === 'true',
    );
    return { schedules: (request?.accessRole ?? 'guest') === 'guest' ? toGuestScheduleOverview(schedules) : schedules };
  }

  @Get('duty-program-modified/scan')
  async scanDutyProgramModifiedIssues(
    @Query('limit') limit?: string,
    @Query('refresh') refresh?: string,
  ): Promise<DutyStaffActualRepairScanResponse> {
    return this.dutyScheduleService.scanDutyProgramModifiedIssues(
      limit ? parseInt(limit, 10) : 200,
      refresh === '1' || refresh === 'true',
    );
  }

  @Post('duty-program-modified/repair')
  async repairDutyProgramModifiedIssues(
    @Body() body: DutyStaffActualRepairRequest,
  ): Promise<DutyStaffActualRepairResponse> {
    return this.dutyScheduleService.repairDutyProgramModifiedIssues(body || {});
  }

  @Post('duty-schedules/vacancy-substitute')
  async updateVacancySubstitutes(
    @Body() body: VacancySubstituteUpdateRequest,
  ): Promise<VacancySubstituteUpdateResponse> {
    return this.dutyScheduleService.updateVacancySubstitutes(
      body || { updates: [] },
    );
  }

  @Post('duty-schedules/staff-adjustment')
  async updateDutyStaffAdjustment(
    @Body() body: DutyStaffAdjustmentRequest,
  ): Promise<DutyStaffAdjustmentResponse> {
    return this.dutyScheduleService.updateDutyStaffAdjustment(body);
  }

  @Post('duty-schedules/travel-staff')
  async updateTravelStaff(
    @Body() body: TravelStaffUpdateRequest,
  ): Promise<TravelStaffUpdateResponse> {
    return this.dutyScheduleService.updateTravelStaff(body);
  }

  @GuestReadable()
  @Get('duty-schedules/travel-staff')
  async getTravelStaffDetails(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('staffName') staffName?: string,
    @Query('refresh') refresh?: string,
  ): Promise<TravelStaffDetailResponse> {
    return this.dutyScheduleService.getTravelStaffDetails({
      startDate,
      endDate,
      staffName,
      forceRefresh: refresh === '1' || refresh === 'true',
    });
  }

  @GuestReadable()
  @Get('duty-schedules/long-white-duty-staff')
  async getLongWhiteDutyStaff(
    @Query('date') date?: string,
    @Query('refresh') refresh?: string,
  ): Promise<LongWhiteDutyStaffResponse> {
    return this.dutyScheduleService.getLongWhiteDutyStaff(
      date,
      refresh === '1' || refresh === 'true',
    );
  }

  @Post('duty-schedules/travel-staff/adjust')
  async adjustTravelStaff(
    @Body() body: TravelStaffAdjustRequest,
  ): Promise<TravelStaffMutationResponse> {
    return this.dutyScheduleService.adjustTravelStaff(body);
  }

  @AdminOnly()
  @Post('duty-schedules/travel-staff/revoke')
  async revokeTravelStaff(
    @Body() body: TravelStaffRevokeRequest,
  ): Promise<TravelStaffMutationResponse> {
    return this.dutyScheduleService.revokeTravelStaff(body);
  }

  @Post('duty-schedules/personnel-movement')
  async createPersonnelMovement(
    @Body() body: PersonnelMovementCreateRequest,
  ): Promise<PersonnelMovementCreateResponse> {
    return this.dutyScheduleService.createPersonnelMovement(body);
  }

  @Post('duty-schedules/additional-matter')
  async createAdditionalMatter(
    @Body() body: AdditionalMatterCreateRequest,
  ): Promise<AdditionalMatterCreateResponse> {
    return this.dutyScheduleService.createAdditionalMatter(body);
  }

  @Post('duty-schedules/sealing-registration')
  async createSealingRegistration(
    @Body() body: SealingRegistrationCreateRequest,
  ): Promise<SealingRegistrationCreateResponse> {
    return this.dutyScheduleService.createSealingRegistration(body);
  }

  @GuestSubmittable()
  @Post('duty-schedules/leave-request')
  @UseInterceptors(
    FilesInterceptor('screenshot', 1, {
      limits: {
        files: 1,
        fileSize: 10 * 1024 * 1024,
        fields: 1,
        parts: 3,
        fieldSize: 1024 * 1024,
        fieldNameSize: 64,
      },
      fileFilter: leaveRequestScreenshotFileFilter,
    }),
  )
  async createLeaveRequest(
    @Body('payload') payload: string,
    @UploadedFiles() files: ConstructionUploadFile[] = [],
    @Req() accessRequest?: DutyScheduleAccessRequest,
  ): Promise<LeaveRequestCreateResponse> {
    let request: LeaveRequestCreateRequest;
    try {
      request = parseLeaveRequestPayload(payload);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : '请休假 payload 无效',
      );
    }
    request.leaveStaffName = bindLeaveRequestApplicant(
      request.leaveStaffName || '',
      accessRequest?.accessPrincipal,
      Boolean(accessRequest?.accessPrincipalFingerprint),
    );
    const result = await this.dutyScheduleService.createLeaveRequest(
      request,
      files[0],
      accessRequest?.accessPrincipal,
    );
    if (!this.leaveWorkflowService?.isEnabled()) return result;
    const workflow = await this.leaveWorkflowService.acceptApplications({
      clientMutationId: result.clientMutationId,
      recordIds: result.recordIds,
      leaveStaffName: result.leaveStaffName,
      startAt: result.startAt,
      endAt: result.endAt,
      leaveType: request.leaveType,
      leaveHours: result.minimumHours,
      approvalDayCount: new Set(
        result.affectedSchedules.map((schedule) => schedule.date),
      ).size,
      shiftGroups: result.shiftGroups,
      reason: request.leaveReason,
    });
    return {
      ...result,
      approvalWorkflow: {
        mode: 'program_card',
        accepted: true,
        pending: true,
        recordIds: workflow.recordIds,
      },
    };
  }

  @GuestSubmittable()
  @Post('duty-schedules/overtime-request')
  @UseInterceptors(
    FilesInterceptor('screenshot', 1, {
      limits: {
        files: 1,
        fileSize: 10 * 1024 * 1024,
        fields: 1,
        parts: 3,
        fieldSize: 16 * 1024,
        fieldNameSize: 64,
      },
      fileFilter: overtimeRequestScreenshotFileFilter,
    }),
  )
  async createOvertimeRequest(
    @Body('payload') payload: string,
    @UploadedFiles() files: ConstructionUploadFile[] = [],
    @Req() accessRequest?: DutyScheduleAccessRequest,
  ): Promise<OvertimeRequestCreateResponse> {
    let request: OvertimeRequestCreateRequest;
    try {
      request = parseOvertimeRequestPayload(payload);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : '加班 payload 无效',
      );
    }
    request.staffName = bindWorkforceRequestApplicant(request.staffName || '', accessRequest?.accessPrincipal, Boolean(accessRequest?.accessPrincipalFingerprint), '提交加班申请');
    const result = await this.dutyScheduleService.createOvertimeRequest(
      request,
      files[0],
      ...(isPersonalAccessAccount(accessRequest?.accessPrincipal) ? [accessRequest!.accessPrincipal] : []),
    );
    if (!this.overtimeWorkflowService) {
      throw new ServiceUnavailableException('加班审批工作流暂不可用');
    }
    if (!this.overtimeWorkflowService.isEnabled()) return result;
    await this.overtimeWorkflowService.acceptApplication({ request, result });
    return result;
  }

  @GuestSubmittable()
  @Post('duty-schedules/change-attachments/stage')
  @UseInterceptors(
    changeAttachmentUploadAdmissionInterceptor,
    FileInterceptor('file', {
      storage: diskStorage({
        destination: changeAttachmentTempDestination,
        filename: (_request, _file, callback) => callback(null, randomUUID()),
      }),
      limits: {
        files: 1,
        fileSize: CHANGE_ATTACHMENT_MAX_BYTES,
        fields: 1,
        parts: 3,
        fieldSize: 512,
        fieldNameSize: 64,
      },
      fileFilter: changeRequestDocumentFileFilter,
    }),
  )
  async stageChangeAttachment(
    @Body('ownerMutationId') ownerMutationId: string,
    @UploadedFile() file?: ChangeAttachmentTempUploadFile,
    @Req() accessRequest?: DutyScheduleAccessRequest,
  ): Promise<ChangeAttachmentStageResponse> {
    if (!file?.path) {
      throw new BadRequestException('请选择变更方案附件');
    }

    try {
      const normalizedOwnerMutationId =
        normalizeChangeAttachmentOwnerMutationId(ownerMutationId);
      if (
        !canStageChangeAttachmentForRole(
          accessRequest?.accessRole,
          normalizedOwnerMutationId,
        )
      ) {
        throw new ForbiddenException('当前身份无权暂存变更总结附件');
      }
      if (!this.changeAttachmentStorage) {
        throw new ServiceUnavailableException('变更附件对象存储未配置');
      }
      const metadata = await this.changeAttachmentStorage.stageFromDisk(
        {
          path: file.path,
          name: file.originalname,
          mimetype: file.mimetype || 'application/octet-stream',
          size: file.size,
        },
        normalizedOwnerMutationId,
      );
      return {
        success: true,
        document: {
          name: metadata.name,
          originalname: metadata.name,
          type: metadata.mimeType,
          mimetype: metadata.mimeType,
          size: metadata.size,
          objectStorage: {
            id: metadata.id,
            filePath: metadata.filePath,
            bucketId: metadata.bucketId,
            url: metadata.url,
          },
        },
      };
    } finally {
      await removeExactChangeAttachmentTempFile(file.path);
    }
  }

  @GuestSubmittable()
  @Post('duty-schedules/change-attachments/:id/delete')
  async deleteStagedChangeAttachment(
    @Param('id') id: string,
    @Body('ownerMutationId') ownerMutationId: string,
    @Req() accessRequest: DutyScheduleAccessRequest,
  ): Promise<ChangeAttachmentDeleteResponse> {
    const normalizedOwnerMutationId =
      normalizeChangeAttachmentOwnerMutationId(ownerMutationId);
    if (
      !canStageChangeAttachmentForRole(
        accessRequest.accessRole,
        normalizedOwnerMutationId,
      )
    ) {
      throw new ForbiddenException('当前身份无权删除变更总结附件');
    }
    if (!this.changeAttachmentStorage) {
      throw new ServiceUnavailableException('变更附件对象存储未配置');
    }
    await this.changeAttachmentStorage.resolveOwned(
      id,
      normalizedOwnerMutationId,
    );
    const deleted = await this.changeAttachmentStorage.delete(id, {
      ownerMutationId: normalizedOwnerMutationId,
    });
    if (!deleted) {
      throw new BadRequestException('变更附件不存在或已删除');
    }
    return { success: true, id };
  }

  @GuestReadable()
  @Get('duty-schedules/change-attachments/:id/download')
  async downloadChangeAttachment(
    @Param('id') id: string,
    @Query('ownerMutationId') ownerMutationId: string | undefined,
    @Req() request: DutyScheduleAccessRequest,
    @Res() response: Response,
  ): Promise<void> {
    if (!this.changeAttachmentStorage) {
      throw new ServiceUnavailableException('变更附件对象存储未配置');
    }
    let signedUrl: string;
    if (ownerMutationId?.trim()) {
      const normalizedOwnerMutationId =
        normalizeChangeAttachmentOwnerMutationId(ownerMutationId);
      signedUrl = await this.changeAttachmentStorage.getSignedDownloadUrl(
        id,
        300,
        { ownerMutationId: normalizedOwnerMutationId },
      );
    } else if (
      request.accessRole === 'admin' ||
      request.accessRole === 'editor' ||
      request.accessRole === 'duty_editor'
    ) {
      signedUrl =
        await this.changeAttachmentStorage.getSignedDownloadUrlForTrustedServer(
          id,
          300,
        );
    } else {
      throw new BadRequestException('变更附件下载缺少请求标识');
    }
    response.redirect(302, signedUrl);
  }

  @GuestReadable()
  @Get('duty-schedules/change-request-people')
  searchChangeRequestPeople(@Query('query') query?: string) {
    return this.dutyScheduleService.searchChangeRequestPeople(query || '');
  }

  @GuestSubmittable()
  @Post('duty-schedules/change-request')
  @UseInterceptors(
    changeAttachmentUploadAdmissionInterceptor,
    FilesInterceptor('documents', 5, {
      storage: diskStorage({
        destination: changeAttachmentTempDestination,
        filename: (_request, _file, callback) => callback(null, randomUUID()),
      }),
      limits: {
        files: 5,
        fileSize: CHANGE_ATTACHMENT_MAX_BYTES,
        fields: 1,
        parts: 6,
        fieldSize: 64 * 1024,
        fieldNameSize: 64,
      },
      fileFilter: changeRequestDocumentFileFilter,
    }),
  )
  async createChangeRequest(
    @Body('payload') payload: unknown,
    @Body() body: unknown,
    @UploadedFiles() files: ChangeAttachmentTempUploadFile[] = [],
    @Req() accessRequest?: DutyScheduleAccessRequest,
  ): Promise<ChangeRequestCreateResponse> {
    const stagedObjectIds: string[] = [];
    let serviceCallStarted = false;
    let ownerMutationId = '';
    try {
      let request: ChangeRequestCreateRequest;
      try {
        request = parseChangeRequestBody(payload, body);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : '变更申请 payload 无效',
        );
      }
      request.submitterName = bindSelfServiceApplicant(request.submitterName || '', accessRequest?.accessPrincipal, Boolean(accessRequest?.accessPrincipalFingerprint), '提交变更申请');
      const principal = isPersonalAccessAccount(accessRequest?.accessPrincipal) ? accessRequest?.accessPrincipal : undefined;
      if (files.length === 0) {
        serviceCallStarted = true;
        return await this.dutyScheduleService.createChangeRequest(request, [], {
          backgroundAttachments: true,
          ...(principal ? { principal } : {}),
        });
      }
      if (
        Array.isArray(request.stagedDocuments) &&
        request.stagedDocuments.length
      ) {
        throw new BadRequestException('不能同时提交文件和对象存储引用');
      }
      const validationErrors = validateChangeRequest(request, {
        documents: files,
      });
      if (validationErrors.length > 0) {
        throw new BadRequestException(validationErrors[0].message);
      }
      if (!this.changeAttachmentStorage) {
        throw new ServiceUnavailableException('变更附件对象存储未配置');
      }
      ownerMutationId = normalizeChangeAttachmentOwnerMutationId(
        request.clientMutationId,
      );
      const stagedDocuments = [];
      for (const file of files) {
        const metadata = await this.changeAttachmentStorage.stageFromDisk(
          {
            path: file.path,
            name: file.originalname,
            mimetype: file.mimetype || 'application/octet-stream',
            size: file.size,
          },
          ownerMutationId,
        );
        stagedObjectIds.push(metadata.id);
        stagedDocuments.push({
          name: metadata.name,
          originalname: metadata.name,
          type: metadata.mimeType,
          mimetype: metadata.mimeType,
          size: metadata.size,
          objectStorage: {
            id: metadata.id,
            filePath: metadata.filePath,
            bucketId: metadata.bucketId,
            url: metadata.url,
          },
        });
      }
      serviceCallStarted = true;
      return await this.dutyScheduleService.createChangeRequest(
        { ...request, stagedDocuments },
        [],
        { backgroundAttachments: true, ...(principal ? { principal } : {}) },
      );
    } catch (error) {
      if (
        !serviceCallStarted &&
        ownerMutationId &&
        this.changeAttachmentStorage
      ) {
        await Promise.allSettled(
          stagedObjectIds.map((id) =>
            this.changeAttachmentStorage!.delete(id, { ownerMutationId }),
          ),
        );
      }
      throw error;
    } finally {
      await Promise.all(
        files.map((file) => removeExactChangeAttachmentTempFile(file.path)),
      );
    }
  }

  @GuestReadable()
  @Get('duty-schedules/change-request-sync/:taskId')
  getChangeRequestSyncTask(@Param('taskId') taskId: string) {
    if (
      !/^change-request-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        taskId,
      )
    ) {
      throw new BadRequestException('变更申请后台任务标识无效');
    }
    const task = this.dutyScheduleService.getSyncTask(taskId);
    if (!task) {
      return { success: false, message: '变更申请后台任务不存在' };
    }
    return {
      success: true,
      task: {
        id: task.id,
        status: task.status,
        startTime: task.startTime,
        endTime: task.endTime,
        message: task.message,
        total: task.total,
        inserted: task.inserted,
        failed: task.failed,
        result: task.result,
      },
    };
  }

  @Post('duty-schedules/change-adjustment')
  async createChangeAdjustment(
    @Body() request: ChangeAdjustmentRequest,
    @Req() accessRequest: DutyScheduleAccessRequest,
  ): Promise<ChangeAdjustmentResponse> {
    if (
      accessRequest.accessRole !== 'admin' &&
      accessRequest.accessRole !== 'editor' &&
      accessRequest.accessRole !== 'duty_editor'
    ) {
      throw new ForbiddenException('当前身份无权提交变更调整');
    }
    return this.dutyScheduleService.createChangeAdjustment(request);
  }

  @Post('duty-schedules/change-drill-report')
  async createChangeDrillReport(
    @Body() request: ChangeDrillReportCreateRequest,
    @Req() accessRequest: DutyScheduleAccessRequest,
  ): Promise<ChangeDrillReportCreateResponse> {
    if (
      !accessRequest.accessRole ||
      !canSubmitChangeDrillReportForRole(accessRequest.accessRole)
    ) {
      throw new ForbiddenException('当前身份无权提交演练报告');
    }
    return this.dutyScheduleService.createChangeDrillReport(request);
  }

  @Post('duty-schedules/change-summary-report')
  async createChangeSummaryReport(
    @Body() request: ChangeSummaryReportCreateRequest,
    @Req() accessRequest: DutyScheduleAccessRequest,
  ): Promise<ChangeSummaryReportCreateResponse> {
    if (
      !accessRequest.accessRole ||
      !canSubmitChangeSummaryReportForRole(accessRequest.accessRole)
    ) {
      throw new ForbiddenException('当前身份无权提交变更总结');
    }
    return this.dutyScheduleService.createChangeSummaryReport(
      { ...request, submitterName: bindSelfServiceApplicant(request.submitterName || '', accessRequest.accessPrincipal, Boolean(accessRequest.accessPrincipalFingerprint), '提交变更总结') },
      requireAccessPrincipalFingerprint(accessRequest),
      accessRequest.accessPrincipal,
    );
  }

  @Post('duty-schedules/change-summary-report/abandon')
  async abandonChangeSummaryReport(
    @Body() request: ChangeSummaryReportAbandonRequest,
    @Req() accessRequest: DutyScheduleAccessRequest,
  ): Promise<ChangeSummaryReportAbandonResponse> {
    if (
      !accessRequest.accessRole ||
      !canSubmitChangeSummaryReportForRole(accessRequest.accessRole)
    ) {
      throw new ForbiddenException('当前身份无权放弃变更总结');
    }
    return this.dutyScheduleService.abandonChangeSummaryReport(
      { ...request, submitterName: bindSelfServiceApplicant(request.submitterName || '', accessRequest.accessPrincipal, Boolean(accessRequest.accessPrincipalFingerprint), '处理变更总结') },
      requireAccessPrincipalFingerprint(accessRequest),
    );
  }

  @Get('duty-schedules/change-summary-report-sync/:taskId')
  async getChangeSummaryReportSyncStatus(
    @Param('taskId') taskId: string,
    @Req() accessRequest: DutyScheduleAccessRequest,
  ): Promise<ChangeSummaryReportSyncTaskResponse> {
    if (
      !accessRequest.accessRole ||
      !canSubmitChangeSummaryReportForRole(accessRequest.accessRole)
    ) {
      throw new ForbiddenException('当前身份无权查看变更总结同步状态');
    }
    return this.dutyScheduleService.getChangeSummaryReportSyncStatus(
      taskId,
      requireAccessPrincipalFingerprint(accessRequest),
    );
  }

  @AdminOnly()
  @Get('duty-schedules/change-attachments/:id/self-test-deletion-state')
  async getTrustedChangeAttachmentDeletionState(
    @Param('id') id: string,
    @Req() accessRequest: DutyScheduleAccessRequest,
  ): Promise<{
    success: true;
    objectId: string;
    state: 'present' | 'cleanup-pending' | 'absent';
  }> {
    if (
      accessRequest.accessRole !== 'admin' ||
      !isDirectLoopbackRequest(accessRequest)
    ) {
      throw new ForbiddenException('仅允许本机受信自测查询附件清理状态');
    }
    if (!this.changeAttachmentStorage) {
      throw new ServiceUnavailableException('变更附件对象存储未配置');
    }
    const objectId = String(id || '').trim();
    const state =
      await this.changeAttachmentStorage.getDeletionStateForTrustedServer(
        objectId,
      );
    return { success: true, objectId, state };
  }

  @AdminOnly()
  @Post(
    'duty-schedules/change-summary-report/self-test/cleanup-bound-attachment',
  )
  async cleanupChangeSummarySelfTestBoundAttachment(
    @Body() request: ChangeSummaryReportSelfTestCleanupRequest,
    @Req() accessRequest: DutyScheduleAccessRequest,
  ): Promise<ChangeSummaryReportSelfTestCleanupResponse> {
    if (
      accessRequest.accessRole !== 'admin' ||
      !isDirectLoopbackRequest(accessRequest)
    ) {
      throw new ForbiddenException('仅允许本机受信自测清理变更总结附件');
    }
    const header =
      accessRequest.headers['x-change-summary-self-test-cleanup-proof'];
    if (typeof header !== 'string') {
      throw new ForbiddenException('变更总结自测清理签名无效');
    }
    return this.dutyScheduleService.cleanupChangeSummarySelfTestBoundAttachment(
      request,
      header,
    );
  }

  @AdminOnly()
  @Post(
    'duty-schedules/change-summary-report/self-test/finalize-failed-cleanup',
  )
  async finalizeFailedChangeSummarySelfTestCleanup(
    @Body() request: FailedChangeSummarySelfTestCleanupRequest,
    @Req() accessRequest: DutyScheduleAccessRequest,
  ): Promise<{
    success: true;
    alreadyFinalized: boolean;
    changeRequestAlreadyScrubbed: boolean;
  }> {
    if (
      accessRequest.accessRole !== 'admin' ||
      !isDirectLoopbackRequest(accessRequest)
    ) {
      throw new ForbiddenException('仅允许本机受信自测收口变更总结失败台账');
    }
    const header =
      accessRequest.headers['x-change-summary-failed-self-test-cleanup-proof'];
    if (typeof header !== 'string') {
      throw new ForbiddenException('变更总结失败自测清理签名无效');
    }
    return this.dutyScheduleService.finalizeFailedChangeSummarySelfTestCleanup(
      request,
      header,
    );
  }

  @AdminOnly()
  @Post('duty-schedules/change-adjustment/self-test/cleanup-bound-attachment')
  async cleanupChangeSelfTestBoundAttachment(
    @Body() request: ChangeSelfTestBoundAttachmentCleanupRequest,
    @Req() accessRequest: DutyScheduleAccessRequest,
  ): Promise<ChangeSelfTestBoundAttachmentCleanupResponse> {
    if (
      accessRequest.accessRole !== 'admin' ||
      !isDirectLoopbackRequest(accessRequest)
    ) {
      throw new ForbiddenException('仅允许本机受信自测清理');
    }
    const header = accessRequest.headers['x-change-self-test-cleanup-proof'];
    if (typeof header !== 'string') {
      throw new ForbiddenException('变更自测清理签名无效');
    }
    return this.dutyScheduleService.cleanupChangeSelfTestBoundAttachment(
      request,
      header,
    );
  }

  @Get('duty-schedules/change-records/:recordId/attachments/:fileToken')
  async downloadChangeRecordAttachment(
    @Param('recordId') recordId: string,
    @Param('fileToken') fileToken: string,
    @Req() accessRequest: DutyScheduleAccessRequest,
    @Res() response: Response,
  ): Promise<void> {
    if (
      accessRequest.accessRole !== 'admin' &&
      accessRequest.accessRole !== 'editor' &&
      accessRequest.accessRole !== 'duty_editor'
    ) {
      throw new ForbiddenException('当前身份无权访问变更附件');
    }
    const result = await this.dutyScheduleService.resolveChangeRecordAttachment(
      recordId,
      fileToken,
    );
    if (result.kind === 'redirect') {
      response.redirect(302, result.url);
      return;
    }
    const safeFileName =
      String(result.name || '变更附件')
        .replace(/[\r\n"]/g, '')
        .trim() || '变更附件';
    response.setHeader('Content-Type', result.contentType);
    response.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(safeFileName)}`,
    );
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.send(result.buffer);
  }

  @GuestReadable()
  @ProfessionalScoped()
  @Get('duty-schedules/construction-management')
  async getConstructionManagement(
    @Query('refresh') refresh?: string,
    @Query('compact') compact?: string,
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<ConstructionManagementTransportResponse> {
    const response = await this.dutyScheduleService.getConstructionManagement(
      refresh === '1' || refresh === 'true',
      request?.accessPrincipal,
    );
    return compact === '1' || compact === 'true'
      ? compactConstructionManagementResponse(response)
      : response;
  }

  @ProfessionalScoped()
  @Get('duty-schedules/construction-management/onsite-followers')
  async getConstructionOnsiteFollowers(
    @Query('query') query?: string,
    @Query('refresh') refresh?: string,
  ): Promise<ConstructionStaffCandidatesResponse> {
    return this.dutyScheduleService.getConstructionOnsiteFollowers(
      query || '',
      refresh === '1' || refresh === 'true',
    );
  }

  @ProfessionalScoped()
  @Get('duty-schedules/construction-management/change-orders')
  async getConstructionChangeOrders(
    @Query('query') query?: string,
    @Query('refresh') refresh?: string,
  ): Promise<ConstructionChangeOrderCandidatesResponse> {
    return this.dutyScheduleService.getConstructionChangeOrders(
      query || '',
      refresh === '1' || refresh === 'true',
    );
  }

  @GuestReadable()
  @ProfessionalScoped()
  @Get('duty-schedules/construction-management/attachments/:fileToken')
  async downloadConstructionAttachment(
    @Param('fileToken') fileToken: string,
    @Query('filename') filename: string | undefined,
    @Query('tmpUrl') tmpUrl: string | undefined,
    @Res() res: Response,
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<void> {
    await this.dutyScheduleService.authorizeProfessionalConstructionAttachment(request?.accessPrincipal, fileToken);
    try {
      const file =
        await this.dutyScheduleService.downloadConstructionAttachment(
          fileToken,
          { tmpUrl },
        );
      const safeFileName =
        String(filename || '施工附件')
          .replace(/[\r\n"]/g, '')
          .trim() || '施工附件';
      res.setHeader('Content-Type', file.contentType);
      res.setHeader(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(safeFileName)}`,
      );
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(file.buffer);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @ProfessionalScoped()
  @Post('duty-schedules/construction-management/applications')
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: {
        files: 24,
        fileSize: 30 * 1024 * 1024,
      },
    }),
  )
  async createConstructionApplication(
    @Body() body: ConstructionApplicationCreateRequest,
    @UploadedFiles() files: ConstructionUploadFile[] = [],
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<ConstructionApplicationCreateResponse> {
    assertProfessionalRecordScope(request?.accessPrincipal, body.specialty);
    try {
      const result = await this.dutyScheduleService.createConstructionApplication(
        body,
        files,
      );
      this.dutyScheduleService.bindProfessionalConstructionTasks(request?.accessPrincipal, result);
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @ProfessionalScoped()
  @Post('duty-schedules/construction-management/followups')
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: {
        files: 24,
        fileSize: 30 * 1024 * 1024,
      },
    }),
  )
  async createConstructionFollowup(
    @Body() body: ConstructionFollowupCreateRequest,
    @Req() request: DutyScheduleAccessRequest,
    @UploadedFiles() files: ConstructionUploadFile[] = [],
  ): Promise<ConstructionFollowupCreateResponse> {
    try {
      const result = await this.dutyScheduleService.createConstructionFollowup(
        body,
        files,
        request.accessRole ?? 'guest',
        undefined,
        request.accessPrincipal,
      );
      this.dutyScheduleService.bindProfessionalConstructionTasks(request?.accessPrincipal, result);
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @AdminOnly()
  @ProfessionalScoped()
  @Post('duty-schedules/construction-management/attachments/delete')
  async deleteConstructionAttachment(
    @Body() body: ConstructionAttachmentDeleteRequest,
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<ConstructionAttachmentDeleteResponse> {
    await this.dutyScheduleService.authorizeProfessionalConstruction(request?.accessPrincipal, body.recordId, body.source === 'overview' ? 'overview' : 'followup');
    try {
      const result = await this.dutyScheduleService.deleteConstructionAttachment(body);
      this.dutyScheduleService.bindProfessionalConstructionTasks(request?.accessPrincipal, result);
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @ProfessionalScoped()
  @Post('duty-schedules/construction-management/permit-manual-review')
  async requestConstructionPermitManualReview(
    @Body() body: ConstructionPermitManualReviewRequest,
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<ConstructionPermitManualReviewResponse> {
    await this.dutyScheduleService.authorizeProfessionalConstruction(request?.accessPrincipal, body.followupRecordId, 'followup');
    try {
      const result = await this.dutyScheduleService.requestConstructionPermitManualReview(
        body || { followupRecordId: '', fileKey: '' },
      );
      this.dutyScheduleService.bindProfessionalConstructionTasks(request?.accessPrincipal, result);
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @ProfessionalScoped()
  @Post('duty-schedules/construction-management/permit-manual-review/result')
  async updateConstructionPermitManualReview(
    @Body() body: ConstructionPermitManualReviewUpdateRequest,
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<ConstructionPermitManualReviewUpdateResponse> {
    await this.dutyScheduleService.authorizeProfessionalConstruction(request?.accessPrincipal, body.followupRecordId, 'followup');
    try {
      const result = await this.dutyScheduleService.updateConstructionPermitManualReview(
        body || { followupRecordId: '', fileKey: '', decision: 'passed' },
      );
      this.dutyScheduleService.bindProfessionalConstructionTasks(request?.accessPrincipal, result);
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @ProfessionalScoped()
  @Post(
    'duty-schedules/construction-management/isolation-photo-manual-review/result',
  )
  async updateConstructionIsolationPhotoManualReview(
    @Body() body: ConstructionIsolationPhotoManualReviewUpdateRequest,
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<ConstructionIsolationPhotoManualReviewUpdateResponse> {
    await this.dutyScheduleService.authorizeProfessionalConstruction(request?.accessPrincipal, body.followupRecordId, 'followup');
    try {
      const result = await this.dutyScheduleService.updateConstructionIsolationPhotoManualReview(
        body || { followupRecordId: '', decision: 'passed' },
      );
      this.dutyScheduleService.bindProfessionalConstructionTasks(request?.accessPrincipal, result);
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @AdminOnly()
  @ProfessionalScoped()
  @Post('duty-schedules/construction-management/projects/delete')
  async deleteConstructionProject(
    @Body() body: ConstructionProjectDeleteRequest,
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<ConstructionProjectDeleteResponse> {
    await this.dutyScheduleService.authorizeProfessionalConstruction(request?.accessPrincipal, body.recordId);
    try {
      const result = await this.dutyScheduleService.deleteConstructionProject(body, request?.accessPrincipal);
      this.dutyScheduleService.bindProfessionalConstructionTasks(request?.accessPrincipal, result);
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @ProfessionalScoped()
  @Post('duty-schedules/construction-management/projects/terminate')
  async terminateConstructionProject(
    @Body() body: ConstructionProjectTerminateRequest,
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<ConstructionProjectTerminateResponse> {
    await this.dutyScheduleService.authorizeProfessionalConstruction(request?.accessPrincipal, body.recordId);
    try {
      const result = await this.dutyScheduleService.terminateConstructionProject(body);
      this.dutyScheduleService.bindProfessionalConstructionTasks(request?.accessPrincipal, result);
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @ProfessionalScoped()
  @Post(
    'duty-schedules/construction-management/projects/crew-roster/outlook-sync',
  )
  async syncConstructionCrewRosterFromOutlook(
    @Body() body: ConstructionCrewRosterOutlookSyncRequest,
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<ConstructionCrewRosterOutlookSyncResponse> {
    await this.dutyScheduleService.authorizeProfessionalConstruction(request?.accessPrincipal, body.recordId);
    try {
      const result = await this.dutyScheduleService.syncConstructionCrewRosterFromOutlook(
        body,
      );
      this.dutyScheduleService.bindProfessionalConstructionTasks(request?.accessPrincipal, result);
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @ProfessionalScoped()
  @Post(
    'duty-schedules/construction-management/projects/crew-roster/upload-sync',
  )
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: {
        files: 8,
        fileSize: 30 * 1024 * 1024,
      },
    }),
  )
  async syncConstructionCrewRosterFromUpload(
    @Body() body: ConstructionCrewRosterUploadSyncRequest,
    @UploadedFiles() files: ConstructionUploadFile[] = [],
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<ConstructionCrewRosterUploadSyncResponse> {
    await this.dutyScheduleService.authorizeProfessionalConstruction(request?.accessPrincipal, body.recordId);
    try {
      const result = await this.dutyScheduleService.syncConstructionCrewRosterFromUpload(
        body,
        files,
      );
      this.dutyScheduleService.bindProfessionalConstructionTasks(request?.accessPrincipal, result);
      return result;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @Post('duty-schedules/exception-follow-up')
  async createExceptionFollowUp(
    @Body() body: ExceptionFollowUpCreateRequest,
  ): Promise<ExceptionFollowUpCreateResponse> {
    try {
      return await this.dutyScheduleService.createExceptionFollowUp(body);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @GuestReadable()
  @Get('duty-schedules/exception-follow-ups')
  async getExceptionFollowUps(
    @Query('date') date?: string,
    @Query('refresh') refresh?: string,
    @Query('endDate') endDate?: string,
  ): Promise<ExceptionFollowUpListResponse> {
    if (endDate === undefined) {
      return this.dutyScheduleService.getExceptionFollowUps(
        date,
        refresh === '1' || refresh === 'true',
      );
    }
    return this.dutyScheduleService.getExceptionFollowUps(
      date,
      refresh === '1' || refresh === 'true',
      endDate,
    );
  }

  @Post('duty-schedules/exception-follow-up/update')
  async updateExceptionFollowUp(
    @Body() body: ExceptionFollowUpUpdateRequest,
  ): Promise<ExceptionFollowUpUpdateResponse> {
    try {
      return await this.dutyScheduleService.updateExceptionFollowUp(body);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @AdminOnly()
  @Post('duty-schedules/exception-follow-up/delete')
  async deleteExceptionFollowUp(
    @Body() body: ExceptionFollowUpDeleteRequest,
  ): Promise<ExceptionFollowUpDeleteResponse> {
    try {
      return await this.dutyScheduleService.deleteExceptionFollowUp(body);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @Post('sync-from-feishu')
  async syncFromFeishuBase() {
    const result = this.dutyScheduleService.startSyncFromFeishuBase();
    return {
      success: true,
      taskId: result.taskId,
      status: result.status,
      message:
        result.status === 'running' ? '同步任务正在执行中' : '同步任务已启动',
    };
  }

  @Post('sync-all-from-feishu')
  async syncAllFromFeishu() {
    return this.dutyScheduleAutomationService.syncAllLocalTables('manual');
  }

  @Post('duty-schedules/sync-local-fast')
  async syncDutyScheduleToLocalFast() {
    return this.dutyScheduleService.syncDutyScheduleToLocalFast();
  }

  @Post('duty-overview-screenshot/send')
  async sendDutyOverviewScreenshot(
    @Body() body?: { date?: string },
  ): Promise<DutyOverviewScreenshotResponse> {
    return this.dutyScreenshotService.captureAndSendDutyOverview({
      source: 'manual',
      date: body?.date,
    });
  }

  @Post('typhoon-path-screenshot/send-test')
  async sendTyphoonPathTestScreenshot(
    @Body()
    body?: {
      receiveId?: string;
      receiveIdType?: 'open_id' | 'user_id' | 'email';
    },
  ): Promise<TyphoonPathScreenshotResponse> {
    const configuredReceiveId = readEnv('FEISHU_TYPHOON_PATH_TEST_OPEN_ID', [
      'TYPHOON_PATH_TEST_OPEN_ID',
    ]);
    const receiveId = body?.receiveId?.trim() || configuredReceiveId;
    if (!receiveId) {
      throw new BadRequestException('测试台风路径截图需要指定个人接收 ID');
    }

    return this.dutyScreenshotService.captureAndSendTyphoonPath({
      source: 'manual-test',
      receiveId,
      receiveIdType: body?.receiveIdType || 'open_id',
    });
  }

  @Post('typhoon-path-screenshot/send-group')
  async sendTyphoonPathGroupScreenshot(
    @Body() body: TyphoonPathGroupScreenshotRequest,
    @Req() request: DutyScheduleAccessRequest,
  ): Promise<TyphoonPathGroupScreenshotResponse> {
    const clientMutationId = `${body?.clientMutationId || ''}`.trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientMutationId)) {
      throw new BadRequestException('缺少有效的操作幂等标识');
    }

    const force = body?.force === true;
    this.logger.log(
      JSON.stringify({
        event: 'typhoon-path-group-send-request',
        source: force ? 'manual-group' : 'manual-warning-check',
        force,
        accessRole: request.accessRole ?? 'guest',
        requestIp: request.ip || request.socket?.remoteAddress || '',
        clientMutationId,
        expectedWarningKey: body?.expectedWarningKey || '',
      }),
    );

    if (force) {
      if (request.accessRole !== 'admin') {
        throw new ForbiddenException('仅管理员可以在无有效台风预警时强制发送');
      }
      if (body.confirmation !== 'FORCE_SEND_TYPHOON_PATH') {
        throw new BadRequestException('请明确确认强制发送台风路径图');
      }
      return this.dutyScheduleAutomationService.forceSendTyphoonPathScreenshot({
        clientMutationId,
      });
    }

    const result =
      await this.dutyScheduleAutomationService.monitorTyphoonWarningAndSendPathScreenshot(
        {
          source: 'manual',
          expectedWarningKey: body?.expectedWarningKey?.trim() || undefined,
        },
      );
    return {
      ...result,
      source: 'manual',
      forced: false,
    };
  }

  @Get('typhoon-path-screenshot/preview')
  async previewTyphoonPathScreenshot(): Promise<TyphoonPathScreenshotPreviewResponse> {
    return this.dutyScheduleAutomationService.previewTyphoonWarningPathScreenshot();
  }

  @ProfessionalScoped()
  @Get('sync-task/:taskId')
  async getSyncTask(@Param('taskId') taskId: string, @Req() request?: DutyScheduleAccessRequest) {
    this.dutyScheduleService.authorizeProfessionalConstructionTask(request?.accessPrincipal, taskId);
    const task = this.dutyScheduleService.getSyncTask(taskId);
    if (!task) {
      return {
        success: false,
        message: '任务不存在',
      };
    }
    return {
      success: true,
      task: {
        id: task.id,
        status: task.status,
        startTime: task.startTime,
        endTime: task.endTime,
        message: task.message,
        total: task.total,
        inserted: task.inserted,
        failed: task.failed,
        result: task.result,
      },
    };
  }

  @Get('last-sync-time')
  async getLastSyncTime() {
    const lastSyncTime = await this.dutyScheduleService.getLastSyncTime();
    return { lastSyncTime };
  }

  @GuestReadable()
  @Get('sealing-info/:year')
  async getYearlySealingInfo(
    @Param('year') year: string,
    @Query('refresh') refresh?: string,
  ): Promise<YearlySealingInfoResponse> {
    return this.dutyScheduleService.getYearlySealingInfo(
      parseInt(year, 10),
      refresh === '1' || refresh === 'true',
    );
  }

  @GuestReadable()
  @Get('change-info/:year')
  async getYearlyChangeInfo(
    @Param('year') year: string,
    @Query('refresh') refresh?: string,
    @Req() request?: DutyScheduleAccessRequest,
  ): Promise<YearlyChangeInfoResponse> {
    const result = await this.dutyScheduleService.getYearlyChangeInfo(
      parseInt(year, 10),
      refresh === '1' || refresh === 'true',
    );
    if ((request?.accessRole ?? 'guest') !== 'guest') {
      return result;
    }
    return {
      ...result,
      changes: result.changes.map((change) => ({
        ...change,
        submitterName: null,
        planDocuments: [],
        delayReason: null,
        delayEvidence: [],
        workflowStatus: null,
      })),
    };
  }

  @Post('change-info/adjustment')
  async updateChangeScheduleAdjustment(
    @Body() body: ChangeScheduleAdjustmentRequest,
    @Req() request: DutyScheduleAccessRequest,
  ): Promise<ChangeScheduleAdjustmentResponse> {
    const accessRole = request.accessRole ?? 'guest';
    if (
      hasOwnRuntimeProperty(body, 'clearAdjustment') &&
      typeof body.clearAdjustment !== 'boolean'
    ) {
      throw new BadRequestException('clearAdjustment 必须为布尔值');
    }
    const clearAdjustment = body?.clearAdjustment === true;
    if (clearAdjustment === true && accessRole !== 'admin') {
      throw new ForbiddenException('仅管理员可以撤销变更计划调整');
    }
    try {
      return await this.dutyScheduleService.updateChangeScheduleAdjustment(
        body || { recordId: '' },
        accessRole,
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @GuestReadable()
  @Get('today-focus-checklist')
  async getTodayFocusChecklist(
    @Query('date') date?: string,
    @Query('refresh') refresh?: string,
  ): Promise<TodayFocusChecklistResponse> {
    return this.dutyScheduleService.getTodayFocusChecklist(
      date,
      refresh === '1' || refresh === 'true',
    );
  }
}
