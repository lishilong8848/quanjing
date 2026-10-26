import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { Automation, BindTrigger } from '@lark-apaas/fullstack-nestjs-core';
import { DutyScheduleService } from '@server/modules/duty-schedule/duty-schedule.service';
import { BitableSyncService } from '@server/modules/bitable-sync/bitable-sync.service';
import { DutyScreenshotService } from '@server/modules/duty-schedule/duty-screenshot.service';
import { DutyDailyReportTaskCoordinatorService } from '@server/modules/duty-schedule/duty-daily-report-task-coordinator.service';
import { getShanghaiDutyDateKey } from '@server/modules/duty-schedule/duty-daily-report-local-scheduler.service';
import { getDutyProgramModifiedRefreshWindow } from '@server/modules/duty-schedule/duty-staff-actual-refresh-window';
import {
  buildForcedTyphoonPathDeliveryKey,
  buildTyphoonPathWarningDeliveryKey,
  buildTyphoonWarningSendState,
  decideTyphoonPathScreenshotSend,
  findActiveTyphoonWarning,
  type TyphoonWarningLevel,
  type TyphoonWarningSendState,
} from '@server/modules/duty-schedule/typhoon-warning-alert';
import {
  acquireTyphoonWarningMonitorLease,
  readTyphoonWarningSendStateFile,
  writeTyphoonWarningSendStateFile,
  type TyphoonWarningMonitorLease,
} from '@server/modules/duty-schedule/typhoon-warning-state-store';
import type { TyphoonPathGroupScreenshotResponse } from '@shared/api.interface';

type LocalSyncSource = 'manual' | 'auto-4h';
type TyphoonWarningMonitorSource = 'manual' | 'auto-typhoon-warning';
interface TyphoonWarningMonitorOptions {
  source?: TyphoonWarningMonitorSource;
  expectedWarningKey?: string;
}
type LocalSyncResult = {
  success?: boolean;
  message?: string;
};

