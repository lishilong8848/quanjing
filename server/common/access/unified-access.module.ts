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
import { PersonnelAccountController } from './personnel-account.controller';
import { PersonnelCredentialsService } from './personnel-credentials.service';
import { PersonnelCredentialsGateway } from './personnel-credentials.gateway';
import { PersonnelSecurityStore } from './personnel-security.store';
import { PersonnelPermissionRequestsService } from './personnel-permission-requests.service';
import { PersonnelPermissionNotificationsService } from './personnel-permission-notifications.service';
import { PersonnelArchiveService } from './personnel-archive.service';
import { PersonnelArchiveGateway } from './personnel-archive.gateway';
import { PersonnelArchiveCorrectionsService } from './personnel-archive-corrections.service';

@Global()
@Module({
  imports: [ConfigModule.forRoot({ ignoreEnvFile: true }), HttpModule],
  controllers: [UnifiedAccessController, AccessConfigurationController, PersonnelAccountController],
  providers: [
    PersonnelArchiveService,
    PersonnelArchiveGateway,
    PersonnelCredentialsService,
    PersonnelCredentialsGateway,
    PersonnelSecurityStore,
    PersonnelPermissionRequestsService,
    PersonnelPermissionNotificationsService,
    PersonnelArchiveCorrectionsService,
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
  exports: [UnifiedAccessService, FeishuAccessService, AccessConfigurationService, AccessConfigurationDirectory],
})
export class UnifiedAccessModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AccessLoginRedactionMiddleware).forRoutes({
      path: ACCESS_LOGIN_MIDDLEWARE_PATH,
      method: RequestMethod.POST,
    }, { path: 'api/access/configuration/accounts', method: RequestMethod.POST },
    { path: 'api/access/personal/password/change', method: RequestMethod.POST },
    { path: 'api/access/personal/password/reset', method: RequestMethod.POST },
    { path: 'api/access/personal/permission-requests', method: RequestMethod.POST },
    { path: 'api/access/personal/permission-requests/update', method: RequestMethod.POST },
    { path: 'api/access/personal/permission-requests/cancel', method: RequestMethod.POST },
    { path: 'api/access/configuration/permission-requests', method: RequestMethod.POST },
    { path: 'api/access/personal/archive-corrections', method: RequestMethod.POST },
    { path: 'api/access/personal/archive-corrections/cancel', method: RequestMethod.POST },
    { path: 'api/access/configuration/archive-corrections', method: RequestMethod.POST },
    { path: 'api/ali-monthly-report/email-settings', method: RequestMethod.POST });
  }
}
