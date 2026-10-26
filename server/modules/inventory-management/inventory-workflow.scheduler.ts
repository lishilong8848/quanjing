import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  InventoryWorkflowCode,
  InventoryWorkflowStatusResponse,
} from '../../../shared/inventory-management.interface';
import { readEnv } from '@server/common/config/external-services.config';
import { InventoryWorkflowService } from './inventory-workflow.service';

interface WorkflowDefinition {
  code: InventoryWorkflowCode;
  name: string;
  originalWorkflowId: string;
  triggerLabel: string;
  scheduleLabel: string;
  hour?: number;
  minute?: number;
  manualInboundReplaced?: boolean;
}

export const INVENTORY_WORKFLOW_DEFINITIONS: WorkflowDefinition[] = [
  {
    code: 'purchase_h',
    name: '采购新增（H） 新',
    originalWorkflowId: 'wkfEyMWQNPu1DzNY',
    triggerLabel: '每日定时',
    scheduleLabel: '每天 14:00',
    hour: 14,
    minute: 0,
    manualInboundReplaced: true,
  },
  {
    code: 'purchase_backfill',
    name: '采购入库自动补录',
    originalWorkflowId: 'wkfVO1VuyKNEpeUu',
    triggerLabel: '每日定时',
    scheduleLabel: '每天 15:55',
    hour: 15,
    minute: 55,
    manualInboundReplaced: true,
  },
  {
    code: 'purchase_abcde',
    name: '采购新增(abcde)',
    originalWorkflowId: 'wkfkDnGZxvnq9YEx',
    triggerLabel: '每日定时',
    scheduleLabel: '每天 17:48',
    hour: 17,
    minute: 48,
    manualInboundReplaced: true,
  },
  {
    code: 'item_confirmation',
    name: '物品确认',
    originalWorkflowId: 'wkfqrw3uP9Mo9Amg',
    triggerLabel: '新增出库增量扫描',
    scheduleLabel: '每 1 分钟',
  },
];

@Injectable()
export class InventoryWorkflowScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InventoryWorkflowScheduler.name);
  private readonly timers = new Map<InventoryWorkflowCode, NodeJS.Timeout>();
  private readonly nextRuns = new Map<InventoryWorkflowCode, Date>();
  private started = false;

  constructor(private readonly workflowService: InventoryWorkflowService) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      this.start();
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.isSwitchEnabled()) {
      this.logger.log('库存程序工作流尚未切换启用');
      return;
    }
    if (!validCutoverAt()) {
      this.logger.error('库存程序工作流未启动：缺少有效切换时间');
      return;
    }

    for (const definition of INVENTORY_WORKFLOW_DEFINITIONS) {
      if (definition.manualInboundReplaced) continue;
      if (definition.hour === undefined || definition.minute === undefined) continue;
      this.scheduleDaily(definition);
    }
    this.startItemConfirmationPoll();
    this.logger.log('库存程序工作流调度已启动');
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.nextRuns.clear();
  }

  async getStatus(): Promise<InventoryWorkflowStatusResponse> {
    const switchEnabled = this.isSwitchEnabled();
    const cutoverReady = validCutoverAt();
    let configured = true;
    let message = switchEnabled && !cutoverReady ? '缺少有效切换时间，自动调度未启动' : '';
    let recentLogs: InventoryWorkflowStatusResponse['recentLogs'] = [];
    try {
      recentLogs = await this.workflowService.listRecentLogs();
    } catch (error) {
      configured = false;
      message = safeMessage(error);
    }
    const enabled = switchEnabled && cutoverReady && configured;
    return {
      generatedAt: new Date().toISOString(),
      enabled,
      configured,
      source: 'program',
      workflows: INVENTORY_WORKFLOW_DEFINITIONS.map((definition) => {
        const workflowEnabled = enabled && !definition.manualInboundReplaced;
        return {
          code: definition.code,
          name: definition.name,
          originalWorkflowId: definition.originalWorkflowId,
          triggerLabel: definition.manualInboundReplaced
            ? '库房管理员办理'
            : definition.triggerLabel,
          scheduleLabel: definition.manualInboundReplaced
            ? '已改为库房人工确认'
            : definition.scheduleLabel,
          enabled: workflowEnabled,
          running:
            workflowEnabled && this.workflowService.isRunning(definition.code),
          nextRunAt: workflowEnabled
            ? this.nextRuns.get(definition.code)?.toISOString() || null
            : null,
          lastRun: this.workflowService.getLastRun(definition.code),
        };
      }),
      recentLogs,
      ...(message ? { message } : {}),
    };
  }

  private scheduleDaily(definition: WorkflowDefinition): void {
    const next = nextShanghaiDailyRunAt(
      new Date(),
      definition.hour as number,
      definition.minute as number,
    );
    this.nextRuns.set(definition.code, next);
    const timer = setTimeout(() => {
      void this.workflowService
        .run(definition.code, { trigger: 'schedule' })
        .finally(() => this.scheduleDaily(definition));
    }, Math.max(1_000, next.getTime() - Date.now()));
    timer.unref?.();
    this.replaceTimer(definition.code, timer);
  }

  private startItemConfirmationPoll(): void {
    const code: InventoryWorkflowCode = 'item_confirmation';
    const intervalMs = pollIntervalMs();
    const runAndReschedule = (): void => {
      void this.workflowService.run(code, { trigger: 'poll' }).finally(() => {
        const next = new Date(Date.now() + intervalMs);
        this.nextRuns.set(code, next);
        const timer = setTimeout(runAndReschedule, intervalMs);
        timer.unref?.();
        this.replaceTimer(code, timer);
      });
    };
    this.nextRuns.set(code, new Date());
    void this.workflowService.run(code, { trigger: 'startup' }).finally(() => {
      const next = new Date(Date.now() + intervalMs);
      this.nextRuns.set(code, next);
      const timer = setTimeout(runAndReschedule, intervalMs);
      timer.unref?.();
      this.replaceTimer(code, timer);
    });
  }

  private replaceTimer(code: InventoryWorkflowCode, timer: NodeJS.Timeout): void {
    const previous = this.timers.get(code);
    if (previous) clearTimeout(previous);
    this.timers.set(code, timer);
  }

  private isSwitchEnabled(): boolean {
    return ['1', 'true', 'yes', 'on'].includes(
      readEnv('FEISHU_WAREHOUSE_WORKFLOW_ENABLED').toLowerCase(),
    );
  }
}

export function nextShanghaiDailyRunAt(
  now: Date,
  hour: number,
  minute: number,
): Date {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  let target = new Date(
    Date.UTC(
      shanghai.getUTCFullYear(),
      shanghai.getUTCMonth(),
      shanghai.getUTCDate(),
      hour - 8,
      minute,
      0,
      0,
    ),
  );
  if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  }
  return target;
}

function pollIntervalMs(): number {
  const parsed = Number(readEnv('FEISHU_WAREHOUSE_WORKFLOW_POLL_INTERVAL_MS'));
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 60_000;
}

function validCutoverAt(): boolean {
  const value = readEnv('FEISHU_WAREHOUSE_WORKFLOW_CUTOVER_AT');
  return Boolean(value && !Number.isNaN(new Date(value).getTime()));
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : '库存工作流配置不可用';
}
