import { readFileSync } from 'fs';
import { join } from 'path';

describe('TodayAttendanceController', () => {
  it('keeps a dedicated guest-readable GET route', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/today-attendance.controller.ts',
      ),
      'utf8',
    );

    expect(source).toContain("@Controller('api/attendance')");
    expect(source).toContain("@Get('today')");
    expect(source).toContain('@GuestReadable()');
    expect(source).toContain("@Query('refresh') refresh?: string | string[]");
    expect(source).toContain(
      'snapshotService.getSnapshot(new Date(), forceRefresh)',
    );
    expect(source).not.toContain('sendCard');
  });

  it('keeps manual retry admin-only, validated and accepted asynchronously', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/today-attendance.controller.ts',
      ),
      'utf8',
    );

    expect(source).toMatch(
      /@AdminOnly\(\)\s+@Post\('today\/retry'\)\s+@HttpCode\(HttpStatus\.ACCEPTED\)/u,
    );
    expect(source).toContain('clientMutationId');
    expect(source).toContain('const requestedTask = body?.task');
    expect(source).toContain('手动同步任务无效');
    expect(source).toContain('resolveTodayAttendanceFinalTask');
    expect(source).toContain('@Body() body');
    expect(source).toContain('手动同步请求标识无效');
    expect(source).toContain('今日 09:30 考勤终检尚未到执行时间');
    expect(source).toContain('automationCoordinator.requestManualRetry');
  });
});
