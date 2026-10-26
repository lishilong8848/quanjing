import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { DutyScheduleController } from '@server/modules/duty-schedule/duty-schedule.controller';
import { DutyScheduleService } from '@server/modules/duty-schedule/duty-schedule.service';
import { DutyScheduleAutomationService } from '@server/modules/duty-schedule/duty-schedule.automation';
import { DutyScreenshotService } from '@server/modules/duty-schedule/duty-screenshot.service';
import { DutyDailyReportBitableService } from '@server/modules/duty-schedule/duty-daily-report-bitable.service';
import { DutyDailyReportTaskCoordinatorService } from '@server/modules/duty-schedule/duty-daily-report-task-coordinator.service';
import { DutyDailyReportLocalSchedulerService } from '@server/modules/duty-schedule/duty-daily-report-local-scheduler.service';
import { TyphoonWarningMonitorService } from '@server/modules/duty-schedule/typhoon-warning-monitor.service';
import { ChinaWorkCalendarController } from '@server/modules/duty-schedule/china-work-calendar.controller';
import { ChinaWorkCalendarService } from '@server/modules/duty-schedule/china-work-calendar.service';
import { BitableSyncModule } from '@server/modules/bitable-sync/bitable-sync.module';
import { unavailableDatabase } from '@server/common/database/unavailable-database';
import { ChangeAttachmentStorageService } from '@server/modules/duty-schedule/change-attachment-storage.service';
import { ChangeAdjustmentService } from '@server/modules/duty-schedule/change-adjustment.service';
import { ChangeDrillReportService } from '@server/modules/duty-schedule/change-drill-report.service';
import { ChangeSummaryReportService } from '@server/modules/duty-schedule/change-summary-report.service';
import { EmergencyDutyController } from '@server/modules/duty-schedule/emergency-duty.controller';
import { EmergencyDutyService } from '@server/modules/duty-schedule/emergency-duty.service';
import { OvertimeWorkflowModule } from '@server/modules/overtime-workflow/overtime-workflow.module';
import { LeaveWorkflowModule } from '@server/modules/leave-workflow/leave-workflow.module';
import { DingTalkAttendanceClient } from '@server/modules/duty-schedule/dingtalk-attendance.client';
import { AttendanceAutomationFeishuGateway } from '@server/modules/duty-schedule/attendance-automation-feishu.gateway';
import { AttendanceDailySummaryStore } from '@server/modules/duty-schedule/attendance-daily-summary.store';
import { AttendanceAutomationCoordinatorService } from '@server/modules/duty-schedule/attendance-automation-coordinator.service';
import { AttendanceAutomationLocalSchedulerService } from '@server/modules/duty-schedule/attendance-automation-local-scheduler.service';
import { TodayAttendanceController } from '@server/modules/duty-schedule/today-attendance.controller';
import { TodayAttendanceSnapshotService } from '@server/modules/duty-schedule/today-attendance-snapshot.service';
import { DailyOperationsPatrolGateway } from '@server/modules/duty-schedule/daily-operations-patrol.gateway';
import { DailyOperationsPatrolStore } from '@server/modules/duty-schedule/daily-operations-patrol.store';
import { DailyOperationsPatrolService } from '@server/modules/duty-schedule/daily-operations-patrol.service';
import { AttendancePeriodicSummaryStore } from '@server/modules/duty-schedule/attendance-periodic-summary.store';
import { AttendancePeriodicSummaryService } from '@server/modules/duty-schedule/attendance-periodic-summary.service';
import { AttendancePeriodicSummaryLocalSchedulerService } from '@server/modules/duty-schedule/attendance-periodic-summary-local-scheduler.service';
import { AttendanceHistoryController } from '@server/modules/duty-schedule/attendance-history.controller';
import { AttendanceHistoryService } from '@server/modules/duty-schedule/attendance-history.service';
import { AttendanceCorrectionEvidenceStorageService } from '@server/modules/duty-schedule/attendance-correction-evidence-storage.service';

const databaseFallbackProviders =
  process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS === 'true'
    ? [{ provide: DRIZZLE_DATABASE, useValue: unavailableDatabase }]
    : [];

@Module({
  imports: [
    HttpModule.register({
      // 增加超时时间避免504错误
      timeout: 60000, // 增加超时时间到60秒
      maxRedirects: 5,
    }),
    BitableSyncModule,
    OvertimeWorkflowModule,
    LeaveWorkflowModule,
  ],
  controllers: [
    DutyScheduleController,
    ChinaWorkCalendarController,
    EmergencyDutyController,
    TodayAttendanceController,
    AttendanceHistoryController,
  ],
  providers: [
    ...databaseFallbackProviders,
    DutyScheduleService,
    ChangeAttachmentStorageService,
    ChangeAdjustmentService,
    ChangeDrillReportService,
    ChangeSummaryReportService,
    DutyScheduleAutomationService,
    DutyScreenshotService,
    DutyDailyReportBitableService,
    DutyDailyReportTaskCoordinatorService,
    DutyDailyReportLocalSchedulerService,
    TyphoonWarningMonitorService,
    ChinaWorkCalendarService,
    EmergencyDutyService,
    DingTalkAttendanceClient,
    AttendanceAutomationFeishuGateway,
    AttendanceCorrectionEvidenceStorageService,
    AttendanceDailySummaryStore,
    AttendanceAutomationCoordinatorService,
    AttendanceAutomationLocalSchedulerService,
    TodayAttendanceSnapshotService,
    DailyOperationsPatrolGateway,
    DailyOperationsPatrolStore,
    DailyOperationsPatrolService,
    AttendancePeriodicSummaryStore,
    AttendancePeriodicSummaryService,
    AttendancePeriodicSummaryLocalSchedulerService,
    AttendanceHistoryService,
  ],
})
export class DutyScheduleModule {}
