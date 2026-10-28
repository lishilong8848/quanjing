import { Body, Controller, Get, Post, Query, Req, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessPrincipal } from '@shared/access-control.interface';
import { GuestReadable } from '@server/common/access/unified-access.decorators';
import type {
  EmergencyDutyOptionsResponse,
  EmergencyDutyScheduleResponse,
  EmergencyDutyUpsertRequest,
  EmergencyDutyUpsertResponse,
} from '@shared/emergency-duty.interface';
import { EmergencyDutyService } from './emergency-duty.service';

@Controller('api/duty-schedules/emergency-duty')
export class EmergencyDutyController {
  constructor(private readonly emergencyDutyService: EmergencyDutyService) {}

  @Get()
  @GuestReadable()
  getSchedules(
    @Query('startDate') startDate?: unknown,
    @Query('endDate') endDate?: unknown,
  ): Promise<EmergencyDutyScheduleResponse> {
    return this.emergencyDutyService.getSchedules(startDate, endDate);
  }

  @Get('options')
  getOptions(): Promise<EmergencyDutyOptionsResponse> {
    return this.emergencyDutyService.getOptions();
  }

  @Post()
  upsertSchedule(
    @Body() request: EmergencyDutyUpsertRequest,
    @Req() httpRequest:Request & {accessPrincipal?:AccessPrincipal},
  ): Promise<EmergencyDutyUpsertResponse> {
    if (!httpRequest?.accessPrincipal) throw new ForbiddenException('请先确认登录身份');
    return this.emergencyDutyService.upsertSchedule(request,httpRequest.accessPrincipal);
  }
}
