import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { isPersonalAccessAccount } from '../../../shared/self-service-applicant';
import type {
  AccessPrincipal,
  AccessRole,
} from '../../../shared/access-control.interface';
import type {
  SystemMonthlyReportModuleKey,
  SystemMonthlyReportIdentitySessionResponse,
  SystemMonthlyReportPackageRequest,
  SystemMonthlyReportReviewRequest,
  SystemMonthlyReportSubmissionDeletionRequest,
  SystemMonthlyReportSubmissionRequest,
} from '../../../shared/system-monthly-report.interface';
import { SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES } from '../../../shared/system-monthly-report.interface';
import {
  GuestReadable,
  GuestSubmittable,
} from '../../common/access/unified-access.decorators';
import {
  buildSystemMonthlyReportScope,
  projectSystemMonthlyReportDashboard,
  type SystemMonthlyReportAccessSubject,
} from './system-monthly-report-access';
import { SystemMonthlyReportIdentityService } from './system-monthly-report-identity.service';
import {
  SystemMonthlyReportService,
  type SystemMonthlyReportReviewUpload,
  type SystemMonthlyReportUploadFile,
} from './system-monthly-report.service';

type AccessRequest = Request & {
  accessPrincipal?: AccessPrincipal;
  accessPrincipalFingerprint?: string;
  accessRole?: AccessRole;
};

type UploadedMemoryFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

const PRIVILEGED_ROLES = new Set<AccessRole>(['admin', 'editor', 'professional_admin']);
const IDENTITY_COOKIE_NAME = 'vnet_system_monthly_report_identity';
const IDENTITY_COOKIE_PATH = '/api/system-monthly-report';

@GuestReadable()
@Controller('api/system-monthly-report')
export class SystemMonthlyReportController {
  constructor(
    private readonly service: SystemMonthlyReportService,
    private readonly identity: SystemMonthlyReportIdentityService,
  ) {}

  @Get('identity-directory')
  async getIdentityDirectory() {
    const dashboard = await this.service.getDashboard(false, false);
    return this.identity.list(dashboard);
  }

  @Get('identity-session')
  async getIdentitySession(
    @Req() request: AccessRequest,
  ): Promise<SystemMonthlyReportIdentitySessionResponse> {
    const dashboard = await this.service.getDashboard(false, false);
    const subject = await resolveOptionalSubject(request, dashboard, this.identity);
    if (!subject) {
      return { selected: false, mode: 'none', person: null, expiresAt: null };
    }
    if (subject.kind === 'privileged') {
      return {
        selected: true,
        mode: 'privileged',
        person: null,
        expiresAt: null,
      };
    }
    return {
      selected: true,
      mode: 'person',
      person: { id: subject.person.id, name: subject.person.name },
      expiresAt: null,
    };
  }

