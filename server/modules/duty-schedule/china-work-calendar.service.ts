import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { readEnv } from '@server/common/config/external-services.config';
import {
  getChinaWorkCalendarSnapshot,
  installChinaWorkCalendarSnapshot,
  type ChinaWorkCalendarMaintenanceStatus,
  type ChinaWorkCalendarResponse,
} from '@shared/china-work-calendar';
import { fetchOfficialChinaWorkCalendar } from './china-work-calendar-source';
import {
  readChinaWorkCalendarStateFile,
  writeChinaWorkCalendarStateFile,
  type ChinaWorkCalendarPersistedState,
  type ChinaWorkCalendarYearCheckState,
} from './china-work-calendar-state-store';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 5_000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_CHECK_HOUR = 3;
const DEFAULT_CHECK_MINUTE = 20;
const MAX_ERROR_LENGTH = 500;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

interface RefreshOptions {
  force?: boolean;
  now?: Date;
}

interface RefreshDelayOptions {
  now: Date;
  targetYear: number;
  hasValidatedCalendar: boolean;
  consecutiveFailures: number;
}

@Injectable()
export class ChinaWorkCalendarService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChinaWorkCalendarService.name);
  private startupTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private activeRefresh: Promise<void> | null = null;
  private started = false;
  private state: ChinaWorkCalendarPersistedState = {
    schemaVersion: 1,
    snapshot: getChinaWorkCalendarSnapshot(),
  };

  constructor(private readonly http: HttpService) {}

  onModuleInit(): void {
    this.loadPersistedState();
    if (!this.isAutoRefreshEnabled()) {
      this.logger.log('中国法定节假日历自动维护已禁用');
      return;
    }
    if (this.started) return;
    this.started = true;

    const delayMs = readIntegerEnv(
      'CHINA_WORK_CALENDAR_STARTUP_DELAY_MS',
      DEFAULT_STARTUP_DELAY_MS,
      0,
      10 * 60 * 1000,
    );
    const timer = setTimeout(() => {
      this.startupTimer = null;
      void this.refreshNow().finally(() => {
        if (this.started) this.scheduleNextCheck();
      });
    }, delayMs);
    timer.unref?.();
    this.startupTimer = timer;
  }

  onModuleDestroy(): void {
    this.started = false;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.startupTimer = null;
    this.checkTimer = null;
  }

  refreshNow(options: RefreshOptions = {}): Promise<void> {
    if (this.activeRefresh) return this.activeRefresh;

    let execution!: Promise<void>;
    execution = this.runRefresh(options).finally(() => {
      if (this.activeRefresh === execution) {
        this.activeRefresh = null;
      }
    });
    this.activeRefresh = execution;
    return execution;
  }

  getStatus(): ChinaWorkCalendarMaintenanceStatus {
    const snapshot = getChinaWorkCalendarSnapshot();
    return {
      enabled: this.isAutoRefreshEnabled(),
      refreshing: this.activeRefresh !== null,
      supportedYears: snapshot.years.map(({ year }) => year).sort(),
      ...(this.state.lastCheckedAt
        ? { lastCheckedAt: this.state.lastCheckedAt }
        : {}),
      ...(this.state.lastSuccessAt
        ? { lastSuccessAt: this.state.lastSuccessAt }
        : {}),
      ...(this.state.nextCheckAt
        ? { nextCheckAt: this.state.nextCheckAt }
        : {}),
      ...(this.state.lastError ? { lastError: this.state.lastError } : {}),
    };
  }

  getResponse(): ChinaWorkCalendarResponse {
    return {
      snapshot: getChinaWorkCalendarSnapshot(),
      status: this.getStatus(),
    };
  }

  private loadPersistedState(): void {
    try {
      const persisted = readChinaWorkCalendarStateFile();
      if (!persisted) return;
      installChinaWorkCalendarSnapshot(persisted.snapshot);
      this.state = {
        ...persisted,
        snapshot: getChinaWorkCalendarSnapshot(),
      };
    } catch (error) {
      const message = sanitizeError(error);
      this.state.lastError = message;
      this.logger.warn(`读取中国法定节假日历最后有效快照失败：${message}`);
    }
  }

  private async runRefresh(options: RefreshOptions): Promise<void> {
    const now = options.now ?? new Date();
    const targetYears = getChinaWorkCalendarTargetYears(now);
    const dueYears = targetYears.filter(
      (year) => options.force || this.isYearDue(year, now),
    );
    if (dueYears.length === 0) {
      this.updateNextCheckAt(now, targetYears);
      return;
    }

    const errors: string[] = [];
    const timeoutMs = readIntegerEnv(
      'CHINA_WORK_CALENDAR_HTTP_TIMEOUT_MS',
      DEFAULT_HTTP_TIMEOUT_MS,
      1_000,
      60_000,
    );
    const checkedAt = now.toISOString();

    for (const year of dueYears) {
      const yearKey = String(year);
      const previous = this.state.yearChecks?.[yearKey] || {};
      const nextCheck: ChinaWorkCalendarYearCheckState = {
        ...previous,
        lastCheckedAt: checkedAt,
      };
      try {
        const calendar = await fetchOfficialChinaWorkCalendar(
          this.http.axiosRef,
          year,
          timeoutMs,
        );
        if (calendar) {
          installChinaWorkCalendarSnapshot({
            schemaVersion: 1,
            years: [calendar],
          });
          nextCheck.lastSuccessAt = checkedAt;
          nextCheck.notPublished = false;
          nextCheck.consecutiveFailures = 0;
          this.state.lastSuccessAt = checkedAt;
          this.logger.log(
            `中国法定节假日历已校验：year=${year}, source=${calendar.noticeNumber}`,
          );
        } else {
          nextCheck.notPublished = true;
          nextCheck.consecutiveFailures = 0;
          this.logger.log(`中国法定节假日历尚未发布：year=${year}`);
        }
      } catch (error) {
        const message = sanitizeError(error);
        nextCheck.consecutiveFailures = (previous.consecutiveFailures || 0) + 1;
        errors.push(`${year}: ${message}`);
        this.logger.warn(
          `中国法定节假日历检查失败，保留最后有效数据：year=${year}, error=${message}`,
        );
      }

      this.state.yearChecks = {
        ...(this.state.yearChecks || {}),
        [yearKey]: nextCheck,
      };
    }

    this.state.lastCheckedAt = checkedAt;
    if (errors.length > 0) {
      this.state.lastError = errors.join('；').slice(0, MAX_ERROR_LENGTH);
    } else {
      delete this.state.lastError;
    }
    this.state.snapshot = getChinaWorkCalendarSnapshot();
    this.updateNextCheckAt(now, targetYears);
    this.persistStateSafely();
  }

  private isYearDue(year: number, now: Date): boolean {
    const check = this.state.yearChecks?.[String(year)];
    if (!check?.lastCheckedAt) return true;
    const lastCheckedAt = new Date(check.lastCheckedAt);
    if (Number.isNaN(lastCheckedAt.getTime())) return true;

    const delayMs = getChinaWorkCalendarRefreshDelayMs({
      now,
      targetYear: year,
      hasValidatedCalendar: this.hasValidatedCalendar(year),
      consecutiveFailures: check.consecutiveFailures || 0,
    });
    const checkHour = readIntegerEnv(
      'CHINA_WORK_CALENDAR_REFRESH_HOUR',
      DEFAULT_CHECK_HOUR,
      0,
      23,
    );
    const checkMinute = readIntegerEnv(
      'CHINA_WORK_CALENDAR_REFRESH_MINUTE',
      DEFAULT_CHECK_MINUTE,
      0,
      59,
    );
    return (
      now.getTime() >=
      getChinaWorkCalendarNextScheduledCheckAt(
        lastCheckedAt,
        delayMs,
        checkHour,
        checkMinute,
      ).getTime()
    );
  }

  private hasValidatedCalendar(year: number): boolean {
    return getChinaWorkCalendarSnapshot().years.some(
      (calendar) => calendar.year === year,
    );
  }

  private updateNextCheckAt(now: Date, targetYears: number[]): void {
    const checkHour = readIntegerEnv(
      'CHINA_WORK_CALENDAR_REFRESH_HOUR',
      DEFAULT_CHECK_HOUR,
      0,
      23,
    );
    const checkMinute = readIntegerEnv(
      'CHINA_WORK_CALENDAR_REFRESH_MINUTE',
      DEFAULT_CHECK_MINUTE,
      0,
      59,
    );
    const candidates = targetYears.map((year) => {
      const check = this.state.yearChecks?.[String(year)];
      if (!check?.lastCheckedAt) return now;
      const lastCheckedAt = new Date(check.lastCheckedAt);
      const delayMs = getChinaWorkCalendarRefreshDelayMs({
        now,
        targetYear: year,
        hasValidatedCalendar: this.hasValidatedCalendar(year),
        consecutiveFailures: check.consecutiveFailures || 0,
      });
      return getChinaWorkCalendarNextScheduledCheckAt(
        lastCheckedAt,
        delayMs,
        checkHour,
        checkMinute,
      );
    });
    const cadenceBoundary = nextChinaWorkCalendarCadenceBoundaryAt(
      now,
      checkHour,
      checkMinute,
    );
    this.state.nextCheckAt = new Date(
      Math.min(
        cadenceBoundary.getTime(),
        ...candidates.map((candidate) => candidate.getTime()),
      ),
    ).toISOString();
  }

  private persistStateSafely(): void {
    try {
      writeChinaWorkCalendarStateFile(this.state);
    } catch (error) {
      const message = sanitizeError(error);
      this.state.lastError = message;
      this.logger.warn(`保存中国法定节假日历状态失败：${message}`);
    }
  }

  private scheduleNextCheck(): void {
    if (!this.started) return;
    if (this.checkTimer) clearTimeout(this.checkTimer);

    const nextCheckAt = this.state.nextCheckAt
      ? new Date(this.state.nextCheckAt)
      : new Date(Date.now() + DAY_MS);
    const delayMs = getChinaWorkCalendarTimerDelayMs(
      nextCheckAt.getTime() - Date.now(),
    );
    const timer = setTimeout(() => {
      this.checkTimer = null;
      void this.refreshNow().finally(() => {
        if (this.started) this.scheduleNextCheck();
      });
    }, delayMs);
    timer.unref?.();
    this.checkTimer = timer;
  }

  private isAutoRefreshEnabled(): boolean {
    const configured = readEnv('CHINA_WORK_CALENDAR_AUTO_REFRESH_ENABLED', [
      'DUTY_CHINA_WORK_CALENDAR_AUTO_REFRESH_ENABLED',
    ]).toLowerCase();
    if (configured) {
      return !['0', 'false', 'off', 'no'].includes(configured);
    }
    return process.env.NODE_ENV !== 'test';
  }
}

