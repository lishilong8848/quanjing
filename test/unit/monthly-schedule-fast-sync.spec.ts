import { readFileSync } from 'fs';
import { join } from 'path';

describe('monthly schedule fast sync', () => {
  it('uses the schedule-only API', () => {
    const apiSource = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );

    expect(apiSource).toContain('export async function syncDutyScheduleToLocalFast');
    expect(apiSource).toContain("url: '/api/duty-schedules/sync-local-fast'");
  });

  it('reloads schedule and sealing data after manual sync', () => {
    const pageSource = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const start = pageSource.indexOf('const handleManualSync');
    const end = pageSource.indexOf('const handleManualScreenshot', start);
    const handlerSource = pageSource.slice(start, end);

    expect(handlerSource).toContain('await syncDutyScheduleToLocalFast()');
    expect(handlerSource).toContain('longWhiteScheduleCache.clear()');
    expect(handlerSource).toContain('yearlySealingCache.clear()');
    expect(handlerSource).toContain('loadSchedules()');
    expect(handlerSource).toContain('loadSealingInfo(true)');
    expect(handlerSource).not.toContain('syncAllFromFeishu');
    expect(handlerSource).not.toContain('loadChangeInfo');
    expect(handlerSource).not.toContain('loadPersonProfiles');
  });

  it('distinguishes an expired login and stale CSRF from a server failure', () => {
    const pageSource = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const helperStart = pageSource.indexOf(
      'function getProtectedActionErrorMessage',
    );
    const helperEnd = pageSource.indexOf('\nfunction ', helperStart + 1);
    const helperSource = pageSource.slice(helperStart, helperEnd);
    const syncStart = pageSource.indexOf('const handleManualSync');
    const screenshotStart = pageSource.indexOf(
      'const handleManualScreenshot',
      syncStart,
    );
    const screenshotEnd = pageSource.indexOf(
      'const updateDisplayedSchedules',
      screenshotStart,
    );
    const syncSource = pageSource.slice(syncStart, screenshotStart);
    const screenshotSource = pageSource.slice(screenshotStart, screenshotEnd);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperSource).toContain('isBackendStatus(error, 401)');
    expect(helperSource).toContain('isBackendStatus(error, 403)');
    expect(helperSource).toContain('登录已过期，请重新登录后再试');
    expect(helperSource).toContain('页面安全状态已过期，请刷新页面后重试');
    expect(syncSource).toContain('getProtectedActionErrorMessage(');
    expect(screenshotSource).toContain('getProtectedActionErrorMessage(');
    expect(syncSource).not.toContain("toast.error('同步失败，请稍后重试'");
    expect(screenshotSource).not.toContain(
      "toast.error('截图发送失败，请稍后重试'",
    );
  });
});
