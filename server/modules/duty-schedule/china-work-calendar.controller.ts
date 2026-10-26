import { Controller, Get } from '@nestjs/common';
import { GuestReadable } from '@server/common/access/unified-access.decorators';
import { ChinaWorkCalendarService } from './china-work-calendar.service';

@Controller('api/duty-schedules/work-calendar')
export class ChinaWorkCalendarController {
  constructor(private readonly calendarService: ChinaWorkCalendarService) {}

  @GuestReadable()
  @Get()
  getChinaWorkCalendar() {
    return this.calendarService.getResponse();
  }
}