export function getChinaWorkCalendarTargetYears(now: Date): number[] {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const currentYear = shanghaiNow.getUTCFullYear();
  return [currentYear, currentYear + 1];
}

export function getChinaWorkCalendarRefreshDelayMs(
  options: RefreshDelayOptions,
): number {
  let baseDelayMs = 30 * DAY_MS;
  const shanghaiNow = new Date(options.now.getTime() + SHANGHAI_OFFSET_MS);
  const currentYear = shanghaiNow.getUTCFullYear();

  if (!options.hasValidatedCalendar && options.targetYear === currentYear + 1) {
    const month = shanghaiNow.getUTCMonth() + 1;
    const day = shanghaiNow.getUTCDate();
    if (month >= 10 && (month < 12 || day <= 15)) {
      baseDelayMs = 3 * DAY_MS;
    } else if (month === 12 && day >= 16) {
      baseDelayMs = DAY_MS;
    }
  } else if (!options.hasValidatedCalendar) {
    baseDelayMs = DAY_MS;
  }

  if (options.consecutiveFailures <= 0) return baseDelayMs;
  const failureDelayMs =
    DAY_MS * 2 ** Math.min(5, options.consecutiveFailures - 1);
  return Math.min(baseDelayMs, failureDelayMs);
}

export function getChinaWorkCalendarTimerDelayMs(delayMs: number): number {
  return Math.min(Math.max(1_000, delayMs), MAX_TIMER_DELAY_MS);
}

