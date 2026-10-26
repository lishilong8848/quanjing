import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { GuestReadable } from '../../common/access/unified-access.decorators';
import { MonthlyOperationsAssessmentService } from './monthly-operations-assessment.service';
@Controller('api/bitable')
export class MonthlyOperationsAssessmentController {
  constructor(
    @Inject(MonthlyOperationsAssessmentService)
    private readonly service: MonthlyOperationsAssessmentService,
  ) {}
  @Get('monthly-operations-assessment')
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
