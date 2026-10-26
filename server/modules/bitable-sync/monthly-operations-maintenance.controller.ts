import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { GuestReadable } from '../../common/access/unified-access.decorators';
import { MonthlyOperationsMaintenanceService } from './monthly-operations-maintenance.service';
@Controller('api/bitable')
export class MonthlyOperationsMaintenanceController {
  constructor(
    @Inject(MonthlyOperationsMaintenanceService)
    private readonly service: MonthlyOperationsMaintenanceService,
  ) {}
  @Get('monthly-operations-maintenance')
  @GuestReadable()
  @Header('Cache-Control', 'no-store')
  get(
    @Query('kind') kind?: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.service.get(
      kind,
      start,
      end,
      refresh === '1' || refresh === 'true',
    );
  }
}
