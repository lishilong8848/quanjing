import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('AliMonthlyReportModule', () => {
  it('注册自动任务协调器与调度器，确保服务启动后执行月报任务', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/ali-monthly-report/ali-monthly-report.module.ts',
      ),
      'utf8',
    );

    expect(source).toContain('AliMonthlyReportTaskCoordinatorService');
    expect(source).toContain('AliMonthlyReportScheduler');
    expect(source).toMatch(
      /providers:\s*\[[^\]]*AliMonthlyReportTaskCoordinatorService[^\]]*AliMonthlyReportScheduler[^\]]*\]/s,
    );
  });
});
