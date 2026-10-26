import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type {
  PurchaseWorkflowOperationalStatus,
  PurchaseWorkflowReminderCode,
  PurchaseWorkflowReminderRunResult,
} from '../../../shared/purchase-workflow.interface';
import { readEnv } from '../../common/config/external-services.config';
import { PurchaseWorkflowService } from './purchase-workflow.service';
import { WarehouseInboundHandoverService } from './warehouse-inbound-handover.service';
import { PurchaseWorkflowReceiptTaskService } from './purchase-workflow-receipt-task.service';

const CODES: PurchaseWorkflowReminderCode[] = ['warehouse', 'order', 'receipt'];
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const ALTERNATING_ANCHOR = Date.UTC(2026, 1, 2, 16, 0, 0);
const WAREHOUSE_RECIPIENT_CACHE_CHECK_MS = 60 * 60 * 1_000;

@Injectable()
export class PurchaseWorkflowScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PurchaseWorkflowScheduler.name);
  private readonly timers = new Map<
    PurchaseWorkflowReminderCode,
    NodeJS.Timeout
  >();
  private readonly running = new Set<PurchaseWorkflowReminderCode>();
  private readonly nextRuns = new Map<PurchaseWorkflowReminderCode, Date>();
  private readonly lastRuns = new Map<
    PurchaseWorkflowReminderCode,
    PurchaseWorkflowReminderRunResult
  >();
  private taskTimer: NodeJS.Timeout | null = null;
  private recipientCacheTimer: NodeJS.Timeout | null = null;
  private taskRunInProgress = false;

  constructor(
    private readonly service: PurchaseWorkflowService,
    private readonly warehouseHandovers: WarehouseInboundHandoverService,
    private readonly receiptTasks: PurchaseWorkflowReceiptTaskService,
  ) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      if (this.service.isEnabled()) {
        for (const code of CODES) this.schedule(code);
      }
      this.schedulePendingTasks();
      void this.pollPendingTasks();
      void this.refreshWarehouseRecipientCache();
      this.recipientCacheTimer = setInterval(() => {
        void this.refreshWarehouseRecipientCache();
      }, WAREHOUSE_RECIPIENT_CACHE_CHECK_MS);
      this.recipientCacheTimer.unref?.();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.nextRuns.clear();
    if (this.taskTimer) clearInterval(this.taskTimer);
    this.taskTimer = null;
    if (this.recipientCacheTimer) clearInterval(this.recipientCacheTimer);
    this.recipientCacheTimer = null;
  }

  async run(
    code: PurchaseWorkflowReminderCode,
  ): Promise<PurchaseWorkflowReminderRunResult> {
    if (this.running.has(code)) {
      throw new ConflictException(`采购提醒 ${code} 正在运行`);
    }
    this.running.add(code);
    try {
      const result = await this.service.runReminders(code);
      this.lastRuns.set(code, result);
      return result;
    } finally {
      this.running.delete(code);
    }
  }

  getStatus(): PurchaseWorkflowOperationalStatus {
    const enabled = this.service.isEnabled();
    return {
      enabled,
      disabledReason: enabled ? '' : '程序工作流尚未接管，提醒调度未启动',
      nextRuns: CODES.map((code) => ({
        code,
        at: this.nextRuns.get(code)?.toISOString() || '',
      })),
      recentRuns: [...this.lastRuns.values()]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .map(({ code, startedAt, finishedAt, processed, failed }) => ({
          code,
          startedAt,
          finishedAt,
          processed,
          failed,
        })),
    };
  }

  private schedule(code: PurchaseWorkflowReminderCode): void {
    const nextRun = nextPurchaseReminderRun(code, new Date());
    this.nextRuns.set(code, nextRun);
    const delay = Math.max(1000, nextRun.getTime() - Date.now());
    const timer = setTimeout(async () => {
      try {
        await this.run(code);
      } catch (error) {
        this.logger.error(`采购提醒 ${code} 执行失败`, error);
      } finally {
        if (this.service.isEnabled()) this.schedule(code);
      }
    }, delay);
    timer.unref?.();
    const previous = this.timers.get(code);
    if (previous) clearTimeout(previous);
    this.timers.set(code, timer);
  }

  private schedulePendingTasks(): void {
    const configured = Number(
      readEnv('PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS'),
    );
    const intervalMs =
      Number.isFinite(configured) && configured >= 1_000
        ? Math.floor(configured)
        : 5_000;
    this.taskTimer = setInterval(() => {
      void this.pollPendingTasks();
    }, intervalMs);
    this.taskTimer.unref?.();
  }

  private async pollPendingTasks(): Promise<void> {
    if (this.taskRunInProgress) return;
    this.taskRunInProgress = true;
    try {
      await this.warehouseHandovers.runPending();
      await this.receiptTasks.runPendingTasks();
      await this.service.runPendingTasks();
    } catch (error) {
      this.logger.error('采购工作流后台任务执行失败', error);
    } finally {
      this.taskRunInProgress = false;
    }
  }

  private async refreshWarehouseRecipientCache(): Promise<void> {
    try {
      await this.service.refreshWarehouseRecipientCacheIfDue();
    } catch (error) {
      this.logger.warn(`库房收件人同步失败：${String(error)}`);
    }
  }
}

export function nextPurchaseReminderRun(
  code: PurchaseWorkflowReminderCode,
  now: Date,
): Date {
  const time =
    code === 'order' ? [10, 0] : code === 'receipt' ? [11, 30] : [11, 0];
  let localMidnight = localDayStartUtc(now);
  for (let day = 0; day < 370; day += 1) {
    const candidateLocalMidnight = localMidnight + day * 24 * 60 * 60 * 1000;
    if (
      code !== 'warehouse' &&
      Math.round(
        (candidateLocalMidnight - ALTERNATING_ANCHOR) / (24 * 60 * 60 * 1000),
      ) %
        2 !==
        0
    ) {
      continue;
    }
    const candidate = new Date(
      candidateLocalMidnight + time[0] * 60 * 60 * 1000 + time[1] * 60 * 1000,
    );
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  throw new Error('无法计算采购提醒下次运行时间');
}

function localDayStartUtc(now: Date): number {
  const shanghai = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return (
    Date.UTC(
      shanghai.getUTCFullYear(),
      shanghai.getUTCMonth(),
      shanghai.getUTCDate(),
    ) - SHANGHAI_OFFSET_MS
  );
}
