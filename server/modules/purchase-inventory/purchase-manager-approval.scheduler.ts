import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { readEnv } from '../../common/config/external-services.config';
import {
  PurchaseManagerApprovalService,
  type PurchaseManagerApprovalTaskRunResult,
} from './purchase-manager-approval.service';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 1_000;

@Injectable()
export class PurchaseManagerApprovalScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PurchaseManagerApprovalScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private runInProgress = false;

  constructor(private readonly service: PurchaseManagerApprovalService) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      if (!this.service.isEnabled() || this.timer) return;
      this.timer = setInterval(() => {
        void this.poll();
      }, readPollIntervalMs());
      this.timer.unref?.();
      void this.poll();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async run(): Promise<PurchaseManagerApprovalTaskRunResult> {
    if (this.runInProgress) {
      throw new ConflictException('采购经理审批后台任务正在运行');
    }
    this.runInProgress = true;
    try {
      return await this.service.runPendingTasks();
    } finally {
      this.runInProgress = false;
    }
  }

  private async poll(): Promise<void> {
    if (this.runInProgress || !this.service.isEnabled()) return;
    try {
      const result = await this.run();
      if (
        result.failed > 0 ||
        result.manualReconciliation > 0 ||
        result.alerts.length > 0
      ) {
        this.logger.warn(
          `采购经理审批后台任务需要关注：失败 ${result.failed}，人工核对 ${result.manualReconciliation}，告警 ${result.alerts.length}`,
        );
      }
    } catch {
      this.logger.error('采购经理审批后台任务执行失败');
    }
  }
}

function readPollIntervalMs(): number {
  const configured = Number(
    readEnv('PURCHASE_MANAGER_APPROVAL_TASK_POLL_INTERVAL_MS'),
  );
  return Number.isFinite(configured) && configured >= MIN_POLL_INTERVAL_MS
    ? Math.floor(configured)
    : DEFAULT_POLL_INTERVAL_MS;
}
