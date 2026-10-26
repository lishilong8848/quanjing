import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DutyDailyReportTaskCoordinatorService } from '../../server/modules/duty-schedule/duty-daily-report-task-coordinator.service';
import type { DutyDailyReportLocalTask } from '../../server/modules/duty-schedule/duty-daily-report-local-scheduler.service';

type CoordinatorRun = (
  task: DutyDailyReportLocalTask,
  date: string,
) => Promise<unknown>;

describe('DutyDailyReportTaskCoordinatorService', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nantong-duty-report-tasks-'));
    process.env.DUTY_DAILY_REPORT_TASK_STATE_PATH = join(
      tempDir,
      'task-state.json',
    );
  });

  afterEach(() => {
    delete process.env.DUTY_DAILY_REPORT_TASK_STATE_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('has no report-record creation task or fallback', () => {
    const sources = [
      'duty-daily-report-local-scheduler.service.ts',
      'duty-daily-report-task-coordinator.service.ts',
      'duty-daily-report-bitable.service.ts',
      'duty-schedule.automation.ts',
    ].map((fileName) =>
      readFileSync(
        join(
          process.cwd(),
          'server/modules/duty-schedule',
          fileName,
        ),
        'utf8',
      ),
    );

    for (const source of sources) {
      expect(source).not.toContain("'white-record'");
      expect(source).not.toContain("'night-record'");
      expect(source).not.toContain('ensureDailyReportRecord');
      expect(source).not.toContain('createDailyReportRecord');
    }
  });

  it('dispatches every task with an explicit business date', async () => {
    const screenshot = {
      captureAndSendDutyOverview: jest
        .fn()
        .mockResolvedValue({ success: true }),
    };
    const Coordinator = DutyDailyReportTaskCoordinatorService as unknown as new (
      screenshotService: typeof screenshot,
    ) => DutyDailyReportTaskCoordinatorService;
    const coordinator = new Coordinator(screenshot);
    const run = (coordinator as unknown as { run?: CoordinatorRun }).run;

    expect(typeof run).toBe('function');
    if (!run) return;

    await run.call(coordinator, 'white-screenshot', '2026-07-20');
    await run.call(coordinator, 'night-screenshot', '2026-07-20');

    expect(screenshot.captureAndSendDutyOverview).toHaveBeenNthCalledWith(1, {
      date: '2026-07-20',
      source: 'auto-08:50',
    });
    expect(screenshot.captureAndSendDutyOverview).toHaveBeenNthCalledWith(2, {
      date: '2026-07-20',
      source: 'auto-17:50',
    });
  });

  it('shares one in-flight execution for the same date and task', async () => {
    let releaseScreenshot!: (value: unknown) => void;
    const screenshotGate = new Promise((resolve) => {
      releaseScreenshot = resolve;
    });
    const screenshot = {
      captureAndSendDutyOverview: jest.fn(() => screenshotGate),
    };
    const coordinator = createCoordinator(screenshot);

    const first = coordinator.run('white-screenshot', '2026-07-20');
    const second = coordinator.run('white-screenshot', '2026-07-20');

    expect(screenshot.captureAndSendDutyOverview).toHaveBeenCalledTimes(1);
    releaseScreenshot({ success: true });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('persists successful task keys and skips them after a restart', async () => {
    const screenshot = {
      captureAndSendDutyOverview: jest
        .fn()
        .mockResolvedValue({ success: true }),
    };

    await createCoordinator(screenshot).run(
      'white-screenshot',
      '2026-07-20',
    );
    const secondResult = await createCoordinator(screenshot).run(
      'white-screenshot',
      '2026-07-20',
    );

    expect(screenshot.captureAndSendDutyOverview).toHaveBeenCalledTimes(1);
    expect(secondResult).toMatchObject({
      success: true,
      skipped: true,
      task: 'white-screenshot',
      date: '2026-07-20',
    });
  });

  it('does not persist a failed task and retries it later', async () => {
    const screenshot = {
      captureAndSendDutyOverview: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary Feishu failure'))
        .mockResolvedValueOnce({ success: true }),
    };
    const coordinator = createCoordinator(screenshot);

    await expect(
      coordinator.run('night-screenshot', '2026-07-20'),
    ).rejects.toThrow('temporary Feishu failure');
    await expect(
      coordinator.run('night-screenshot', '2026-07-20'),
    ).resolves.toMatchObject({ success: true });

    expect(screenshot.captureAndSendDutyOverview).toHaveBeenCalledTimes(2);
  });
});

function createCoordinator(
  screenshot: {
    captureAndSendDutyOverview: jest.Mock;
  },
): DutyDailyReportTaskCoordinatorService {
  const Coordinator = DutyDailyReportTaskCoordinatorService as unknown as new (
    screenshotService: typeof screenshot,
  ) => DutyDailyReportTaskCoordinatorService;
  return new Coordinator(screenshot);
}
