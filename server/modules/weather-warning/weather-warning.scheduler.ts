import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { WeatherWarningAutomationService } from './weather-warning-automation.service';
import { loadWeatherWarningAutomationConfig } from './weather-warning-automation.config';

@Injectable()
export class WeatherWarningScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WeatherWarningScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private started = false;

  constructor(
    private readonly weatherWarningAutomationService: WeatherWarningAutomationService,
  ) {}

  onModuleInit(): void {
    if (this.started) return;

    let config;
    try {
      config = loadWeatherWarningAutomationConfig();
    } catch {
      this.logger.error('天气预警自动通知配置无效，调度未启动');
      return;
    }
    if (!config.enabled) return;

    this.started = true;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), config.pollIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.weatherWarningAutomationService.runDue(
        new Date(),
      );
      if (result.failedCount > 0) {
        this.logger.warn(
          `天气预警自动通知有 ${result.failedCount} 个目标发送失败，将在下次轮询重试`,
        );
      }
    } catch {
      this.logger.error('天气预警自动通知执行失败，将在下次轮询重试');
    } finally {
      this.running = false;
    }
  }
}
