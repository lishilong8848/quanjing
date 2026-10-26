import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { GuestReadable } from '../../common/access/unified-access.decorators';
import { MonthlyOperationsAlarmsService } from './monthly-operations-alarms.service';
@Controller('api/bitable')
export class MonthlyOperationsAlarmsController {
  constructor(
    @Inject(MonthlyOperationsAlarmsService)
    private readonly service: MonthlyOperationsAlarmsService,
  ) {}
  @Get('monthly-operations-alarms')
  @GuestReadable()
  @Header('Cache-Control', 'no-store')
  get(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.service.get(start, end, refresh === '1' || refresh === 'true');
  }
}
