import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { readEnv } from '../../common/config/external-services.config';
import { LeaveWorkflowService } from './leave-workflow.service';

@Injectable()
export class LeaveWorkflowScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaveWorkflowScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private recoveryCompleted = false;
  private taskRun: Promise<{ processed: number; failed: number }> | null = null;
  private taskRunRequested = false;
  private wakeHandle: NodeJS.Immediate | null = null;
  private stopped = false;

  constructor(private readonly service: LeaveWorkflowService) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      if (!this.service.isEnabled() || this.timer) return;
      this.stopped = false;
      this.service.setTaskWakeHandler(() => this.requestTaskRun());
      this.timer = setInterval(() => void this.poll(), readPollIntervalMs());
      this.timer.unref?.();
      this.requestTaskRun();
      void this.poll();
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.service.setTaskWakeHandler(null);
    if (this.wakeHandle) clearImmediate(this.wakeHandle);
    this.wakeHandle = null;
    await cancelHotfixInitialization(this);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runNow(): Promise<{ processed: number; failed: number }> {
    return this.runTaskBatch();
  }

  private requestTaskRun(): void {
    if (this.stopped) return;
    this.taskRunRequested = true;
    if (this.taskRun || this.wakeHandle) return;
    this.wakeHandle = setImmediate(() => {
      this.wakeHandle = null;
      void this.runTaskBatch().catch(error => {
        this.logger.error(`请休假受理任务唤醒失败，将由轮询重试：${safeError(error)}`);
      });
    });
  }

  private async runTaskBatch(): Promise<{ processed: number; failed: number }> {
    if (this.taskRun) {
      this.taskRunRequested = true;
      return this.taskRun;
    }
    this.taskRunRequested = false;
    const pending = this.service.runPendingTasks();
    this.taskRun = pending;
    try { return await pending; }
    finally {
      this.taskRun = null;
      if (this.taskRunRequested) this.requestTaskRun();
    }
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.recoveryCompleted) {
        try {
          const recovery = await this.service.recoverConfiguredApplications();
          this.recoveryCompleted = recovery.missingCodes.length === 0;
          if (recovery.requestedCodes.length > 0) {
            this.logger.log(
              `请休假启动恢复：新增 ${recovery.created} 条，已存在 ${recovery.existing} 条，未找到 ${recovery.missingCodes.length} 条`,
            );
          }
        } catch (error) {
          this.logger.error(
            `请休假启动恢复失败，将继续处理已受理任务：${safeError(error)}`,
          );
        }
      }
      if (!this.stopped) await this.runTaskBatch();
    } catch (error) {
      this.logger.error(`请休假程序审批后台任务轮询失败：${safeError(error)}`);
    } finally {
      this.running = false;
    }
  }
}

function readPollIntervalMs(): number {
  const value = Number(readEnv('LEAVE_WORKFLOW_TASK_POLL_INTERVAL_MS'));
  return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : 5_000;
}

function safeError(error: unknown): string {
  const value =
    error instanceof Error ? error.message : String(error || 'unknown error');
  return value.replace(/[\r\n\t]/gu, ' ').slice(0, 300);
}
