import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { GuestReadable } from '../../common/access/unified-access.decorators';
import { MonthlyOperationsChangesService } from './monthly-operations-changes.service';
@Controller('api/bitable')
export class MonthlyOperationsChangesController {
  constructor(
    @Inject(MonthlyOperationsChangesService)
    private readonly changes: MonthlyOperationsChangesService,
  ) {}
  @Get('monthly-operations/export-access')
  @Header('Cache-Control', 'no-store')
  exportAccess() { return {allowed:true}; }
  @Get('monthly-operations-progress')
  @GuestReadable()
  @Header('Cache-Control', 'no-store')
  progress(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.changes.getProgress(
      start,
      end,
      refresh === '1' || refresh === 'true',
    );
  }
  @Get('monthly-operations-changes')
  @GuestReadable()
  @Header('Cache-Control', 'no-store')
  get(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.changes.getChanges(
      start,
      end,
      refresh === '1' || refresh === 'true',
    );
  }
}
