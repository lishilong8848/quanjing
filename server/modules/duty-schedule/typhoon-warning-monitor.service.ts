import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { readEnv } from '@server/common/config/external-services.config';
import { DutyScheduleAutomationService } from '@server/modules/duty-schedule/duty-schedule.automation';

@Injectable()
export class TyphoonWarningMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TyphoonWarningMonitorService.name);
  private monitorTimer?: NodeJS.Timeout;
  private started = false;

  constructor(
    private readonly dutyScheduleAutomationService: DutyScheduleAutomationService,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (!this.isEnabled()) {
      this.logger.log('本地台风预警监控已禁用');
      return;
    }

    const intervalMs = this.getPollIntervalMs();
    this.logger.log(`启动本地台风预警监控：启动时立即检查，之后每 ${intervalMs / 60_000} 分钟检查一次`);
    void this.runLocalTyphoonWarningMonitor('startup');

    this.monitorTimer = setInterval(() => {
      void this.runLocalTyphoonWarningMonitor('interval');
    }, intervalMs);
    this.monitorTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (!this.monitorTimer) return;
    clearInterval(this.monitorTimer);
    this.monitorTimer = undefined;
  }

  private async runLocalTyphoonWarningMonitor(trigger: 'startup' | 'interval'): Promise<void> {
    try {
      const result = await this.dutyScheduleAutomationService
        .monitorTyphoonWarningAndSendPathScreenshot({
          source: 'auto-typhoon-warning',
        });
      const detail = result.warning?.title || result.reason || result.message;
      if (result.sent) {
        this.logger.log(`本地台风预警监控已发送截图：trigger=${trigger}, warning=${detail}`);
      } else {
        this.logger.log(`本地台风预警监控检查完成：trigger=${trigger}, result=${detail}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`本地台风预警监控失败：trigger=${trigger}, error=${message}`);
    }
  }

  private isEnabled(): boolean {
    const configured = readEnv('TYPHOON_WARNING_LOCAL_MONITOR_ENABLED', [
      'DUTY_TYPHOON_WARNING_LOCAL_MONITOR_ENABLED',
    ]).trim().toLowerCase();
    if (configured) {
      return !['0', 'false', 'off', 'no'].includes(configured);
    }
    return process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS === 'true';
  }

  private getPollIntervalMs(): number {
    const configured = Number.parseInt(readEnv('TYPHOON_WARNING_POLL_INTERVAL_MS', [
      'DUTY_TYPHOON_WARNING_POLL_INTERVAL_MS',
    ]), 10);
    return Number.isFinite(configured) && configured >= 60_000
      ? configured
      : 30 * 60 * 1000;
  }
}