export function getChinaWorkCalendarNextScheduledCheckAt(
  lastCheckedAt: Date,
  delayMs: number,
  hour: number,
  minute: number,
): Date {
  const shanghaiLastCheckedAt = new Date(
    lastCheckedAt.getTime() + SHANGHAI_OFFSET_MS,
  );
  const calendarDays = Math.max(1, Math.ceil(delayMs / DAY_MS));
  return shanghaiDateTimeToUtc(
    shanghaiLastCheckedAt.getUTCFullYear(),
    shanghaiLastCheckedAt.getUTCMonth(),
    shanghaiLastCheckedAt.getUTCDate() + calendarDays,
    hour,
    minute,
  );
}

function nextChinaWorkCalendarCadenceBoundaryAt(
  now: Date,
  hour: number,
  minute: number,
): Date {
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const year = shanghaiNow.getUTCFullYear();
  const boundaries = [
    shanghaiDateTimeToUtc(year, 9, 1, hour, minute),
    shanghaiDateTimeToUtc(year, 11, 16, hour, minute),
    shanghaiDateTimeToUtc(year + 1, 0, 1, hour, minute),
  ];
  return (
    boundaries.find((boundary) => boundary.getTime() > now.getTime()) ||
    shanghaiDateTimeToUtc(year + 1, 9, 1, hour, minute)
  );
}

function shanghaiDateTimeToUtc(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(
    Date.UTC(year, monthIndex, day, hour, minute, 0, 0) - SHANGHAI_OFFSET_MS,
  );
}

function readIntegerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const configured = Number.parseInt(readEnv(name), 10);
  return Number.isInteger(configured) &&
    configured >= minimum &&
    configured <= maximum
    ? configured
    : fallback;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/((?:token|key|secret|password)\s*=\s*)[^\s&]+/gi, '$1***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_LENGTH);
}
