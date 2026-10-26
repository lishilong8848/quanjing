import { readFileSync } from 'fs';
import { join } from 'path';

describe('MonthlySchedule latest today cards', () => {
  const pageSource = readFileSync(
    join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
    'utf8',
  );

  it('forces fresh leave and travel reads for personnel movements after manual sync', () => {
    const start = pageSource.indexOf('function TodayPersonnelMovementCard');
    const end = pageSource.indexOf('function TodayEngineersOnDuty', start);
    const componentSource = pageSource.slice(start, end);

    expect(componentSource).toContain(
      'const forceRefresh = refreshToken > lastSuccessfulRefreshTokenRef.current',
    );
    expect(componentSource).toContain(
      'getTodayLeaveStaff(todayStr, forceRefresh)',
    );
    expect(componentSource).toContain('refresh: forceRefresh');
  });

  it('bypasses the long-white client cache and refreshes leave data after manual sync', () => {
    const start = pageSource.indexOf('function TodayEngineersOnDuty');
    const end = pageSource.indexOf('const MonthlySchedulePage', start);
    const componentSource = pageSource.slice(start, end);

    expect(componentSource).toContain(
      'const forceRefresh = refreshToken > lastSuccessfulRefreshTokenRef.current',
    );
    expect(componentSource).toContain('if (!forceRefresh && cached)');
    expect(componentSource).toContain(
      'getLongWhiteDutyStaff(dateStr, forceRefresh)',
    );
    expect(componentSource).toContain(
      'getTodayLeaveStaff(dateStr, forceRefresh)',
    );
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
