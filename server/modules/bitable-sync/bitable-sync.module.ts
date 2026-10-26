import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { BitableSyncController } from './bitable-sync.controller';
import { BitableSyncService } from './bitable-sync.service';
import { unavailableDatabase } from '@server/common/database/unavailable-database';
import { CertificateDashboardService } from './certificate-dashboard.service';
import { CertificateDashboardNotificationService } from './certificate-dashboard-notification.service';
import { EmployeeOnboardingController } from './employee-onboarding.controller';
import { EmployeeOnboardingGateway } from './employee-onboarding.gateway';
import { EmployeeOnboardingService } from './employee-onboarding.service';
import { MbtiAssessmentController } from './mbti-assessment.controller';
import { MbtiAssessmentService } from './mbti-assessment.service';
import { TrainingDashboardService } from './training-dashboard.service';
import { TodayOperationsAlarmService } from './today-operations-alarm.service';
import { AlarmReviewController } from './alarm-review.controller';
import { AlarmReviewGateway } from './alarm-review.gateway';
import { AlarmReviewService } from './alarm-review.service';
import { AlarmReviewStore } from './alarm-review.store';
import { TodayOperationsKpiController } from './today-operations-kpi.controller';
import { TodayOperationsKpiService } from './today-operations-kpi.service';
import { MonthlyOperationsResourcesController } from './monthly-operations-resources.controller';
import { MonthlyOperationsResourcesService } from './monthly-operations-resources.service';
import { MonthlyOperationsEventsController } from './monthly-operations-events.controller';
import { MonthlyOperationsEventsService } from './monthly-operations-events.service';
import { MonthlyOperationsChangesController } from './monthly-operations-changes.controller';
import { MonthlyOperationsChangesService } from './monthly-operations-changes.service';
import { MonthlyOperationsAssessmentController } from './monthly-operations-assessment.controller';
import { MonthlyOperationsAssessmentService } from './monthly-operations-assessment.service';
import { MonthlyOperationsMaintenanceController } from './monthly-operations-maintenance.controller';
import { MonthlyOperationsMaintenanceService } from './monthly-operations-maintenance.service';
import { MonthlyOperationsAlarmsController } from './monthly-operations-alarms.controller';
import { MonthlyOperationsAlarmsService } from './monthly-operations-alarms.service';
import { TodayOperationsOverviewService } from './today-operations-overview.service';
import { TodayOperationsAnomalyGateway } from './today-operations-anomaly.gateway';
import { TodayOperationsAnomalyService } from './today-operations-anomaly.service';
import { TodayOperationsAnomalyStore } from './today-operations-anomaly.store';
import { TodayOperationsScheduleConsistencyService } from './today-operations-schedule-consistency.service';
import { AttendanceDailySummaryStore } from '../duty-schedule/attendance-daily-summary.store';
import { TodayOperationsFollowUpController } from './today-operations-follow-up.controller';
import { TodayOperationsFollowUpTicketService } from './today-operations-follow-up.ticket';
import { NantongAssistantController } from './nantong-assistant.controller';
import { NantongAssistantService } from './nantong-assistant.service';

const databaseFallbackProviders =
  process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS === 'true'
    ? [{ provide: DRIZZLE_DATABASE, useValue: unavailableDatabase }]
    : [];

@Module({
  imports: [HttpModule],
  controllers: [
    AlarmReviewController,
    BitableSyncController,
    EmployeeOnboardingController,
    MbtiAssessmentController,
    TodayOperationsKpiController,
    MonthlyOperationsResourcesController,
    MonthlyOperationsEventsController,
    MonthlyOperationsChangesController,
    MonthlyOperationsAssessmentController,
    MonthlyOperationsMaintenanceController,
    MonthlyOperationsAlarmsController,
    TodayOperationsFollowUpController,
    NantongAssistantController,
  ],
  providers: [
    AlarmReviewGateway,
    AlarmReviewService,
    AlarmReviewStore,
    ...databaseFallbackProviders,
    BitableSyncService,
    CertificateDashboardService,
    CertificateDashboardNotificationService,
    EmployeeOnboardingGateway,
    EmployeeOnboardingService,
    MbtiAssessmentService,
    TrainingDashboardService,
    TodayOperationsAlarmService,
    TodayOperationsKpiService,
    MonthlyOperationsResourcesService,
    MonthlyOperationsEventsService,
    MonthlyOperationsChangesService,
    MonthlyOperationsAssessmentService,
    MonthlyOperationsMaintenanceService,
    MonthlyOperationsAlarmsService,
    TodayOperationsOverviewService,
    TodayOperationsAnomalyGateway,
    TodayOperationsAnomalyStore,
    TodayOperationsAnomalyService,
    TodayOperationsFollowUpTicketService,
    NantongAssistantService,
    TodayOperationsScheduleConsistencyService,
    AttendanceDailySummaryStore,
  ],
  exports: [
    BitableSyncService,
    CertificateDashboardService,
    CertificateDashboardNotificationService,
    TrainingDashboardService,
    TodayOperationsAlarmService,
    TodayOperationsKpiService,
    TodayOperationsOverviewService,
    TodayOperationsAnomalyService,
    TodayOperationsScheduleConsistencyService,
  ],
})
export class BitableSyncModule {}