@Injectable()
@Automation()
export class DutyScheduleAutomationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DutyScheduleAutomationService.name);
  private typhoonWarningMonitorInFlight = false;
  private readonly forcedTyphoonPathSendsInFlight = new Map<
    string,
    Promise<TyphoonPathGroupScreenshotResponse>
  >();
  private startupProgramModifiedRefreshScheduled = false;
  private startupProgramModifiedRefreshTimer?: ReturnType<typeof setTimeout>;
  private startupProgramModifiedRefreshWork?: Promise<void>;
  private programModifiedDutyStaffRefreshInFlight?: ReturnType<
    DutyScheduleService['refreshProgramModifiedDutyStaffFromRules']
  >;

  constructor(
    private readonly dutyScheduleService: DutyScheduleService,
    private readonly bitableSyncService: BitableSyncService,
    private readonly dutyScreenshotService: DutyScreenshotService,
    private readonly dutyDailyReportTaskCoordinatorService: DutyDailyReportTaskCoordinatorService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    return runHotfixInitialization(this, () => {
    if (
      /^(?:1|true|on|yes)$/iu.test(process.env.NANTONG_HOTFIX_SMOKE_MODE || '')
    ) {
      this.logger.log('热包烟雾验证模式：跳过启动排班程序修改字段补偿');
      return;
    }
    if (this.startupProgramModifiedRefreshScheduled) {
      return;
    }
    this.startupProgramModifiedRefreshScheduled = true;

    const timer = setTimeout(() => {
      this.startupProgramModifiedRefreshTimer = undefined;
      this.startupProgramModifiedRefreshWork = this.runProgramModifiedDutyStaffRefresh({ source: 'startup' })
        .then((result) => {
          this.logger.log(
            `启动排班程序修改字段补偿完成：${result.message || '刷新完成'}`,
          );
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error(`启动排班程序修改字段补偿失败：${message}`);
        });
    }, 0);
    this.startupProgramModifiedRefreshTimer = timer;
    timer.unref?.();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    if (this.startupProgramModifiedRefreshTimer) clearTimeout(this.startupProgramModifiedRefreshTimer);
    this.startupProgramModifiedRefreshTimer = undefined;
    await this.startupProgramModifiedRefreshWork;
    await this.programModifiedDutyStaffRefreshInFlight;
  }

  async monitorTyphoonWarningAndSendPathScreenshot(
    options: TyphoonWarningMonitorOptions = {},
  ) {
    const source = options.source || 'manual';
    if (this.typhoonWarningMonitorInFlight) {
      return {
        success: true,
        sent: false,
        source,
        forced: false,
        checkedAt: new Date().toISOString(),
        reason: 'monitor-in-flight',
        warning: null,
        message: '台风预警监控正在执行，本次跳过',
      };
    }

    this.typhoonWarningMonitorInFlight = true;
    let lease: TyphoonWarningMonitorLease | null = null;
    try {
      lease = acquireTyphoonWarningMonitorLease();
      if (!lease) {
        return {
          success: true,
          sent: false,
          source,
          forced: false,
          checkedAt: new Date().toISOString(),
          reason: 'monitor-in-flight',
          warning: null,
          message: '台风预警监控正在由其他服务进程执行，本次跳过',
        };
      }
      return await this.executeTyphoonWarningMonitor(
        source,
        options.expectedWarningKey,
      );
    } finally {
      try {
        lease?.release();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`释放台风预警监控锁失败：${message}`);
      }
      this.typhoonWarningMonitorInFlight = false;
    }
  }

  async previewTyphoonWarningPathScreenshot() {
    const checkedAt = new Date();
    const warningData = await this.bitableSyncService.getWeatherWarning(true);
    const state = readTyphoonWarningSendStateFile();
    const decision = decideTyphoonPathScreenshotSend(
      warningData,
      state,
      checkedAt,
    );
    const warning = decision.warning;

    return {
      success: true as const,
      checkedAt: checkedAt.toISOString(),
      hasActiveWarning: Boolean(warning),
      canSend: Boolean(warning && decision.shouldSend),
      reason: decision.reason,
      cadenceHours: decision.cadenceHours,
      nextSendAt: decision.nextSendAt,
      warning: warning ? this.serializeTyphoonWarning(warning) : null,
      message: warning
        ? decision.shouldSend
          ? '检测到有效台风预警，可以发送台风路径图'
          : '检测到有效台风预警，但本轮已发送，无需重复发送'
        : '当前没有有效台风预警',
    };
  }

  async forceSendTyphoonPathScreenshot(options: {
    clientMutationId: string;
  }): Promise<TyphoonPathGroupScreenshotResponse> {
    const deliveryKey = buildForcedTyphoonPathDeliveryKey(
      options.clientMutationId,
    );
    let sendPromise = this.forcedTyphoonPathSendsInFlight.get(deliveryKey);
    if (!sendPromise) {
      sendPromise = this.executeForcedTyphoonPathSend(deliveryKey);
      this.forcedTyphoonPathSendsInFlight.set(deliveryKey, sendPromise);
    }

    try {
      return await sendPromise;
    } finally {
      if (
        this.forcedTyphoonPathSendsInFlight.get(deliveryKey) === sendPromise
      ) {
        this.forcedTyphoonPathSendsInFlight.delete(deliveryKey);
      }
    }
  }

  private async executeForcedTyphoonPathSend(
    deliveryKey: string,
  ): Promise<TyphoonPathGroupScreenshotResponse> {
    const lease = acquireTyphoonWarningMonitorLease();
    if (!lease) {
      return {
        success: true,
        sent: false,
        source: 'manual-group',
        forced: true,
        reason: 'monitor-in-flight',
        message: '台风路径截图发送正在由其他服务进程执行，本次未重复发起',
      };
    }

    try {
      if (
        this.dutyScreenshotService.hasCompletedTyphoonPathDelivery(deliveryKey)
      ) {
        return {
          success: true,
          sent: false,
          source: 'manual-group',
          forced: true,
          reason: 'already-sent',
          message: '相同台风路径图操作已发送，已跳过重复投递',
        };
      }

      const checkedAt = new Date();
      const warningData = await this.bitableSyncService.getWeatherWarning(true);
      const activeWarning = findActiveTyphoonWarning(warningData, checkedAt);
      if (activeWarning) {
        const warningResult = await this.executeTyphoonWarningMonitor(
          'manual',
          activeWarning.warningKey,
          warningData,
          checkedAt,
        );
        return {
          ...warningResult,
          source: 'manual',
          forced: false,
        };
      }

      const screenshot =
        await this.dutyScreenshotService.captureAndSendTyphoonPath({
          source: 'manual-group',
          deliveryKey,
        });
      return {
        success: true,
        sent: !screenshot.alreadySent,
        source: 'manual-group',
        forced: true,
        reason: screenshot.alreadySent ? 'already-sent' : 'forced-send',
        message: screenshot.message,
        screenshot,
      };
    } finally {
      try {
        lease.release();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`释放台风路径强制发送锁失败：${message}`);
      }
    }
  }

  private async executeTyphoonWarningMonitor(
    source: TyphoonWarningMonitorSource,
    expectedWarningKey?: string,
    prefetchedWarningData?: Awaited<
      ReturnType<BitableSyncService['getWeatherWarning']>
    >,
    checkedAt: Date = new Date(),
  ) {
    const warningData =
      prefetchedWarningData ??
      (await this.bitableSyncService.getWeatherWarning(true));
    let state: TyphoonWarningSendState;
    try {
      state = readTyphoonWarningSendStateFile();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `读取台风预警截图发送状态失败，为避免重复群发已停止本次任务：${message}`,
      );
      return {
        success: false,
        sent: false,
        source,
        forced: false,
        checkedAt: checkedAt.toISOString(),
        reason: 'state-read-error',
        warning: null,
        message: '台风预警发送状态异常，已停止发送以避免重复消息',
      };
    }
    const decision = decideTyphoonPathScreenshotSend(
      warningData,
      state,
      checkedAt,
    );
    const warning = decision.warning;

    if (
      expectedWarningKey &&
      warning &&
      expectedWarningKey !== warning.warningKey
    ) {
      return {
        success: true,
        sent: false,
        source,
        forced: false,
        checkedAt: checkedAt.toISOString(),
        reason: 'warning-changed',
        warning: this.serializeTyphoonWarning(warning),
        message: '台风预警状态已经变化，请重新确认后发送',
      };
    }

    if (!decision.shouldSend || !warning) {
      return {
        success: true,
        sent: false,
        source,
        forced: false,
        checkedAt: checkedAt.toISOString(),
        reason: decision.reason,
        cadenceHours: decision.cadenceHours,
        nextSendAt: decision.nextSendAt,
        warning: warning ? this.serializeTyphoonWarning(warning) : null,
        message: warning ? '台风预警截图未到发送间隔' : '当前无有效台风预警',
      };
    }

    const deliveryKey = buildTyphoonPathWarningDeliveryKey(decision, state);
    const screenshot =
      await this.dutyScreenshotService.captureAndSendTyphoonPath({
        source: source === 'manual' ? 'manual-group' : 'auto-typhoon-warning',
        warningTitle: warning.title,
        warningLevel: warning.levelText,
        deliveryKey,
      });
    writeTyphoonWarningSendStateFile(
      buildTyphoonWarningSendState(warning, new Date(screenshot.sentAt)),
    );

    return {
      success: true,
      sent: !screenshot.alreadySent,
      source,
      forced: false,
      checkedAt: checkedAt.toISOString(),
      reason: screenshot.alreadySent ? 'already-sent' : decision.reason,
      cadenceHours: decision.cadenceHours,
      nextSendAt: decision.nextSendAt,
      warning: this.serializeTyphoonWarning(warning),
      screenshot,
      message: screenshot.alreadySent
        ? '本轮台风路径图已经发送，已跳过重复投递'
        : '台风预警截图已发送',
    };
  }

  async syncAllLocalTables(source: LocalSyncSource = 'manual') {
    const tasks: Array<{
      key: string;
      name: string;
      run: () => Promise<LocalSyncResult>;
    }> = [
      {
        key: 'roomSchedule',
        name: '值班排班',
        run: () => this.dutyScheduleService.syncFromFeishuBase(),
      },
      {
        key: 'sealingInfo',
        name: '封网信息',
        run: () => this.bitableSyncService.syncFromBitable(),
      },
      {
        key: 'organization',
        name: '组织架构',
        run: () => this.bitableSyncService.syncOrganization(),
      },
      {
        key: 'holidaySchedule',
        name: '节日重保排班',
        run: () => this.bitableSyncService.syncFestivalImportantSchedule(),
      },
      {
        key: 'nonDutySchedule',
        name: '长白班排班',
        run: () => this.bitableSyncService.syncNonDutySchedule(),
      },
    ];

    this.logger.log(
      `开始执行${source === 'manual' ? '手动' : '每4小时自动'}飞书本地库同步任务`,
    );

    const settledResults = await Promise.allSettled(
      tasks.map((task) => task.run()),
    );
    const results: Record<string, unknown> = {};
    const failed: Array<{ key: string; name: string; message: string }> = [];

    settledResults.forEach((result, index) => {
      const task = tasks[index];

      if (result.status === 'fulfilled') {
        results[task.key] = result.value;
        if (result.value.success === false) {
          failed.push({
            key: task.key,
            name: task.name,
            message: result.value.message || '同步未完成',
          });
        }
        return;
      }

      const message =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      results[task.key] = { success: false, message };
      failed.push({ key: task.key, name: task.name, message });
      this.logger.warn(`${task.name}同步失败: ${message}`);
    });

    const success = failed.length === 0;
    const response = {
      success,
      source,
      syncedAt: new Date().toISOString(),
      results,
      failed,
      message: success
        ? '飞书数据已同步到本地库'
        : `部分数据同步失败：${failed.map((item) => item.name).join('、')}`,
    };

    if (success) {
      this.logger.log('飞书本地库同步任务执行成功');
    } else {
      this.logger.warn(response.message);
    }

    return response;
  }

  @BindTrigger('sync_all_tables_every_4_hours')
  async autoSyncAllTablesEvery4Hours() {
    return this.syncAllLocalTables('auto-4h');
  }

  @BindTrigger('cron1[17 * * * *]', {
    actionName: 'CheckTyphoonWarningAndSendPathScreenshot',
    actionDesc:
      'Hourly check Nantong typhoon warning and send path screenshot by 8h/4h cadence.',
  })
  async autoCheckTyphoonWarningAndSendPathScreenshotHourly() {
    return this.monitorTyphoonWarningAndSendPathScreenshot({
      source: 'auto-typhoon-warning',
    });
  }

  @BindTrigger('cron1[10 */4 * * *]', {
    actionName: 'RefreshProgramModifiedDutyStaffFromRules',
    actionDesc:
      '每4小时重置并按请假、替班、缺岗和差旅规则刷新今日至未来15天程序修改人员',
  })
  async autoRefreshProgramModifiedDutyStaffEvery4Hours() {
    return this.runProgramModifiedDutyStaffRefresh({
      source: 'auto-4h',
    });
  }

  private runProgramModifiedDutyStaffRefresh(options: { source: string }) {
    if (this.programModifiedDutyStaffRefreshInFlight) {
      this.logger.log(
        `排班程序修改字段刷新正在执行，复用在途任务：source=${options.source}`,
      );
      return this.programModifiedDutyStaffRefreshInFlight;
    }

    const refresh =
      this.dutyScheduleService.refreshProgramModifiedDutyStaffFromRules({
        ...options,
        ...getDutyProgramModifiedRefreshWindow(),
      });
    this.programModifiedDutyStaffRefreshInFlight = refresh;
    const release = () => {
      if (this.programModifiedDutyStaffRefreshInFlight === refresh) {
        this.programModifiedDutyStaffRefreshInFlight = undefined;
      }
    };
    void refresh.then(release, release);
    return refresh;
  }

  @BindTrigger('cron1[22 0 * * *]', {
    actionName: 'RepairWeeklyLeaveSubstitutes',
    actionDesc: '每天 00:22 扫描本周请休假替班差异，自动修正并通知飞书群',
  })
  async autoRepairWeeklyLeaveSubstitutesAt0022() {
    return this.dutyScheduleService.repairWeeklyLeaveSubstituteMismatches({
      source: 'auto-00:22',
      forceRefresh: true,
      notify: true,
    });
  }

  @BindTrigger('cron1[50 8 * * *]', {
    actionName: 'SendDutyOverviewScreenshotMorning',
    actionDesc: '每天 08:50 发送南通机房值班概览截图到飞书群',
  })
  async autoSendDutyOverviewScreenshotAt0850() {
    return this.dutyDailyReportTaskCoordinatorService.run(
      'white-screenshot',
      getShanghaiDutyDateKey(new Date()),
    );
  }

  @BindTrigger('cron1[50 17 * * *]', {
    actionName: 'SendDutyOverviewScreenshotEvening',
    actionDesc: '每天 17:50 发送南通机房值班概览截图到飞书群',
  })
  async autoSendDutyOverviewScreenshotAt1750() {
    return this.dutyDailyReportTaskCoordinatorService.run(
      'night-screenshot',
      getShanghaiDutyDateKey(new Date()),
    );
  }

  private serializeTyphoonWarning(warning: {
    id: string;
    warningKey: string;
    title: string;
    level: TyphoonWarningLevel;
    levelText: string;
    pubTime?: string;
  }) {
    return {
      id: warning.id,
      warningKey: warning.warningKey,
      title: warning.title,
      level: warning.level,
      levelText: warning.levelText,
      pubTime: warning.pubTime,
    };
  }
}
