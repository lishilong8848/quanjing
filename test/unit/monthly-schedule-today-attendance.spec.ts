import { readFileSync } from 'fs';
import { join } from 'path';
import { ModuleKind, transpileModule } from 'typescript';

describe('monthly schedule core runtime', () => {
  it('renders the compact archived attendance panel without calling DingTalk from the page', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const api = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );

    expect(source).toContain('TodayAttendanceAnomalyList');
    expect(source).toContain('useTodayAttendanceSnapshot');
    expect(api).toContain("url: '/api/attendance/today'");
    expect(source).not.toContain('DingTalkAttendanceClient');
    expect(source).not.toContain('数据来源');
  });

  it('keeps the weather column compact so its bottom aligns with the calendar', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const warning = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/WeatherWarningSnapshotSummary.tsx',
      ),
      'utf8',
    );

    expect(source).toContain('duty-calendar-weather-side');
    expect(source).toContain('min-h-[224px]');
    expect(source).toContain('h-[96px]');
    expect(warning).toContain('duty-weather-warning-summary');
    expect(warning).toContain('min-h-16');
    expect(source).not.toContain('min-h-[260px]');
    expect(source).not.toContain('h-[124px]');
    expect(source).not.toContain('min-h-[320px]');
  });

  it('keeps actionable attendance states but omits auxiliary result metadata', () => {
    const component = readFileSync(
      join(
        process.cwd(),
        'client/src/components/attendance/TodayAttendanceAnomalyList.tsx',
      ),
      'utf8',
    );

    expect(component).toContain("sourceStatus === 'pending'");
    expect(component).toContain('等待 09:30 考勤终检');
    expect(component).toContain('考勤终检正在补跑');
    expect(component).toContain('考勤终检本轮未执行');
    expect(component).toContain('下次自动重试');
    expect(component).toContain('已停止自动重试');
    expect(component).toContain('failureReason');
    expect(component).toContain("failureScope === 'personal-delivery'");
    expect(component).not.toContain('考勤核验已完成，个人提醒');
    expect(component).not.toContain('可手动重试个人提醒');
    expect(component).not.toMatch(
      /const isWarning\s*=\s*[^;]*isPersonalDeliveryFailure/su,
    );
    expect(component).toContain('nextRetryAt');
    expect(component).not.toContain('考勤日期 {snapshot?.date}');
    expect(component.match(/最后同步 \{lastSync\}/gu)).toHaveLength(1);
    expect(component).toContain('已获取考勤结果：{resultText}');
  });

  it('marks previous-day results in the title without a second explanatory banner', () => {
    const component = readFileSync(
      join(
        process.cwd(),
        'client/src/components/attendance/TodayAttendanceAnomalyList.tsx',
      ),
      'utf8',
    );

    expect(component).toContain("snapshot?.displayScope === 'previous-day'");
    expect(component).toContain('昨日（${snapshot.date}）');
    expect(component).not.toContain('当前展示昨日 {snapshot.date} 考勤结果');
    expect(component).not.toContain('今日考勤将在 09:30 终检后更新');
  });

  it.each([
    ['2026-09-09T01:29:59.000Z', 1_000],
    ['2026-09-09T01:30:00.000Z', (9 * 60 + 5) * 60_000],
    ['2026-09-09T10:34:59.000Z', 1_000],
    ['2026-09-09T15:59:59.000Z', 1_000],
    ['2026-09-09T16:00:00.000Z', (9 * 60 + 30) * 60_000],
  ])(
    'refreshes at the exact Shanghai check/day boundary from %s',
    (now, delay) => {
      const source = readFileSync(
        join(
          process.cwd(),
          'client/src/components/attendance/use-today-attendance.ts',
        ),
        'utf8',
      );
      const implementation = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS },
      }).outputText;
      const exported: {
        getNextFinalAttendanceRefreshDelay?: (now: Date) => number;
      } = {};
      new Function('require', 'exports', implementation)(() => ({}), exported);
      expect(exported.getNextFinalAttendanceRefreshDelay!(new Date(now))).toBe(
        delay,
      );
    },
  );

  it('refreshes automatically while the 09:30 run is recovering', () => {
    const hook = readFileSync(
      join(
        process.cwd(),
        'client/src/components/attendance/use-today-attendance.ts',
      ),
      'utf8',
    );

    expect(hook).toContain('RECOVERY_REFRESH_INTERVAL_MS');
    expect(hook).toContain("'not-run'");
    expect(hook).toContain("'running'");
    expect(hook).toContain("'failed'");
    expect(hook).toContain('snapshot.runStatus?.finalFailure');
  });

  it('treats a personal reminder failure as completed core attendance data', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/components/attendance/use-today-attendance.ts',
      ),
      'utf8',
    );
    const implementation = transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS },
    }).outputText;
    const exported: {
      isAttendanceCoreSyncComplete?: (
        snapshot: Record<string, unknown> | null,
      ) => boolean;
    } = {};
    new Function('require', 'exports', implementation)(() => ({}), exported);

    expect(
      exported.isAttendanceCoreSyncComplete!({
        sourceStatus: 'failed',
        runStatus: { state: 'failed', failureScope: 'personal-delivery' },
        summary: { expected: 8 },
      }),
    ).toBe(true);
    expect(
      exported.isAttendanceCoreSyncComplete!({
        sourceStatus: 'failed',
        runStatus: { state: 'failed', failureScope: 'core' },
        summary: { expected: 8 },
      }),
    ).toBe(false);
  });

  it('offers an admin manual sync with durable mutation identity and visible progress', () => {
    const component = readFileSync(
      join(
        process.cwd(),
        'client/src/components/attendance/TodayAttendanceAnomalyList.tsx',
      ),
      'utf8',
    );
    const hook = readFileSync(
      join(
        process.cwd(),
        'client/src/components/attendance/use-today-attendance.ts',
      ),
      'utf8',
    );
    const api = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(api).toContain("url: '/api/attendance/today/retry'");
    expect(api).toContain(
      "params: forceRefresh ? { refresh: '1' } : undefined",
    );
    expect(api).toContain('clientMutationId');
    expect(hook).toContain('manualSyncState');
    expect(hook).toContain('crypto.randomUUID()');
    expect(hook).toContain('MANUAL_SYNC_POLL_INTERVAL_MS');
    expect(hook).toContain('getTodayAttendanceSnapshot(forceRefresh)');
    expect(hook).toContain('triggerRefresh(true)');
    expect(component).toContain('手动同步今日考勤');
    expect(component).toContain('manualSyncState');
    expect(component).toContain('animate-spin');
    expect(page).toContain("canManualSync={role === 'admin'}");
  });

  it('groups anomalies by building instead of rendering one full-width row per anomaly', () => {
    const component = readFileSync(
      join(
        process.cwd(),
        'client/src/components/attendance/TodayAttendanceAnomalyList.tsx',
      ),
      'utf8',
    );

    expect(component).toContain('groupTodayAttendanceAnomalies');
    expect(component).toContain('rounded-md border border-slate-200');
    expect(component).not.toContain(
      'grid-cols-[4.5rem_minmax(0,1fr)_4.5rem_minmax(5rem,auto)]',
    );
  });
});
