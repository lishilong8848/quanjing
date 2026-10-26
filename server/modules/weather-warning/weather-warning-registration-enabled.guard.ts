import {
  Injectable,
  ServiceUnavailableException,
  type CanActivate,
} from '@nestjs/common';
import { loadWeatherWarningFeatureConfig } from './weather-warning-feature.config';

@Injectable()
export class WeatherWarningRegistrationEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!loadWeatherWarningFeatureConfig().registrationEnabled) {
      throw new ServiceUnavailableException(
        '天气预警戒备登记已暂停，请在指定的其他应用完成',
      );
    }
    return true;
  }
}
