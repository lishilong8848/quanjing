import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { resolve } from 'node:path';
import { BitableSyncModule } from '../bitable-sync/bitable-sync.module';
import { SystemMonthlyReportController } from './system-monthly-report.controller';
import { SystemMonthlyReportGateway } from './system-monthly-report.gateway';
import { SystemMonthlyReportService } from './system-monthly-report.service';
import { SystemMonthlyReportArchiveService } from './system-monthly-report-archive.service';
import { SystemMonthlyReportPackageService } from './system-monthly-report-package.service';
import {
  SYSTEM_MONTHLY_REPORT_IDENTITY_STORE,
  SystemMonthlyReportIdentityService,
} from './system-monthly-report-identity.service';
import { SystemMonthlyReportIdentityStore } from './system-monthly-report-identity.store';

@Module({
  imports: [
    HttpModule.register({ timeout: 60_000, maxRedirects: 5 }),
    BitableSyncModule,
  ],
  controllers: [SystemMonthlyReportController],
  providers: [
    SystemMonthlyReportGateway,
    SystemMonthlyReportArchiveService,
    SystemMonthlyReportPackageService,
    SystemMonthlyReportIdentityService,
    {
      provide: SYSTEM_MONTHLY_REPORT_IDENTITY_STORE,
      useFactory: () => {
        const runtimeDirectory = resolve(
          process.env.SYSTEM_MONTHLY_REPORT_RUNTIME_DIR ||
            resolve(process.cwd(), '.runtime', 'system-monthly-report'),
        );
        return new SystemMonthlyReportIdentityStore(
          resolve(runtimeDirectory, 'identity-sessions.json'),
        );
      },
    },
    SystemMonthlyReportService,
  ],
})
export class SystemMonthlyReportModule {}
