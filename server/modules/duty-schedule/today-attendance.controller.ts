import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  AdminOnly,
  GuestReadable,
} from '@server/common/access/unified-access.decorators';
import type {
  TodayAttendanceCorrectionEvidenceQuery,
  TodayAttendanceManualSyncRequest,
} from '@shared/today-attendance.interface';
import { AttendanceAutomationCoordinatorService } from './attendance-automation-coordinator.service';
import { TodayAttendanceSnapshotService } from './today-attendance-snapshot.service';
import {
  getShanghaiDateKey,
  getTodayAttendanceTaskScheduledAt,
  resolveTodayAttendanceFinalTask,
} from './today-attendance.tasks';

@Controller('api/attendance')
export class TodayAttendanceController {
  constructor(
    private readonly snapshotService: TodayAttendanceSnapshotService,
    private readonly automationCoordinator: AttendanceAutomationCoordinatorService,
  ) {}

  @GuestReadable()
  @Get('today')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  getTodayAttendance(@Query('refresh') refresh?: string | string[]) {
    const values = Array.isArray(refresh) ? refresh : [refresh];
    const forceRefresh = values.some((value) =>
      ['1', 'true'].includes(
        String(value || '')
          .trim()
          .toLowerCase(),
      ),
    );
    return this.snapshotService.getSnapshot(new Date(), forceRefresh);
  }

  @AdminOnly()
  @Get('correction-evidence')
  @Header('Cache-Control', 'private, no-store')
  getCorrectionEvidence(
    @Query('date') businessDate: string,
    @Query('entryKey') entryKey: string,
  ) {
    return this.snapshotService.getCorrectionEvidence(
      parseCorrectionEvidenceQuery(businessDate, entryKey),
    );
  }

  @AdminOnly()
  @Get('correction-evidence/image')
  async getCorrectionEvidenceImage(
    @Query('date') businessDate: string,
    @Query('entryKey') entryKey: string,
    @Query('index') indexValue: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const index = Number(indexValue);
    if (!Number.isInteger(index) || index < 0 || index > 20) {
      throw new BadRequestException('补卡举证图片序号无效');
    }
    const file = await this.snapshotService.downloadCorrectionEvidence(
      parseCorrectionEvidenceQuery(businessDate, entryKey),
      index,
    );
    response.setHeader('Content-Type', file.contentType);
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${file.fileName}"`,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.buffer);
  }

  @AdminOnly()
  @Post('today/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  retryTodayAttendance(@Body() body: TodayAttendanceManualSyncRequest) {
    const clientMutationId = body?.clientMutationId;
    if (
      typeof clientMutationId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{11,127}$/u.test(clientMutationId)
    ) {
      throw new BadRequestException('手动同步请求标识无效');
    }
    const requestedTask = body?.task;
    if (
      requestedTask !== undefined &&
      requestedTask !== 'morning-off-duty-check' &&
      requestedTask !== 'evening-off-duty-check'
    ) {
      throw new BadRequestException('手动同步任务无效');
    }
    const now = new Date();
    const task = resolveTodayAttendanceFinalTask(now, requestedTask);
    if (!task) {
      throw new ConflictException('今日 09:30 考勤终检尚未到执行时间');
    }
    const date = getShanghaiDateKey(now);
    return this.automationCoordinator.requestManualRetry(
      {
        task,
        date,
        scheduledAt: getTodayAttendanceTaskScheduledAt(task, date),
      },
      clientMutationId,
    );
  }
}

function parseCorrectionEvidenceQuery(
  businessDate: string,
  entryKey: string,
): TodayAttendanceCorrectionEvidenceQuery {
  const date = String(businessDate || '').trim();
  const key = String(entryKey || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new BadRequestException('补卡举证业务日期无效');
  }
  if (!key || key.length > 300 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new BadRequestException('补卡举证业务键无效');
  }
  return { businessDate: date, entryKey: key };
}
