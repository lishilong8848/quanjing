import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { BitableSyncModule } from '@server/modules/bitable-sync/bitable-sync.module';
import { WeatherWarningBitableService } from './weather-warning-bitable.service';
import { WeatherWarningAutomationService } from './weather-warning-automation.service';
import { WeatherWarningController } from './weather-warning.controller';
import { WeatherWarningQueryController } from './weather-warning-query.controller';
import { WeatherWarningNotificationService } from './weather-warning-notification.service';
import { WeatherWarningRegistrationGateway } from './weather-warning-registration.gateway';
import { WeatherWarningRegistrationEnabledGuard } from './weather-warning-registration-enabled.guard';
import { WeatherWarningRegistrationService } from './weather-warning-registration.service';
import { WeatherWarningScheduler } from './weather-warning.scheduler';
import { WeatherWarningSnapshotService } from './weather-warning-snapshot.service';

@Module({
  imports: [
    HttpModule.register({ timeout: 30000, maxRedirects: 5 }),
    BitableSyncModule,
  ],
  controllers: [WeatherWarningController, WeatherWarningQueryController],
  providers: [
    WeatherWarningBitableService,
    WeatherWarningSnapshotService,
    WeatherWarningNotificationService,
    WeatherWarningAutomationService,
    WeatherWarningRegistrationGateway,
    WeatherWarningRegistrationEnabledGuard,
    WeatherWarningRegistrationService,
    WeatherWarningScheduler,
  ],
})
export class WeatherWarningModule {}
