import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Post,
  Query,
  Param,
  Res,
  Header,
  Logger,
  Body,
  Req,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type {
  CampusCertificateExpiryNotificationRequest,
  ScheduleSnapshotRevisionResponse,
} from '../../../shared/api.interface';
import type { AccessRole, AccessPrincipal } from '../../../shared/access-control.interface';
import { canViewPersonProfileDetails } from '../../../shared/person-profile-access';
import {
  canViewOrganizationPersonProfile,
  parseOrganizationPersonProfileSource,
} from '../../../shared/organization-person-profile';
import { GuestReadable } from '../../common/access/unified-access.decorators';
import { BitableSyncService } from './bitable-sync.service';
import { CertificateDashboardNotificationService } from './certificate-dashboard-notification.service';
import { CertificateDashboardService } from './certificate-dashboard.service';
import { TrainingDashboardService } from './training-dashboard.service';
import { TodayOperationsAlarmService } from './today-operations-alarm.service';
import { TodayOperationsOverviewService } from './today-operations-overview.service';
import { mergeOrganizationPersonCertificatesFromDashboard } from './organization-person-profile.mapper';
import {
  parsePersonProfilePhotoScope,
  parsePersonProfileScope,
  type PersonProfilePhotoScope,
  type PersonProfileScope,
} from './person-profile-source';

type BitableSyncAccessRequest = Request & { accessRole?: AccessRole; accessPrincipal?:AccessPrincipal };

@Controller('api/bitable')
export class BitableSyncController {
  private readonly logger = new Logger(BitableSyncController.name);

  constructor(
    private readonly bitableSyncService: BitableSyncService,
    private readonly certificateDashboardService: CertificateDashboardService,
    private readonly certificateDashboardNotificationService: CertificateDashboardNotificationService,
    private readonly trainingDashboardService: TrainingDashboardService,
    private readonly todayOperationsAlarmService: TodayOperationsAlarmService,
    private readonly todayOperationsOverviewService: TodayOperationsOverviewService,
  ) {}

  /**
   * GET /api/bitable/weather/now - 获取实时天气数据
   */
  @GuestReadable()
  @Get('weather/now')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getWeatherNow() {
    return this.bitableSyncService.getWeatherNow();
  }

  /**
   * GET /api/bitable/weather/warning - 获取天气预警信息
   */
  @GuestReadable()
  @Get('weather/warning')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getWeatherWarning() {
    return this.bitableSyncService.getWeatherWarning();
  }

  /**
   * GET /api/bitable/weather/hourly - 获取逐小时天气预报
   */
  @GuestReadable()
  @Get('weather/hourly')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getWeatherHourly() {
    return this.bitableSyncService.getWeatherHourly();
  }

  @GuestReadable()
  @Get('schedule-snapshot-revision')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getScheduleSnapshotRevision(): Promise<ScheduleSnapshotRevisionResponse> {
    return this.bitableSyncService.getScheduleSnapshotRevision();
  }

  /**
   * POST /api/bitable/sync - 从飞书多维表格同步数据
   */
  @Post('sync')
  async syncFromBitable() {
    return this.bitableSyncService.syncFromBitable();
  }

  /**
   * GET /api/bitable/campus-operations-dashboard - 获取园区运行仪表盘数据
   */
  @GuestReadable()
  @Get('campus-operations-dashboard')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getCampusOperationsDashboard(
    @Query('forceRefresh') forceRefresh?: string,
    @Query('refresh') refresh?: string,
    @Query('screenshotDate') screenshotDate?: string,
    @Query('screenshotShift') screenshotShift?: string,
  ) {
    const shouldRefresh =
      forceRefresh === '1' ||
      forceRefresh === 'true' ||
      refresh === '1' ||
      refresh === 'true';
    return this.bitableSyncService.getCampusOperationsDashboard(
      shouldRefresh,
      screenshotDate,
      screenshotShift,
    );
  }

