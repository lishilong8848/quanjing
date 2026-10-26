import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('daily operations patrol module wiring', () => {
  it('registers the unified patrol without changing attendance or weather providers', () => {
    const moduleSource = source(
      'server/modules/duty-schedule/duty-schedule.module.ts',
    );

    expect(moduleSource).toContain('DailyOperationsPatrolGateway');
    expect(moduleSource).toContain('DailyOperationsPatrolStore');
    expect(moduleSource).toContain('DailyOperationsPatrolService');
    expect(moduleSource).not.toContain('DailyOperationsPatrolScheduler');
    expect(moduleSource).toContain('AttendanceAutomationLocalSchedulerService');
    expect(moduleSource).toContain('TyphoonWarningMonitorService');
  });

  it('does not register the legacy today-operations anomaly scheduler', () => {
    const moduleSource = source(
      'server/modules/bitable-sync/bitable-sync.module.ts',
    );

    expect(moduleSource).not.toContain('TodayOperationsAnomalyScheduler');
    expect(moduleSource).toContain('TodayOperationsAnomalyService');
  });
});
