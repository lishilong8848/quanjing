import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  ContractWorkflowCode,
  ContractWorkflowStatusResponse,
} from '../../../shared/contract-management.interface';
import { readEnv } from '../../common/config/external-services.config';
import { ContractWorkflowService } from './contract-workflow.service';

interface WorkflowDefinition {
  code: ContractWorkflowCode;
  name: string;
  originalWorkflowId: string;
  triggerLabel: string;
  scheduleLabel: string;
  hour?: number;
  minute?: number;
  weekday?: number;
}

export const CONTRACT_WORKFLOW_DEFINITIONS: WorkflowDefinition[] = [
  {
    code: 'payment_due_reminder',
    name: 'b-付款到期提醒',
    originalWorkflowId: 'wkfwVgO2CVm8QP5W',
    triggerLabel: '计划付款日期前 1 天',
    scheduleLabel: '每天 09:00',
    hour: 9,
    minute: 0,
  },
  {
    code: 'contract_expiry_reminder',
    name: 'c-合同到期提醒',
    originalWorkflowId: 'wkfgswSXFvoRJcad',
    triggerLabel: '合同结束日期前 1 天',
    scheduleLabel: '每周一 09:30',
    hour: 9,
    minute: 30,
    weekday: 1,
  },
];

@Injectable()
export class ContractWorkflowScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ContractWorkflowScheduler.name);
  private readonly timers = new Map<ContractWorkflowCode, NodeJS.Timeout>();
  private readonly nextRuns = new Map<ContractWorkflowCode, Date>();
  private started = false;

  constructor(private readonly service: ContractWorkflowService) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      this.start();
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.enabled()) {
      this.logger.log('合同程序工作流已由配置关闭；多维表工作流未变更');
      return;
    }
    for (const definition of CONTRACT_WORKFLOW_DEFINITIONS) {
      if (definition.hour === undefined || definition.minute === undefined)
        continue;
      if (definition.weekday === undefined) {
        this.scheduleDaily(definition);
      } else {
        this.scheduleWeekly(definition);
      }
    }
    this.logger.log('合同程序工作流已启动；未调用多维表工作流启停接口');
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.nextRuns.clear();
  }

  async getStatus(): Promise<ContractWorkflowStatusResponse> {
    const enabled = this.enabled();
    let configured = true;
    let message = enabled
      ? '程序工作流已运行；多维表原工作流保持原状态，若两边同时命中可能各发送一次'
      : '程序工作流已关闭；多维表原工作流保持原状态';
    let recentLogs: ContractWorkflowStatusResponse['recentLogs'] = [];
    try {
      recentLogs = await this.service.listRecentLogs();
    } catch (error) {
      configured = false;
      message = safeMessage(error);
    }
    return {
      generatedAt: new Date().toISOString(),
      enabled: enabled && configured,
      configured,
      source: 'program',
      baseWorkflowsUntouched: true,
      message,
      workflows: CONTRACT_WORKFLOW_DEFINITIONS.map((definition) => ({
        code: definition.code,
        name: definition.name,
        originalWorkflowId: definition.originalWorkflowId,
        triggerLabel: definition.triggerLabel,
        scheduleLabel: definition.scheduleLabel,
        enabled: enabled && configured,
        running: this.service.isRunning(definition.code),
        nextRunAt: this.nextRuns.get(definition.code)?.toISOString() || null,
        lastRun: this.service.getLastRun(definition.code),
      })),
      recentLogs,
    };
  }

  private scheduleDaily(definition: WorkflowDefinition): void {
    const next = nextShanghaiDailyRunAt(
      new Date(),
      definition.hour as number,
      definition.minute as number,
    );
    this.nextRuns.set(definition.code, next);
    const timer = setTimeout(
      () => {
        void this.service
          .run(definition.code, { trigger: 'schedule' })
          .catch(() => undefined)
          .finally(() => this.scheduleDaily(definition));
      },
      Math.max(1_000, next.getTime() - Date.now()),
    );
    timer.unref?.();
    this.replaceTimer(definition.code, timer);
  }

  private scheduleWeekly(definition: WorkflowDefinition): void {
    const next = nextShanghaiWeeklyRunAt(
      new Date(),
      definition.weekday as number,
      definition.hour as number,
      definition.minute as number,
    );
    this.nextRuns.set(definition.code, next);
    const timer = setTimeout(
      () => {
        void this.service
          .run(definition.code, { trigger: 'schedule' })
          .catch(() => undefined)
          .finally(() => this.scheduleWeekly(definition));
      },
      Math.max(1_000, next.getTime() - Date.now()),
    );
    timer.unref?.();
    this.replaceTimer(definition.code, timer);
  }

  private replaceTimer(
    code: ContractWorkflowCode,
    timer: NodeJS.Timeout,
  ): void {
    const previous = this.timers.get(code);
    if (previous) clearTimeout(previous);
    this.timers.set(code, timer);
  }

  private enabled(): boolean {
    const value = readEnv('FEISHU_CONTRACT_WORKFLOW_ENABLED').toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(value);
  }
}

export function nextShanghaiDailyRunAt(
  now: Date,
  hour: number,
  minute: number,
): Date {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
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
    target = new Date(target.getTime() + 24 * 60 * 60 * 1_000);
  }
  return target;
}

export function nextShanghaiWeeklyRunAt(
  now: Date,
  weekday: number,
  hour: number,
  minute: number,
): Date {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  const delta = (weekday - shanghai.getUTCDay() + 7) % 7;
  let target = new Date(
    Date.UTC(
      shanghai.getUTCFullYear(),
      shanghai.getUTCMonth(),
      shanghai.getUTCDate() + delta,
      hour - 8,
      minute,
      0,
      0,
    ),
  );
  if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 7 * 24 * 60 * 60 * 1_000);
  }
  return target;
}

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 300)
    : '合同工作流状态读取失败';
}