  @GuestSubmittable()
  @Post('identity-session')
  @HttpCode(HttpStatus.OK)
  async selectIdentity(
    @Req() request: AccessRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() body: Record<string, unknown>,
  ): Promise<SystemMonthlyReportIdentitySessionResponse> {
    const dashboard = await this.service.getDashboard(false, false);
    let personId = clean(body.personId);
    if (isPersonalAccessAccount(request.accessPrincipal)) {
      const subject = await this.identity.resolvePrincipal(request.accessPrincipal!, dashboard, identityToken(request));
      if (personId && personId !== subject.person.id) throw new ForbiddenException('月报人员必须为当前登录本人');
      personId = subject.person.id;
    }
    const issued = this.identity.select(personId, dashboard);
    response.cookie(IDENTITY_COOKIE_NAME, issued.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: IDENTITY_COOKIE_PATH,
      secure: process.env.NODE_ENV === 'production',
      expires: new Date(issued.expiresAt),
      maxAge: Math.max(0, issued.expiresAt - Date.now()),
    });
    return {
      selected: true,
      mode: 'person',
      person: issued.person,
      expiresAt: issued.expiresAt,
    };
  }

  @GuestSubmittable()
  @Post('identity-session/logout')
  @HttpCode(HttpStatus.OK)
  logoutIdentity(
    @Req() request: AccessRequest,
    @Res({ passthrough: true }) response: Response,
  ): SystemMonthlyReportIdentitySessionResponse {
    const token = identityToken(request);
    if (token) this.identity.revoke(token);
    response.clearCookie(IDENTITY_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      path: IDENTITY_COOKIE_PATH,
      secure: process.env.NODE_ENV === 'production',
    });
    return { selected: false, mode: 'none', person: null, expiresAt: null };
  }

  @Get('dashboard')
  async getDashboard(
    @Req() request: AccessRequest,
    @Query('refresh') refresh?: string,
  ) {
    const privileged = isPrivilegedRequest(request);
    const forceRefresh = privileged && (refresh === '1' || refresh === 'true');
    const dashboard = await this.service.getDashboard(forceRefresh, false);
    const subject = await resolveSubject(request, dashboard, this.identity);
    return projectSystemMonthlyReportDashboard(
      dashboard,
      buildSystemMonthlyReportScope(subject, dashboard),
    );
  }

  @GuestSubmittable()
  @Post('submissions')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        files: 1,
        fileSize: SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES,
      },
    }),
  )
  async submitStage(
    @Req() accessRequest: AccessRequest,
    @Body('payload') payload: string,
    @UploadedFile() file?: UploadedMemoryFile,
  ) {
    if (!file) throw new BadRequestException('请选择月报附件');
    const dashboard = await this.service.getDashboard(false, false);
    const subject = await resolveSubject(accessRequest, dashboard, this.identity);
    return this.service.acceptSubmission(
      parseSubmission(payload),
      asUploadFile(file),
      subject,
    );
  }

  @GuestSubmittable()
  @Post('submissions/delete')
  @HttpCode(HttpStatus.ACCEPTED)
  async deleteStage(
    @Req() accessRequest: AccessRequest,
    @Body() body: Record<string, unknown>,
  ) {
    const dashboard = await this.service.getDashboard(false, false);
    const subject = await resolveSubject(accessRequest, dashboard, this.identity);
    return this.service.acceptSubmissionDeletion(
      parseSubmissionDeletion(body),
      subject,
    );
  }

  @GuestSubmittable()
  @Post('reviews')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'eventScreenshot', maxCount: 1 },
        { name: 'changeScreenshot', maxCount: 1 },
        { name: 'maintenanceScreenshot', maxCount: 1 },
        { name: 'drillScreenshot', maxCount: 1 },
        { name: 'otherScreenshot', maxCount: 1 },
      ],
      { limits: { files: 5, fileSize: 10 * 1024 * 1024 } },
    ),
  )
  async submitReview(
    @Req() accessRequest: AccessRequest,
    @Body('payload') payload: string,
    @UploadedFiles() files: Record<string, UploadedMemoryFile[]> = {},
  ) {
    const dashboard = await this.service.getDashboard(false, false);
    const subject = await resolveSubject(accessRequest, dashboard, this.identity);
    return this.service.acceptReview(
      parseReview(payload),
      reviewUploads(files),
      subject,
    );
  }

  @Get('tasks/:taskId')
  async getTask(
    @Req() accessRequest: AccessRequest,
    @Param('taskId') taskId: string,
  ) {
    const dashboard = await this.service.getDashboard(false, false);
    const subject = await resolveSubject(accessRequest, dashboard, this.identity);
    return this.service.getTask(taskId, subject);
  }

  @GuestSubmittable()
  @Post('tasks/:taskId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retryTask(
    @Req() accessRequest: AccessRequest,
    @Param('taskId') taskId: string,
  ) {
    const dashboard = await this.service.getDashboard(false, false);
    const subject = await resolveSubject(accessRequest, dashboard, this.identity);
    return this.service.retryTask(taskId, subject);
  }

  @Get('archives/:archiveId/download-url')
  async getArchiveDownload(
    @Req() accessRequest: AccessRequest,
    @Param('archiveId') archiveId: string,
  ) {
    const dashboard = await this.service.getDashboard(false, false);
    const subject = await resolveSubject(accessRequest, dashboard, this.identity);
    return this.service.getArchiveDownload(archiveId, subject, dashboard);
  }

  @Get('archives/:archiveId/preview')
  async getArchivePreview(
    @Req() accessRequest: AccessRequest,
    @Param('archiveId') archiveId: string,
  ) {
    const dashboard = await this.service.getDashboard(false, false);
    const subject = await resolveSubject(accessRequest, dashboard, this.identity);
    return this.service.getArchivePreview(archiveId, subject, dashboard);
  }

  @Post('archives/:archiveId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retryArchive(
    @Req() accessRequest: AccessRequest,
    @Param('archiveId') archiveId: string,
  ) {
    const privilegedSubject = requirePrivilegedSubject(accessRequest);
    return this.service.retryArchive(archiveId, privilegedSubject);
  }

  @Post('packages')
  @HttpCode(HttpStatus.ACCEPTED)
  createPackage(
    @Req() accessRequest: AccessRequest,
    @Body() body: Record<string, unknown>,
  ) {
    const privilegedSubject = requirePrivilegedSubject(accessRequest);
    return this.service.acceptPackage(parsePackage(body), privilegedSubject);
  }

  @Get('packages/:taskId')
  getPackageTask(
    @Req() accessRequest: AccessRequest,
    @Param('taskId') taskId: string,
  ) {
    const privilegedSubject = requirePrivilegedSubject(accessRequest);
    return this.service.getPackageTask(taskId, privilegedSubject);
  }

  @Get('packages/:taskId/download-url')
  getPackageDownload(
    @Req() accessRequest: AccessRequest,
    @Param('taskId') taskId: string,
  ) {
    const privilegedSubject = requirePrivilegedSubject(accessRequest);
    return this.service.getPackageDownload(taskId, privilegedSubject);
  }

  @Post('packages/:taskId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retryPackage(
    @Req() accessRequest: AccessRequest,
    @Param('taskId') taskId: string,
  ) {
    const privilegedSubject = requirePrivilegedSubject(accessRequest);
    return this.service.retryPackage(taskId, privilegedSubject);
  }
}

