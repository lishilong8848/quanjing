import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { canPerformBusinessAction } from '../../../shared/business-permissions';
import type { SelfServiceScheduleResponse } from '../../../shared/self-service-schedule.interface';
import { AccessConfigurationDirectory } from '../../common/access/access-configuration.directory';
import { withPersonnelDirectoryDeadline } from '../../common/access/personnel-directory-deadline';
import { DutyScheduleService } from './duty-schedule.service';
import {
  projectSelfServiceSchedules,
  resolveSelfServiceScheduleApplicant,
  selfServiceScheduleMonth,
} from './self-service-schedule';

interface SelfServiceScheduleAccessRequest {
  accessPrincipal?: AccessPrincipal;
  accessPrincipalFingerprint?: string;
}

@Controller('api/self-service-schedules')
export class SelfServiceScheduleController {
  constructor(
    private readonly directory: AccessConfigurationDirectory,
    private readonly schedules: DutyScheduleService,
  ) {}

  @Get(':year/:month')
  @Header('Cache-Control', 'private, no-store')
  async read(
    @Param('year') year: string,
    @Param('month') month: string,
    @Req() request: SelfServiceScheduleAccessRequest,
    @Query() query: Record<string, unknown> = {},
  ): Promise<SelfServiceScheduleResponse> {
    if (Object.keys(query).length)
      throw new BadRequestException('本人班次接口不接受人员选择或刷新参数');
    const range = selfServiceScheduleMonth(year, month),
      principal = request.accessPrincipal;
    if (!principal || !request.accessPrincipalFingerprint)
      throw new UnauthorizedException('请先登录后读取本人班次');
    if (
      !(['leave_requests', 'overtime_requests'] as const).some((module) =>
        canPerformBusinessAction(principal, { module, action: 'create' }),
      )
    ) {
      throw new ForbiddenException('当前账号没有请休假或加班申请权限');
    }
    const directory = await withPersonnelDirectoryDeadline<
      Awaited<ReturnType<AccessConfigurationDirectory['read']>>
    >(
      this.directory.read(),
    );
    const name = resolveSelfServiceScheduleApplicant(principal, directory);
    // This existing reader uses the full approval-aware persisted source and
    // throws when unavailable. Empty personal results are valid rest periods.
    const rows = await this.schedules.getMonthlySchedules(
      range.year,
      range.month,
      false,
    );
    return projectSelfServiceSchedules(rows, name, {
      startDate: range.startDate,
      endDate: range.endDate,
    });
  }
}
