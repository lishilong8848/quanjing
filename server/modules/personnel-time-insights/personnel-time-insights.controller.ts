import { Controller, Get, Header, Query } from '@nestjs/common';
import { AdminOnly } from '@server/common/access/unified-access.decorators';
import { PersonnelTimeInsightsService } from './personnel-time-insights.service';

@Controller('api/personnel-time-insights')
export class PersonnelTimeInsightsController {
  constructor(private readonly service: PersonnelTimeInsightsService) {}

  @AdminOnly()
  @Get()
  @Header('Cache-Control', 'private, no-store')
  getInsights(@Query('from') from: string, @Query('through') through: string) {
    return this.service.getInsights(from, through);
  }
}
