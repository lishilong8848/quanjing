import { Injectable, Logger } from '@nestjs/common';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';
import { DutyScreenshotService } from '@server/modules/duty-schedule/duty-screenshot.service';
import { resolveDutyDailyReportStateFilePath } from '@server/modules/duty-schedule/duty-daily-report-state-path';
import type { DutyDailyReportLocalTask } from '@server/modules/duty-schedule/duty-daily-report-local-scheduler.service';

interface CompletedDutyDailyReportTask {
  completedAt: string;
}

interface DutyDailyReportTaskState {
  version: 1;
  completed: Record<string, CompletedDutyDailyReportTask>;
}

@Injectable()
export class DutyDailyReportTaskCoordinatorService {
  private readonly logger = new Logger(
    DutyDailyReportTaskCoordinatorService.name,
  );
  private readonly activeTasks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dutyScreenshotService: DutyScreenshotService,
  ) {}

  run(task: DutyDailyReportLocalTask, date: string): Promise<unknown> {
    const taskKey = this.getTaskKey(task, date);
    const completed = this.readState().completed[taskKey];
    if (completed) {
      this.logger.log(
        `值班日报本地任务已完成，跳过重复执行：task=${task}, date=${date}`,
      );
      return Promise.resolve({
        success: true,
        skipped: true,
        task,
        date,
        completedAt: completed.completedAt,
      });
    }

    const active = this.activeTasks.get(taskKey);
    if (active) return active;

    let execution!: Promise<unknown>;
    execution = this.executeAndComplete(task, date, taskKey).finally(() => {
      if (this.activeTasks.get(taskKey) === execution) {
        this.activeTasks.delete(taskKey);
      }
    });
    this.activeTasks.set(taskKey, execution);
    return execution;
  }

  private async executeAndComplete(
    task: DutyDailyReportLocalTask,
    date: string,
    taskKey: string,
  ): Promise<unknown> {
    const result = await this.execute(task, date);
    this.markCompleted(taskKey);
    return result;
  }

  private async execute(
    task: DutyDailyReportLocalTask,
    date: string,
  ): Promise<unknown> {
    switch (task) {
      case 'white-screenshot':
        return this.dutyScreenshotService.captureAndSendDutyOverview({
          date,
          source: 'auto-08:50',
        });
      case 'night-screenshot':
        return this.dutyScreenshotService.captureAndSendDutyOverview({
          date,
          source: 'auto-17:50',
        });
    }
  }

  private getTaskKey(task: DutyDailyReportLocalTask, date: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`值班日报本地任务日期无效：${date}`);
    }
    return `${date}:${task}`;
  }

  private readState(): DutyDailyReportTaskState {
    const statePath = this.getStatePath();
    if (!existsSync(statePath)) {
      return { version: 1, completed: {} };
    }

    try {
      const parsed = JSON.parse(
        readFileSync(statePath, 'utf8'),
      ) as Partial<DutyDailyReportTaskState>;
      if (
        parsed.version === 1 &&
        parsed.completed &&
        typeof parsed.completed === 'object'
      ) {
        return {
          version: 1,
          completed: parsed.completed,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`读取值班日报本地任务状态失败，将重新执行：${message}`);
    }

    return { version: 1, completed: {} };
  }

  private markCompleted(taskKey: string): void {
    const state = this.readState();
    state.completed[taskKey] = {
      completedAt: new Date().toISOString(),
    };

    const statePath = this.getStatePath();
    mkdirSync(dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      renameSync(tempPath, statePath);
    } finally {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
  }

  private getStatePath(): string {
    return resolveDutyDailyReportStateFilePath({
      fileName: 'duty-daily-report-task-state.json',
      explicitPath: process.env.DUTY_DAILY_REPORT_TASK_STATE_PATH,
      configuredDirectory: process.env.DUTY_DAILY_REPORT_STATE_DIR,
    });
  }
}
