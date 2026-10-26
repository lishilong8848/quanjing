import { readFileSync } from 'fs';
import { join } from 'path';

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('core runtime DingTalk attendance integration boundaries', () => {
  it('registers the automation client and scheduler without the legacy today snapshot HTTP providers', () => {
    const dutyScheduleModule = source(
      'server/modules/duty-schedule/duty-schedule.module.ts',
    );

    expect(dutyScheduleModule).toContain('DingTalkAttendanceClient');
    expect(dutyScheduleModule).toContain(
      'AttendanceAutomationLocalSchedulerService',
    );
    expect(dutyScheduleModule).not.toContain('TodayAttendanceController');
    expect(dutyScheduleModule).not.toContain('TodayAttendanceSnapshotService');
  });

  it('injects only the archived daily summary into inspection anomalies without a live DingTalk client', () => {
    const bitableModule = source(
      'server/modules/bitable-sync/bitable-sync.module.ts',
    );
    const anomalyService = source(
      'server/modules/bitable-sync/today-operations-anomaly.service.ts',
    );

    expect(bitableModule).toContain('AttendanceDailySummaryStore');
    expect(anomalyService).toContain('AttendanceDailySummaryStore');
    expect(anomalyService).toContain('buildYesterdayAttendanceAnomalies');
    expect(anomalyService).not.toContain('DingTalkAttendanceClient');
    expect(anomalyService).not.toContain(
      'ATTENDANCE_AUTOMATION_EFFECTIVE_FROM',
    );
  });

  it('does not request or render attendance in the today panorama', () => {
    const page = source('client/src/pages/TodayOperationsPanorama/index.tsx');
    const dialog = source(
      'client/src/pages/TodayOperationsPanorama/OnDutyPeopleDialog.tsx',
    );

    expect(page).not.toContain('getTodayAttendanceSnapshot');
    expect(page).not.toContain('attendance={todayAttendance}');
    expect(dialog).not.toContain('TodayAttendanceSnapshot');
    expect(dialog).not.toContain('今日考勤异常');
    expect(dialog).not.toContain('正在读取钉钉今日考勤');
  });
});
