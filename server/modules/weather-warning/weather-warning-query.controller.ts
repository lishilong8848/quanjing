import { Controller, Get, Header } from '@nestjs/common';
import { GuestReadable } from '@server/common/access/unified-access.decorators';
import { buildWeatherWarningExternalContract } from './weather-warning-external-contract';
import { WeatherWarningSnapshotService } from './weather-warning-snapshot.service';

@Controller('api/weather')
export class WeatherWarningQueryController {
  constructor(
    private readonly weatherWarningSnapshotService: WeatherWarningSnapshotService,
  ) {}

  @GuestReadable()
  @Get('warning')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getWarning() {
    const snapshot = await this.weatherWarningSnapshotService.getSnapshot({
      includeCheckProgress: false,
    });
    return buildWeatherWarningExternalContract(snapshot);
  }
}
