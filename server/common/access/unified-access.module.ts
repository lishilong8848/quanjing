import { HttpModule } from '@nestjs/axios';
import {
  type MiddlewareConsumer,
  Global,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  ACCESS_LOGIN_MIDDLEWARE_PATH,
  AccessLoginRedactionMiddleware,
} from './access-login-redaction.middleware';
import { FeishuAccessService } from './feishu-access.service';
import { UnifiedAccessController } from './unified-access.controller';
import { UnifiedAccessGuard } from './unified-access.guard';
import { UnifiedAccessService } from './unified-access.service';
import { AccessConfigurationService } from './access-configuration.service';
import { AccessConfigurationController } from './access-configuration.controller';
import { AccessConfigurationDirectory } from './access-configuration.directory';
import { AccessConfigurationCardDirectory } from './access-configuration.card-directory';
import { AccessPersonnelSyncService } from './access-personnel-sync.service';
import { PersonnelPreviewService } from './personnel-preview.service';
import { PersonnelHandoverAdminService } from './personnel-handover.admin.service';
import { PersonnelSourceService } from './personnel-source.service';
import { PersonnelBaselineService } from './personnel-baseline.service';
import { PersonnelBaselineDirectory } from './personnel-baseline.directory';
import { PERSONNEL_BASELINE_READER } from './personnel-baseline.reader';

import { AccessLoginNamesService } from './access-login-names.service';

@Global()
@Module({
  imports: [ConfigModule.forRoot({ ignoreEnvFile: true }), HttpModule],
  controllers: [UnifiedAccessController, AccessConfigurationController],
  providers: [
    AccessLoginNamesService,
    AccessConfigurationService,
    AccessConfigurationDirectory,
    AccessConfigurationCardDirectory,
    AccessPersonnelSyncService,
    PersonnelPreviewService,
    PersonnelHandoverAdminService,
    PersonnelSourceService,
    PersonnelBaselineService,
    PersonnelBaselineDirectory,
    {provide:PERSONNEL_BASELINE_READER,useExisting:PersonnelBaselineDirectory},
    UnifiedAccessService,
    FeishuAccessService,
    UnifiedAccessGuard,
    {
      provide: APP_GUARD,
      useExisting: UnifiedAccessGuard,
    },
  ],
  exports: [UnifiedAccessService, FeishuAccessService, AccessConfigurationService],
})
export class UnifiedAccessModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AccessLoginRedactionMiddleware).forRoutes({
      path: ACCESS_LOGIN_MIDDLEWARE_PATH,
      method: RequestMethod.POST,
    }, { path: 'api/access/configuration/accounts', method: RequestMethod.POST });
  }
}