  @GuestReadable()
  @Get('today-operations-alarms')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getTodayOperationsAlarms(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('metric') metric?: string,
    @Query('building') building?: string,
    @Query('level') level?: string,
    @Query('status') status?: string,
    @Query('processingStatus') processingStatus?: string,
    @Query('recoveryStatus') recoveryStatus?: string,
    @Query('q') q?: string,
    @Query('tagIssueCode') tagIssueCode?: string,
    @Query('refresh') refresh?: string,
    @Query('date') date?: string,
  ) {
    return this.todayOperationsAlarmService.getDashboard({
      page,
      pageSize,
      metric,
      building,
      level,
      status,
      processingStatus,
      recoveryStatus,
      q,
      tagIssueCode,
      refresh,
      date,
    });
  }

  @GuestReadable()
  @Get('today-operations-overview')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getTodayOperationsOverview(@Query('refresh') refresh?: string) {
    return this.todayOperationsOverviewService.getOverview(
      refresh === '1' || refresh === 'true',
    );
  }

  @Get('campus-training-dashboard')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getCampusTrainingDashboard(
    @Query('month') month?: unknown,
    @Query('forceRefresh') forceRefresh?: unknown,
  ) {
    if (month !== undefined && typeof month !== 'string') {
      throw new BadRequestException('month 必须使用 YYYY-MM 格式');
    }
    const normalizedMonth =
      typeof month === 'string' ? month.trim() || undefined : undefined;
    if (normalizedMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(normalizedMonth)) {
      throw new BadRequestException('month 必须使用 YYYY-MM 格式');
    }
    const shouldRefresh = forceRefresh === '1' || forceRefresh === 'true';
    return this.trainingDashboardService.getDashboard(
      normalizedMonth,
      shouldRefresh,
    );
  }

  @Get('campus-certificate-dashboard')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getCampusCertificateDashboard(
    @Query('forceRefresh') forceRefresh?: string,
  ) {
    const shouldRefresh = forceRefresh === '1' || forceRefresh === 'true';
    return this.certificateDashboardService.getDashboard(shouldRefresh);
  }

  @Get('campus-certificate-dashboard/expiry-notification-preview')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getCampusCertificateExpiryNotificationPreview() {
    return this.certificateDashboardNotificationService.previewExpiryNotifications();
  }

  @Post('campus-certificate-dashboard/notify-expiring')
  async notifyExpiringCampusCertificates(
    @Body() body: CampusCertificateExpiryNotificationRequest,
  ) {
    return this.certificateDashboardNotificationService.sendExpiryNotifications(
      body,
    );
  }

  /**
   * GET /api/bitable/records - 获取已同步的多维表记录
   */
  @Get('records')
  async getBitableRecords(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.bitableSyncService.getBitableRecords(
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 20,
    );
  }

  /**
   * GET /api/bitable/last-sync-time - 获取最后同步时间
   */
  @Get('last-sync-time')
  async getLastSyncTime() {
    const lastSyncTime = await this.bitableSyncService.getLastSyncTime();
    return { lastSyncTime };
  }

  /**
   * POST /api/bitable/sync-organization - 同步组织架构数据
   */
  @Post('sync-organization')
  async syncOrganization() {
    return this.bitableSyncService.syncOrganization();
  }

  /**
   * GET /api/bitable/organizations - 获取组织架构列表
   */
  @Get('organizations')
  async getOrganizations() {
    return this.bitableSyncService.getOrganizations();
  }

