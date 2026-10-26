import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { GuestReadable } from '../../common/access/unified-access.decorators';
import { MonthlyOperationsResourcesService } from './monthly-operations-resources.service';

@Controller('api/bitable')
export class MonthlyOperationsResourcesController {
  constructor(@Inject(MonthlyOperationsResourcesService) private readonly resources: MonthlyOperationsResourcesService) {}
  @GuestReadable()
  @Get('monthly-operations-resources')
  @Header('Cache-Control', 'no-store')
  get(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.resources.getResources(
      start,
      end,
      refresh === '1' || refresh === 'true',
    );
  }
}
