import { cancelHotfixInitialization, runHotfixInitialization } from '../hotfix-runtime-activation';
import { Injectable, Logger, ServiceUnavailableException, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { AccessConfigurationDirectory } from './access-configuration.directory';
import { AccessConfigurationService } from './access-configuration.service';

export function personnelSyncDay(now: Date): string | null {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)?.value || '';
  return Number(part('hour')) >= 2 ? `${part('year')}-${part('month')}-${part('day')}` : null;
}
export function personnelSyncCalendarDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

@Injectable()
export class AccessPersonnelSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccessPersonnelSyncService.name);
  private timer?: NodeJS.Timeout;
  private pending?: Promise<ReturnType<AccessConfigurationService['snapshot']>>;
  private nextLoginRefreshAt = 0;
  constructor(private readonly configuration: AccessConfigurationService, private readonly directory: AccessConfigurationDirectory) {}
  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
      await this.configuration.onModuleInit();
      if (!process.env.FEISHU_APP_ID?.trim() || !process.env.FEISHU_APP_SECRET?.trim()) return;
      this.timer = setInterval(() => { void this.tick(); }, 60_000);
      this.timer.unref();
      const initial = this.configuration.snapshot();
      if (!initial.accounts.some(account => account.siteMember !== undefined) && !initial.personnelSync?.lastAttemptAt) {
        void this.run().catch(() => this.logger.warn('人员首次同步失败，可在配置页重试'));
      } else void this.tick();
    });
  }
  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
 if (this.timer) clearInterval(this.timer); await this.pending?.catch(() => undefined);
  }
  async tick(now = new Date()): Promise<void> {
    const day = personnelSyncDay(now);
    if (!day || this.pending) return;
    try {
      const status = this.configuration.snapshot().personnelSync;
      if (status?.status === 'success' && status.lastSuccessAt && personnelSyncDay(new Date(status.lastSuccessAt)) === day) return;
      const attemptDay = status?.attemptDay || (status?.lastAttemptAt ? personnelSyncCalendarDay(new Date(status.lastAttemptAt)) : undefined);
      if (attemptDay === day) {
        if ((status?.attempts || 1) >= 3) return;
        const retryAt = status?.nextAttemptAt ? Date.parse(status.nextAttemptAt) : status?.lastAttemptAt ? Date.parse(status.lastAttemptAt) + 5 * 60_000 : 0;
        if (now.getTime() < retryAt) return;
      }
      await this.run(now);
    } catch { this.logger.warn('人员权限同步失败，现有授权保留'); }
  }
  /** Missing credentials may belong to a new employee added after the daily sync. */
  async refreshForLogin(): Promise<void> {
    const now = Date.now();
    if (!this.pending && now < this.nextLoginRefreshAt) return;
    this.nextLoginRefreshAt = now + 60_000;
    const pending = this.pending || this.run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ServiceUnavailableException('人员登录资料正在同步，请稍后重试')), 8_000);
        }),
      ]);
      if (result.personnelSync?.status === 'error') throw new ServiceUnavailableException('人员登录资料暂时无法同步，请稍后重试');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  run(now = new Date()) {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        await this.configuration.beginPersonnelSyncAttempt(personnelSyncCalendarDay(now), now);
        return await this.configuration.synchronizePersonnel(await this.directory.read(true));
      }
      catch (error) {
        try { await this.configuration.recordPersonnelSyncError(); } catch { this.logger.error('人员同步状态无法持久化'); }
        throw error;
      }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
}
