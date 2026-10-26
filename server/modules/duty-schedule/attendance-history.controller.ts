import { Controller, Get, Header, Query } from '@nestjs/common';
import { GuestReadable } from '@server/common/access/unified-access.decorators';
import { parseAttendanceHistoryQuery } from './attendance-history.query';
import { AttendanceHistoryService } from './attendance-history.service';

@Controller('api/attendance')
export class AttendanceHistoryController {
  constructor(private readonly historyService: AttendanceHistoryService) {}

  @GuestReadable()
  @Get('history')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  getHistory(
    @Query('from') from: string,
    @Query('through') through: string,
    @Query('refresh') refresh?: string | string[],
  ) {
    const query = parseAttendanceHistoryQuery(from, through, refresh);
    return this.historyService.getHistory(
      query.startDate,
      query.endDate,
      query.forceRefresh,
    );
  }
}