function parsePackage(
  value: Record<string, unknown>,
): SystemMonthlyReportPackageRequest {
  return {
    clientMutationId: clean(value.clientMutationId),
    year: Number(value.year),
    month: Number(value.month),
  };
}

function parseSubmission(value: string): SystemMonthlyReportSubmissionRequest {
  const payload = parseObject(value);
  if (!['initial', 'recheck', 'final'].includes(String(payload.stage))) {
    throw new BadRequestException('月报提交阶段无效');
  }
  if (
    payload.operation !== undefined &&
    !['create', 'replace'].includes(String(payload.operation))
  ) {
    throw new BadRequestException('月报提交操作无效');
  }
  return {
    clientMutationId: clean(payload.clientMutationId),
    currentRecordId: clean(payload.currentRecordId),
    room: clean(payload.room),
    stage: payload.stage as SystemMonthlyReportSubmissionRequest['stage'],
    reportYear: Number(payload.reportYear),
    reportMonth: Number(payload.reportMonth),
    versionedFileName: clean(payload.versionedFileName),
    operation: payload.operation === 'replace' ? 'replace' : 'create',
  };
}

function parseSubmissionDeletion(
  payload: Record<string, unknown>,
): SystemMonthlyReportSubmissionDeletionRequest {
  if (!['initial', 'recheck', 'final'].includes(String(payload.stage))) {
    throw new BadRequestException('月报删除阶段无效');
  }
  return {
    clientMutationId: clean(payload.clientMutationId),
    currentRecordId: clean(payload.currentRecordId),
    room: clean(payload.room),
    stage:
      payload.stage as SystemMonthlyReportSubmissionDeletionRequest['stage'],
    reportYear: Number(payload.reportYear),
    reportMonth: Number(payload.reportMonth),
  };
}