  @Get('organization-person-profile/:source/:recordId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Cookie')
  async getOrganizationPersonProfile(
    @Param('source') source: string,
    @Param('recordId') recordId: string,
    @Req() request: BitableSyncAccessRequest,
  ) {
    if (!canViewOrganizationPersonProfile(request.accessPrincipal ?? request.accessRole ?? 'guest')) {
      throw new ForbiddenException('当前身份无权查看人员档案');
    }
    let parsedSource;
    try {
      parsedSource = parseOrganizationPersonProfileSource(source);
    } catch {
      throw new BadRequestException('人员档案来源无效');
    }
    const certificateDashboardPromise = this.certificateDashboardService
      .getDashboard()
      .catch((error: unknown) => {
        this.logger.warn(
          `人员档案持证数据合并失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      });
    const [response, certificateDashboard] = await Promise.all([
      this.bitableSyncService.getOrganizationPersonProfile(
        parsedSource,
        recordId,
      ),
      certificateDashboardPromise,
    ]);
    if (!certificateDashboard) return response;
    return {
      profile: mergeOrganizationPersonCertificatesFromDashboard(
        response.profile,
        certificateDashboard.people,
      ),
    };
  }

  /**
   * GET /api/bitable/person-profiles - 获取人员资料列表
   */
  @GuestReadable()
  @Get('person-profiles')
  async getPersonProfiles(
    @Query('forceRefresh') forceRefresh?: string,
    @Query('scope') scope?: string,
  ) {
    let parsedScope: PersonProfileScope;
    try {
      parsedScope = parsePersonProfileScope(scope);
    } catch {
      throw new BadRequestException('人员资料范围无效');
    }
    const result = await this.bitableSyncService.getPersonProfiles(
      forceRefresh === '1' || forceRefresh === 'true',
      parsedScope,
    );
    return {organizations:result.organizations.map(({supervisorText,position,buildingsSpecialties,shift})=>({supervisorText,position,buildingsSpecialties,shift})),
      ...(result.changeRequestSubmitters ? {changeRequestSubmitters:result.changeRequestSubmitters}: {})};
  }

  @Get('person-profile-details')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Cookie')
  async getPersonProfileDetails(
    @Req() request: BitableSyncAccessRequest,
    @Query('forceRefresh') forceRefresh?: string,
    @Query('scope') scope?: string,
  ) {
    if (!canViewPersonProfileDetails(request.accessPrincipal ?? request.accessRole ?? 'guest')) {
      throw new ForbiddenException('当前身份无权查看人员详细资料');
    }
    let parsedScope: PersonProfileScope;
    try {
      parsedScope = parsePersonProfileScope(scope);
    } catch {
      throw new BadRequestException('人员资料范围无效');
    }
    return this.bitableSyncService.getPersonProfileDetails(
      forceRefresh === '1' || forceRefresh === 'true',
      parsedScope,
    );
  }

  /**
   * GET /api/bitable/duty-staff - 获取值班人员列表
   */
  @Get('duty-staff')
  async getDutyStaff(@Req() request?:BitableSyncAccessRequest) {
    const result=await this.bitableSyncService.getDutyStaff();
    const principal=request?.accessPrincipal ?? request?.accessRole ?? 'guest';
    if(canViewPersonProfileDetails(principal) || canViewOrganizationPersonProfile(principal)) return result;
    const basic=(person:NonNullable<typeof result.staff[number]['shifts'][number]['staff']>|null)=>person?{
      id:person.id,profileSource:person.profileSource,appName:person.appName,position:person.position,buildingProfessional:person.buildingProfessional,shift:person.shift,
    }:null;
    return {...result,staff:result.staff.map(group=>({...group,shifts:group.shifts.map(shift=>({...shift,leader:basic(shift.leader),staff:basic(shift.staff)}))}))};
  }

  @Get('employee-photo/:recordId')
  async getEmployeePhoto(
    @Param('recordId') recordId: string,
    @Req() request: BitableSyncAccessRequest,
    @Query('scope') scope: string | undefined,
    @Res() res: Response,
  ) {
    if (!canViewPersonProfileDetails(request.accessPrincipal ?? request.accessRole ?? 'guest')) {
      throw new ForbiddenException('当前身份无权查看人员照片');
    }
    let parsedScope: PersonProfilePhotoScope;
    try {
      parsedScope = parsePersonProfilePhotoScope(scope);
    } catch {
      throw new BadRequestException('人员照片范围无效');
    }
    const photo = await this.bitableSyncService.getEmployeePhoto(
      recordId,
      parsedScope,
    );
    if (!photo) {
      res.status(404).send('Photo not found');
      return;
    }

    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Vary', 'Cookie');
    res.send(photo.buffer);
  }

  @Get('person-chat/:recordId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Cookie')
  async openPersonChat(
    @Param('recordId') recordId: string,
    @Req() request: BitableSyncAccessRequest,
    @Query('scope') scope: string | undefined,
    @Res() res: Response,
  ) {
    if (!canViewPersonProfileDetails(request.accessPrincipal ?? request.accessRole ?? 'guest')) {
      throw new ForbiddenException('当前身份无权发起人员会话');
    }
    let parsedScope: PersonProfileScope;
    try {
      parsedScope = parsePersonProfileScope(scope);
    } catch {
      throw new BadRequestException('人员资料范围无效');
    }
    const appLink = await this.bitableSyncService.getPersonChatAppLink(
      recordId,
      parsedScope,
    );
    if (!appLink) {
      throw new NotFoundException('该人员尚未维护可用的飞书账号');
    }
    res.redirect(302, appLink);
  }

  /**
   * POST /api/bitable/sync-holiday - 同步节日&重保排班数据
   */
  @Post('sync-holiday')
  async syncHolidayDutySchedule() {
    return this.bitableSyncService.syncHolidayDutySchedule();
  }

  /**
   * GET /api/bitable/holiday-schedules - 获取节日&重保排班列表
   */
  @Get('holiday-schedules')
  async getHolidayDutySchedules(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('dutyType') dutyType?: string,
  ) {
    return this.bitableSyncService.getHolidayDutySchedules({
      startDate,
      endDate,
      dutyType,
    });
  }

  /**
   * GET /api/bitable/festival-schedules - 获取节日重要排班列表（从 app_festival_important_schedule 表）
   */
  @GuestReadable()
  @Get('festival-schedules')
  async getFestivalSchedules(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.bitableSyncService.getFestivalSchedules({
      startDate,
      endDate,
    });
  }

  /**
   * POST /api/bitable/sync-non-duty - 同步非值班排班数据
   */
  @Post('sync-non-duty')
  async syncNonDutySchedule() {
    return this.bitableSyncService.syncNonDutySchedule();
  }

  /**
   * GET /api/bitable/non-duty-schedules - 获取非值班排班列表
   */
  @Get('non-duty-schedules')
  async getNonDutySchedules(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('building') building?: string,
    @Query('team') team?: string,
  ) {
    return this.bitableSyncService.getNonDutySchedules({
      startDate,
      endDate,
      building,
      team,
    });
  }

  /**
   * GET /api/bitable/debug-record/:recordId - 调试单条记录
   */
  @Get('debug-record/:recordId')
  async debugRecord(@Param('recordId') recordId: string) {
    return this.bitableSyncService.debugRecordFromFeishu(recordId);
  }

  /**
   * GET /api/bitable/table-fields - 获取表格字段列表
   */
  @Get('table-fields')
  async getTableFields() {
    return this.bitableSyncService.getNonDutyTableFields();
  }

  /**
   * POST /api/bitable/verify-leave-data - 验证请假数据一致性
   */
  @Post('verify-leave-data')
  async verifyLeaveData() {
    return this.bitableSyncService.verifyLeaveDataConsistency();
  }

  /**
   * GET /api/bitable/today-leave-staff - 获取今日请假人员列表
   */
  @GuestReadable()
  @Get('today-leave-staff')
  async getTodayLeaveStaff(
    @Query('date') date?: string,
    @Query('refresh') refresh?: string,
  ) {
    // 如果没有提供日期，使用今天
    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.bitableSyncService.getTodayLeaveStaff(
      targetDate,
      refresh === '1' || refresh === 'true',
    );
  }
}
