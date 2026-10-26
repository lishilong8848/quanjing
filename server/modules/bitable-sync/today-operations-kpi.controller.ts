import { Controller, Get, Header, Query } from '@nestjs/common';
import { GuestReadable } from '../../common/access/unified-access.decorators';
import { TodayOperationsKpiService } from './today-operations-kpi.service';

@Controller('api/bitable')
export class TodayOperationsKpiController {
  constructor(
    private readonly todayOperationsKpiService: TodayOperationsKpiService,
  ) {}

  @GuestReadable()
  @Get('today-operations-kpis')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getTodayOperationsKpis(@Query('refresh') refresh?: string) {
    return this.todayOperationsKpiService.getKpis(
      refresh === '1' || refresh === 'true',
    );
  }
}
