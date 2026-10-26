import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AliMonthlyReportController } from './ali-monthly-report.controller';
import { AliMonthlyReportScheduler } from './ali-monthly-report.scheduler';
import { AliMonthlyReportService } from './ali-monthly-report.service';
import { AliMonthlyReportTaskCoordinatorService } from './ali-monthly-report-task-coordinator.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 5,
    }),
  ],
  controllers: [AliMonthlyReportController],
  providers: [
    AliMonthlyReportService,
    AliMonthlyReportTaskCoordinatorService,
    AliMonthlyReportScheduler,
  ],
})
export class AliMonthlyReportModule {}