function parseReview(value: string): SystemMonthlyReportReviewRequest {
  const payload = parseObject(value);
  if (!['initial', 'recheck'].includes(String(payload.round))) {
    throw new BadRequestException('审核轮次无效');
  }
  const rawModules = isRecord(payload.modules) ? payload.modules : {};
  const moduleKeys: SystemMonthlyReportModuleKey[] = [
    'event',
    'change',
    'maintenance',
    'drill',
    'other',
  ];
  const modules = Object.fromEntries(
    moduleKeys.map((key) => {
      const module = isRecord(rawModules[key]) ? rawModules[key] : {};
      if (typeof module.hasIssue !== 'boolean') {
        throw new BadRequestException(`${key} 审核结果无效`);
      }
      return [
        key,
        {
          hasIssue: module.hasIssue,
          description: clean(module.description),
        },
      ];
    }),
  ) as SystemMonthlyReportReviewRequest['modules'];
  return {
    clientMutationId: clean(payload.clientMutationId),
    currentRecordId: clean(payload.currentRecordId),
    room: clean(payload.room),
    round: payload.round as SystemMonthlyReportReviewRequest['round'],
    completed: payload.completed === true,
    modules,
  };
}

function reviewUploads(
  files: Record<string, UploadedMemoryFile[]>,
): SystemMonthlyReportReviewUpload[] {
  const mapping: Array<[string, SystemMonthlyReportModuleKey]> = [
    ['eventScreenshot', 'event'],
    ['changeScreenshot', 'change'],
    ['maintenanceScreenshot', 'maintenance'],
    ['drillScreenshot', 'drill'],
    ['otherScreenshot', 'other'],
  ];
  return mapping.flatMap(([fieldName, key]) => {
    const file = files[fieldName]?.[0];
    return file ? [{ key, file: asUploadFile(file) }] : [];
  });
}

function asUploadFile(file: UploadedMemoryFile): SystemMonthlyReportUploadFile {
  return {
    originalname: decodeUploadFileName(file.originalname),
    mimetype: file.mimetype,
    size: file.size,
    buffer: file.buffer,
  };
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value || ''));
    if (!isRecord(parsed)) throw new Error('payload must be an object');
    return parsed;
  } catch {
    throw new BadRequestException('payload 不是有效 JSON');
  }
}

function requirePrincipalFingerprint(request: AccessRequest): string {
  const value = clean(request.accessPrincipalFingerprint);
  if (
    value.length < 8 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ForbiddenException('当前提交会话无法验证，请重新登录');
  }
  return value;
}

function isPrivilegedRequest(request: AccessRequest): boolean {
  return Boolean(
    request.accessPrincipal &&
    (PRIVILEGED_ROLES.has(request.accessPrincipal.role) || isProfessionalBusinessPrincipal(request.accessPrincipal)),
  );
}

function requirePrivilegedSubject(
  request: AccessRequest,
): Extract<SystemMonthlyReportAccessSubject, { kind: 'privileged' }> {
  const role = request.accessPrincipal?.role;
  if (!role || (role !== 'admin' && role !== 'editor' && !isProfessionalBusinessPrincipal(request.accessPrincipal))) {
    throw new ForbiddenException('该操作仅限管理员或子管理员');
  }
  return {
    kind: 'privileged',
    role,
    principalFingerprint: requirePrincipalFingerprint(request),
  };
}

async function resolveSubject(
  request: AccessRequest,
  dashboard: Awaited<ReturnType<SystemMonthlyReportService['getDashboard']>>,
  identity: SystemMonthlyReportIdentityService,
): Promise<SystemMonthlyReportAccessSubject> {
  const subject = await resolveOptionalSubject(request, dashboard, identity);
  if (!subject) throw new ForbiddenException('请选择人员后进入体系月报');
  return subject;
}

async function resolveOptionalSubject(
  request: AccessRequest,
  dashboard: Awaited<ReturnType<SystemMonthlyReportService['getDashboard']>>,
  identity: SystemMonthlyReportIdentityService,
): Promise<SystemMonthlyReportAccessSubject | null> {
  if (isPrivilegedRequest(request)) return requirePrivilegedSubject(request);
  if (isPersonalAccessAccount(request.accessPrincipal)) {
    return identity.resolvePrincipal(request.accessPrincipal!, dashboard, identityToken(request));
  }
  const token = identityToken(request);
  return token ? identity.resolve(token, dashboard) : null;
}

function identityToken(request: AccessRequest): string {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  return clean(cookies?.[IDENTITY_COOKIE_NAME]);
}

function decodeUploadFileName(value: string): string {
  const cleaned = clean(value);
  try {
    const decoded = Buffer.from(cleaned, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? cleaned : decoded;
  } catch {
    return cleaned;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
