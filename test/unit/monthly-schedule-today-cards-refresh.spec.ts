import { readFileSync } from 'fs';
import { join } from 'path';
import { readScheduleOnce } from '../../client/src/pages/MonthlySchedule/schedule-read-cache';

describe('MonthlySchedule latest today cards', () => {
  const pageSource = readFileSync(
    join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
    'utf8',
  );

  it('uses the shared ordinary leave reader and ordinary travel reads', () => {
    const start = pageSource.indexOf('function TodayPersonnelMovementCard');
    const end = pageSource.indexOf('function TodayEngineersOnDuty', start);
    const componentSource = pageSource.slice(start, end);

    expect(componentSource).toContain('readTodayLeaveStaff(todayStr)');
    expect(componentSource).toContain('localSnapshotRefreshToken');
    expect(componentSource).not.toContain('forceRefresh');
  });

  it('uses the same ordinary leave reader for long-white duty', () => {
    const start = pageSource.indexOf('function TodayEngineersOnDuty');
    const end = pageSource.indexOf('function MonthlySchedulePageContent(', start);
    const componentSource = pageSource.slice(start, end);

    expect(componentSource).toContain('if (cached)');
    expect(componentSource).toContain('getLongWhiteDutyStaff(dateStr)');
    expect(componentSource).toContain('readTodayLeaveStaff?.(dateStr)');
    expect(componentSource).not.toContain('forceRefresh');
  });

  it('coalesces the two card reads for one date without retaining completed or failed lookups', async () => {
    const calls = new Map<string, Promise<string>>();
    const read = jest.fn<Promise<string>, []>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('ready');
    const first = readScheduleOnce(calls, '2026-11-24', read);
    expect(readScheduleOnce(calls, '2026-11-24', read)).toBe(first);
    await expect(first).rejects.toThrow('offline');
    await expect(readScheduleOnce(calls, '2026-11-24', read)).resolves.toBe('ready');
    await expect(readScheduleOnce(calls, '2026-11-24', read)).resolves.toBe('ready');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps the screenshot gate closed until every visible async section reports ready', () => {
    expect(pageSource).toContain('isDutyOverviewScreenshotReady(screenshotReadiness)');
    expect(pageSource).toContain("setScreenshotSectionState('weatherWidget'");
    expect(pageSource).toContain("setScreenshotSectionState('weatherTrend'");
    expect(pageSource).toContain("setScreenshotSectionState('personnelMovements'");
    expect(pageSource).not.toContain(
      "data-screenshot-ready={loading ? 'false' : 'true'}",
    );
  });
});
