import { dirname, join, resolve } from 'node:path';
import {
  resolveDutyDailyReportStateDirectory,
  resolveDutyDailyReportStateFilePath,
} from '../../server/modules/duty-schedule/duty-daily-report-state-path';

describe('duty daily report durable state path', () => {
  it('uses a shared sibling directory for timestamped production releases', () => {
    const releaseDirectory = resolve(
      'C:\\ai\\nantong-schedule-20260428-101724',
    );

    expect(
      resolveDutyDailyReportStateDirectory({
        cwd: releaseDirectory,
        nodeEnv: 'production',
      }),
    ).toBe(join(dirname(releaseDirectory), 'nantong-schedule-state'));
  });

  it('honors explicit file and shared-directory overrides', () => {
    expect(
      resolveDutyDailyReportStateFilePath({
        fileName: 'task-state.json',
        explicitPath: 'D:\\persistent\\task-state.json',
        cwd: 'C:\\ignored',
        nodeEnv: 'production',
      }),
    ).toBe(resolve('D:\\persistent\\task-state.json'));

    expect(
      resolveDutyDailyReportStateFilePath({
        fileName: 'delivery-state.json',
        configuredDirectory: 'D:\\persistent\\duty-state',
        cwd: 'C:\\ignored',
        nodeEnv: 'production',
      }),
    ).toBe(
      join(resolve('D:\\persistent\\duty-state'), 'delivery-state.json'),
    );
  });
});
