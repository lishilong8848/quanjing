import { Body, Controller, Get, Post, Query } from '@nestjs/common';
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
  ): Promise<EmergencyDutyUpsertResponse> {
    return this.emergencyDutyService.upsertSchedule(request);
  }
}
