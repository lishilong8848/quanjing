import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { readEnv } from '../../common/config/external-services.config';
import { InventoryOutboundApprovalService } from './inventory-outbound-approval.service';

@Injectable()
export class InventoryOutboundApprovalScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InventoryOutboundApprovalScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRecoveryAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly service: InventoryOutboundApprovalService) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      if (this.timer) return;
      if (!this.service.isEnabled()) {
        this.logger.log('出库审批工作流未配置，后台调度未启动');
        return;
      }
      this.timer = setInterval(() => void this.poll(), readPollIntervalMs());
      this.timer.unref?.();
      void this.poll();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runNow(): Promise<{ processed: number; failed: number }> {
    await this.service.recoverFromBase();
    this.lastRecoveryAt = Date.now();
    return this.service.runPending();
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      if (now - this.lastRecoveryAt >= readRecoveryIntervalMs()) {
        await this.service.runPending();
        this.lastRecoveryAt = now;
        try {
          await this.service.recoverFromBase();
        } catch (error) {
          this.logger.error(`出库审批多维恢复扫描失败：${safeError(error)}`);
        }
        return;
      }
      await this.service.runPending();
    } catch (error) {
      this.logger.error(`出库审批后台任务轮询失败：${safeError(error)}`);
    } finally {
      this.running = false;
    }
  }
}

function readPollIntervalMs(): number {
  const value = Number(
    readEnv('INVENTORY_OUTBOUND_APPROVAL_TASK_POLL_INTERVAL_MS'),
  );
  return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : 5_000;
}

function readRecoveryIntervalMs(): number {
  const value = Number(
    readEnv('INVENTORY_OUTBOUND_APPROVAL_RECOVERY_INTERVAL_MS'),
  );
  return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : 60_000;
}

function safeError(error: unknown): string {
  const value =
    error instanceof Error ? error.message : String(error || 'unknown error');
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(/\b(secret|token|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/[\r\n\t]/gu, ' ')
    .slice(0, 300);
}
