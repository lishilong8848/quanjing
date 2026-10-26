import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { GuestReadable } from '../../common/access/unified-access.decorators';
import { MonthlyOperationsEventsService } from './monthly-operations-events.service';
@Controller('api/bitable')
export class MonthlyOperationsEventsController {
  constructor(
    @Inject(MonthlyOperationsEventsService)
    private readonly events: MonthlyOperationsEventsService,
  ) {}
  @Get('monthly-operations-events')
  @GuestReadable()
  @Header('Cache-Control', 'no-store')
  get(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.events.getEvents(
      start,
      end,
      refresh === '1' || refresh === 'true',
    );
  }

  @Get('monthly-operations-event-report')
  @GuestReadable()
  @Header('Cache-Control', 'private, max-age=300')
  getReport(
    @Query('eventId') eventId?: string,
    @Query('reportIndex') reportIndex?: string,
  ) {
    return this.events.getEventReviewReport(eventId, reportIndex);
  }
}
