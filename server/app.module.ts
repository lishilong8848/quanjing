import { APP_FILTER } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PlatformModule } from '@lark-apaas/fullstack-nestjs-core';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { DutyScheduleModule } from './modules/duty-schedule/duty-schedule.module';
import { BitableSyncModule } from './modules/bitable-sync/bitable-sync.module';
import { OperationsKbModule } from './modules/operations-kb/operations-kb.module';
import { AliMonthlyReportModule } from './modules/ali-monthly-report/ali-monthly-report.module';
import { PurchaseInventoryModule } from './modules/purchase-inventory/purchase-inventory.module';
import { InventoryManagementModule } from './modules/inventory-management/inventory-management.module';
import { OperationsToolsModule } from './modules/operations-tools/operations-tools.module';
import { ContractManagementModule } from './modules/contract-management/contract-management.module';
import { EquipmentPatrolExecutionModule } from './modules/equipment-patrol/equipment-patrol-execution.module';
import { RiskInspectionModule } from './modules/risk-inspection/risk-inspection.module';
import { EquipmentLifecycleModule } from './modules/equipment-lifecycle/equipment-lifecycle.module';
import { WeatherWarningModule } from './modules/weather-warning/weather-warning.module';
import { SystemMonthlyReportModule } from './modules/system-monthly-report/system-monthly-report.module';
import { ViewModule } from './modules/view/view.module';
import { UnifiedAccessModule } from './common/access/unified-access.module';
import { FeishuCardCopyModule } from './common/feishu-card-copy/card-copy.module';
import { DashboardDataSyncScheduler } from './modules/dashboard-data-sync/dashboard-data-sync.scheduler';
import { PersonnelTimeInsightsModule } from './modules/personnel-time-insights/personnel-time-insights.module';
import { ThresholdModule } from './modules/threshold-management/threshold.module';
import { MeetingManagementModule } from './modules/meeting-management/meeting.module';

@Module({
  imports: [
    UnifiedAccessModule,
    FeishuCardCopyModule,
    // 平台 Module，提供平台能力
    PlatformModule.forRoot({
      enableCsrf: process.env.NODE_ENV === 'production',
    }),
    // ====== @route-section: business-modules START ======
    // Place all business modules here.Do NOT add fallback modules here.
    DutyScheduleModule,
    BitableSyncModule,
    OperationsKbModule,
    AliMonthlyReportModule,
    PurchaseInventoryModule,
    InventoryManagementModule,
    OperationsToolsModule,
    ContractManagementModule,
    EquipmentPatrolExecutionModule,
    RiskInspectionModule,
    EquipmentLifecycleModule,
    WeatherWarningModule,
    SystemMonthlyReportModule,
    PersonnelTimeInsightsModule,
    ThresholdModule,
    MeetingManagementModule,
    // ====== @route-section: business-modules END ======

    // ⚠️ @route-order: last
    // ViewModule is the fallback route module, must be registered last.
    ViewModule,
  ],
  providers: [
    DashboardDataSyncScheduler,
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
