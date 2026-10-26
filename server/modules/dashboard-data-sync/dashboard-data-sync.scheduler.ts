import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CertificateDashboardService } from '../bitable-sync/certificate-dashboard.service';
import { TrainingDashboardService } from '../bitable-sync/training-dashboard.service';
import { EquipmentLifecycleService } from '../equipment-lifecycle/equipment-lifecycle.service';
import { RiskInspectionService } from '../risk-inspection/risk-inspection.service';

const SYNC_HOUR = 3;
const SYNC_MINUTE = 10;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

@Injectable()
export class DashboardDataSyncScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DashboardDataSyncScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private activeSync: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly trainingService: TrainingDashboardService,
    private readonly riskService: RiskInspectionService,
    private readonly lifecycleService: EquipmentLifecycleService,
    private readonly certificateService: CertificateDashboardService,
  ) {}

  onModuleInit(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleNext();
    if (shouldCatchUpDashboardDataSync(new Date())) {
      void this.syncNow();
    }
  }

  onModuleDestroy(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  syncNow(): Promise<void> {
    if (this.activeSync) return this.activeSync;

    let sync!: Promise<void>;
    sync = this.runAllSyncTasks().finally(() => {
      if (this.activeSync === sync) {
        this.activeSync = null;
      }
    });
    this.activeSync = sync;
    return sync;
  }

  private async runAllSyncTasks(): Promise<void> {
    await Promise.all([
      this.runSafely('培训看板', () => this.trainingService.refresh()),
      this.runSafely('风险看板-Ali', () =>
        this.riskService.getAliDashboard({ refresh: '1' }),
      ),
      this.runSafely('风险看板-交叉互查', () =>
        this.riskService.getCrossDashboard({ refresh: '1' }),
      ),
      this.runSafely('生命周期看板', () =>
        this.lifecycleService.getDashboard(true),
      ),
      this.runSafely('持证看板', () => this.certificateService.refresh()),
    ]);
  }

  private async runSafely(
    dashboardName: string,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await operation();
    } catch {
      this.logger.warn(`${dashboardName} 03:10 自动同步失败`);
    }
  }

  private scheduleNext(): void {
    const nextRun = nextDashboardDataSyncRunAt(new Date());
    const timer = setTimeout(
      () => {
        this.timer = null;
        void this.syncNow().finally(() => {
          if (this.started) this.scheduleNext();
        });
      },
      Math.max(1_000, nextRun.getTime() - Date.now()),
    );
    timer.unref?.();

    if (this.timer) clearTimeout(this.timer);
    this.timer = timer;
  }
}

export function nextDashboardDataSyncRunAt(now: Date): Date {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  let target = new Date(
    Date.UTC(
      shanghaiNow.getUTCFullYear(),
      shanghaiNow.getUTCMonth(),
      shanghaiNow.getUTCDate(),
      SYNC_HOUR,
      SYNC_MINUTE,
      0,
      0,
    ) - SHANGHAI_OFFSET_MS,
  );
  if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + ONE_DAY_MS);
  }
  return target;
}

export function shouldCatchUpDashboardDataSync(now: Date): boolean {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const minutesSinceMidnight =
    shanghaiNow.getUTCHours() * 60 + shanghaiNow.getUTCMinutes();
  return minutesSinceMidnight >= SYNC_HOUR * 60 + SYNC_MINUTE;
}
