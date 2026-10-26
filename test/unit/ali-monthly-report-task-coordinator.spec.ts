import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AliMonthlyReportTaskCoordinatorService } from '../../server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service';
import {
  acquireAliMonthlyReportTaskLease,
  readAliMonthlyReportTaskStateFile,
  resolveAliMonthlyReportTaskStatePath,
  writeAliMonthlyReportTaskStateFile,
  type AliMonthlyReportAutomationState,
  type AliMonthlyReportAutomationType,
} from '../../server/modules/ali-monthly-report/ali-monthly-report-task-state';

const PERIOD = { year: 2026, month: 7 } as const;
const STARTED_AT = new Date('2026-08-03T01:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

describe('AliMonthlyReportTaskCoordinatorService', () => {
  let root = '';
  let statePath = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ali-monthly-automation-'));
    statePath = join(root, 'state', 'automation.json');
  });

  afterEach(() => {
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes and reads the task ledger atomically and rejects corrupt JSON', () => {
    const state: AliMonthlyReportAutomationState = {
      version: 1,
      periods: {
        '2026-07': {
          year: 2026,
          month: 7,
          lastAttemptAt: STARTED_AT.toISOString(),
          tasks: {
            alarm_analysis: {
              status: 'succeeded',
              attempts: 1,
              updatedAt: STARTED_AT.toISOString(),
              fileName: 'alarm.xlsx',
              recordUrl: 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
            },
            over_power: {
              status: 'failed',
              attempts: 1,
              updatedAt: STARTED_AT.toISOString(),
              error: 'timeout',
            },
            staff_roster: {
              status: 'pending',
              attempts: 0,
              updatedAt: STARTED_AT.toISOString(),
            },
          },
        },
      },
    };

    writeAliMonthlyReportTaskStateFile(state, { statePath });

    expect(readAliMonthlyReportTaskStateFile({ statePath })).toEqual(state);
    expect(readdirSync(join(root, 'state'))).toEqual(['automation.json']);

    writeFileSync(statePath, '{broken', 'utf8');
    expect(() => readAliMonthlyReportTaskStateFile({ statePath })).toThrow(
      '阿里月报自动任务状态文件损坏',
    );
  });

  it('uses one production state file shared by timestamped release directories', () => {
    const expected = join(
      root,
      'nantong-schedule-state',
      'ali-monthly-report-task-state.json',
    );

    expect(
      resolveAliMonthlyReportTaskStatePath({
        cwd: join(root, 'release-20260803-a'),
        nodeEnv: 'production',
      }),
    ).toBe(expected);
    expect(
      resolveAliMonthlyReportTaskStatePath({
        cwd: join(root, 'release-20260803-b'),
        nodeEnv: 'production',
      }),
    ).toBe(expected);
  });

  it('reclaims an expired process lease without letting the stale owner remove the replacement', () => {
    const first = acquireAliMonthlyReportTaskLease({
      statePath,
      now: STARTED_AT,
      leaseTimeoutMs: 1_000,
    });
    expect(first).not.toBeNull();

    const replacement = acquireAliMonthlyReportTaskLease({
      statePath,
      now: new Date(STARTED_AT.getTime() + 1_001),
      leaseTimeoutMs: 1_000,
    });
    expect(replacement).not.toBeNull();

    first?.release();
    expect(
      acquireAliMonthlyReportTaskLease({
        statePath,
        now: new Date(STARTED_AT.getTime() + 1_002),
        leaseTimeoutMs: 1_000,
      }),
    ).toBeNull();

    replacement?.release();
    const afterRelease = acquireAliMonthlyReportTaskLease({
      statePath,
      now: new Date(STARTED_AT.getTime() + 1_003),
      leaseTimeoutMs: 1_000,
    });
    expect(afterRelease).not.toBeNull();
    afterRelease?.release();
  });

  it('starts the three report generations in parallel and persists their Bitable records', async () => {
    const resolvers = new Map<
      AliMonthlyReportAutomationType,
      (value: unknown) => void
    >();
    const service = createService({
      generateForAutomation: jest.fn(
        (reportType: AliMonthlyReportAutomationType) =>
          new Promise((resolve) => resolvers.set(reportType, resolve)),
      ),
    });
    const coordinator = new AliMonthlyReportTaskCoordinatorService(
      service as never,
      { statePath, retryIntervalMs: HOUR_MS },
    );

    const running = coordinator.runDue(PERIOD, STARTED_AT);

    expect([...resolvers.keys()]).toEqual([
      'alarm_analysis',
      'over_power',
      'staff_roster',
    ]);
    for (const reportType of resolvers.keys()) {
      resolvers.get(reportType)?.(successfulResult(reportType));
    }

    await expect(running).resolves.toMatchObject({
      year: 2026,
      month: 7,
      status: 'success',
      succeeded: 3,
      failed: 0,
    });
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(1);

    const persisted = readAliMonthlyReportTaskStateFile({ statePath });
    expect(persisted.periods['2026-07'].tasks).toMatchObject({
      alarm_analysis: {
        status: 'succeeded',
        recordUrl: 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
      },
      over_power: {
        status: 'succeeded',
        recordUrl: 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
      },
      staff_roster: {
        status: 'succeeded',
        recordUrl: 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
      },
    });
  });

  it('lists only ledger-known periods that still need generation or notification', async () => {
    const service = createService({
      generateForAutomation: jest.fn(
        async (reportType: AliMonthlyReportAutomationType) =>
          successfulResult(reportType),
      ),
    });
    const coordinator = new AliMonthlyReportTaskCoordinatorService(
      service as never,
      { statePath, retryIntervalMs: HOUR_MS },
    );
    const june = { year: 2026, month: 6 } as const;
    await coordinator.runDue(june, new Date('2026-07-03T01:00:00.000Z'));

    const state = readAliMonthlyReportTaskStateFile({ statePath });
    state.periods['2026-07'] = {
      year: 2026,
      month: 7,
      lastAttemptAt: STARTED_AT.toISOString(),
      tasks: {
        alarm_analysis: {
          status: 'succeeded',
          attempts: 1,
          updatedAt: STARTED_AT.toISOString(),
          fileName: 'alarm.xlsx',
          recordUrl: 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
        },
        over_power: {
          status: 'failed',
          attempts: 1,
          updatedAt: STARTED_AT.toISOString(),
          error: 'request timeout',
        },
        staff_roster: {
          status: 'succeeded',
          attempts: 1,
          updatedAt: STARTED_AT.toISOString(),
          fileName: 'staff.xlsx',
          recordUrl: 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
        },
      },
    };
    writeAliMonthlyReportTaskStateFile(state, { statePath });

    expect(coordinator.listExistingIncompletePeriods()).toEqual([
      { year: 2026, month: 7 },
    ]);
  });

  it('returns the same active promise and does not start duplicate work', async () => {
    let release!: (value: unknown) => void;
    const service = createService({
      generateForAutomation: jest.fn(
        (reportType: AliMonthlyReportAutomationType) =>
          reportType === 'alarm_analysis'
            ? new Promise((resolve) => {
                release = resolve;
              })
            : Promise.resolve(successfulResult(reportType)),
      ),
    });
    const coordinator = new AliMonthlyReportTaskCoordinatorService(
      service as never,
      { statePath, retryIntervalMs: HOUR_MS },
    );

    const first = coordinator.runDue(PERIOD, STARTED_AT);
    const duplicate = coordinator.runDue(PERIOD, STARTED_AT);

    expect(duplicate).toBe(first);
    expect(service.generateForAutomation).toHaveBeenCalledTimes(3);
    release(successfulResult('alarm_analysis'));
    await first;
    expect(service.generateForAutomation).toHaveBeenCalledTimes(3);
  });

  it('allows only one coordinator instance to generate reports for a shared state file', async () => {
    let release!: (value: unknown) => void;
    const firstService = createService({
      generateForAutomation: jest.fn(
        (reportType: AliMonthlyReportAutomationType) =>
          reportType === 'alarm_analysis'
            ? new Promise((resolve) => {
                release = resolve;
              })
            : Promise.resolve(successfulResult(reportType)),
      ),
    });
    const secondService = createService({
      generateForAutomation: jest.fn(
        async (reportType: AliMonthlyReportAutomationType) =>
          successfulResult(reportType),
      ),
    });
    const firstCoordinator = new AliMonthlyReportTaskCoordinatorService(
      firstService as never,
      { statePath, retryIntervalMs: HOUR_MS },
    );
    const secondCoordinator = new AliMonthlyReportTaskCoordinatorService(
      secondService as never,
      { statePath, retryIntervalMs: HOUR_MS },
    );

    const first = firstCoordinator.runDue(PERIOD, STARTED_AT);
    await expect(
      secondCoordinator.runDue(
        PERIOD,
        new Date(STARTED_AT.getTime() + HOUR_MS),
      ),
    ).resolves.toBeNull();
    expect(secondService.generateForAutomation).not.toHaveBeenCalled();

    release(successfulResult('alarm_analysis'));
    await first;
    expect(firstService.generateForAutomation).toHaveBeenCalledTimes(3);
  });

  it('debounces dynamic request metadata but notifies when the error category changes', async () => {
    let overPowerAttempt = 0;
    const service = createService({
      generateForAutomation: jest.fn(
        async (reportType: AliMonthlyReportAutomationType) => {
          if (reportType !== 'over_power') return successfulResult(reportType);
          overPowerAttempt += 1;
          if (overPowerAttempt === 1) {
            throw new Error(
              '同步失败 request_id=req-a trace_id=trace-a at 2026-08-03T01:00:01.123Z temp C:\\Temp\\ali-a\\report.xlsx',
            );
          }
          if (overPowerAttempt === 2) {
            throw new Error(
              '同步失败 request_id=req-b trace_id=trace-b at 2026-08-03T02:00:09.456Z temp C:\\Temp\\ali-b\\report.xlsx',
            );
          }
          if (overPowerAttempt === 3) {
            throw new Error(
              'permission denied request_id=req-c trace_id=trace-c at 2026-08-03T03:00:00Z',
            );
          }
          return successfulResult(reportType);
        },
      ),
    });
    const coordinator = new AliMonthlyReportTaskCoordinatorService(
      service as never,
      { statePath, retryIntervalMs: HOUR_MS },
    );

    await coordinator.runDue(PERIOD, STARTED_AT);
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(1);
    const firstFingerprint =
      service.sendAutomationSummary.mock.calls[0][0].notificationFingerprint;

    await coordinator.runDue(PERIOD, new Date(STARTED_AT.getTime() + HOUR_MS));
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(1);

    await coordinator.runDue(
      PERIOD,
      new Date(STARTED_AT.getTime() + HOUR_MS * 2),
    );
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(2);
    expect(
      service.sendAutomationSummary.mock.calls[1][0].notificationFingerprint,
    ).not.toBe(firstFingerprint);
  });

  it('retries only failed reports and notifies only when failure state changes or recovers', async () => {
    let overPowerAttempt = 0;
    const service = createService({
      generateForAutomation: jest.fn(
        async (reportType: AliMonthlyReportAutomationType) => {
          if (reportType !== 'over_power') return successfulResult(reportType);
          overPowerAttempt += 1;
          if (overPowerAttempt === 1) throw new Error('request timeout');
          if (overPowerAttempt <= 3) throw new Error('permission denied');
          return successfulResult(reportType);
        },
      ),
    });
    const coordinator = new AliMonthlyReportTaskCoordinatorService(
      service as never,
      { statePath, retryIntervalMs: HOUR_MS },
    );

    await expect(coordinator.runDue(PERIOD, STARTED_AT)).resolves.toMatchObject(
      {
        status: 'partial_failure',
        succeeded: 2,
        failed: 1,
      },
    );
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(1);

    await expect(
      coordinator.runDue(PERIOD, new Date(STARTED_AT.getTime() + HOUR_MS / 2)),
    ).resolves.toBeNull();
    expect(service.generateForAutomation).toHaveBeenCalledTimes(3);

    await coordinator.runDue(PERIOD, new Date(STARTED_AT.getTime() + HOUR_MS));
    expect(service.generateForAutomation).toHaveBeenCalledTimes(4);
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(2);

    await coordinator.runDue(
      PERIOD,
      new Date(STARTED_AT.getTime() + HOUR_MS * 2),
    );
    expect(service.generateForAutomation).toHaveBeenCalledTimes(5);
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(2);

    await expect(
      coordinator.runDue(PERIOD, new Date(STARTED_AT.getTime() + HOUR_MS * 3)),
    ).resolves.toMatchObject({
      status: 'success',
      succeeded: 3,
      failed: 0,
    });
    expect(service.generateForAutomation).toHaveBeenCalledTimes(6);
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(3);

    expect(
      service.generateForAutomation.mock.calls.map((call) => call[0]),
    ).toEqual([
      'alarm_analysis',
      'over_power',
      'staff_roster',
      'over_power',
      'over_power',
      'over_power',
    ]);
  });

  it('retries a failed summary delivery without regenerating successful reports', async () => {
    const service = createService({
      generateForAutomation: jest.fn(
        async (reportType: AliMonthlyReportAutomationType) =>
          successfulResult(reportType),
      ),
      sendAutomationSummary: jest
        .fn()
        .mockRejectedValueOnce(new Error('message timeout'))
        .mockResolvedValue(undefined),
    });
    const coordinator = new AliMonthlyReportTaskCoordinatorService(
      service as never,
      { statePath, retryIntervalMs: HOUR_MS },
    );

    await expect(coordinator.runDue(PERIOD, STARTED_AT)).resolves.toMatchObject(
      {
        status: 'success',
        notificationSent: false,
        notificationError: 'message timeout',
      },
    );

    await expect(
      coordinator.runDue(PERIOD, new Date(STARTED_AT.getTime() + HOUR_MS)),
    ).resolves.toMatchObject({
      status: 'success',
      notificationSent: true,
    });
    expect(service.generateForAutomation).toHaveBeenCalledTimes(3);
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(2);
    expect(
      service.sendAutomationSummary.mock.calls.map(
        (call) => call[0].notificationFingerprint,
      ),
    ).toEqual([
      expect.any(String),
      service.sendAutomationSummary.mock.calls[0][0].notificationFingerprint,
    ]);
  });
});

function createService(overrides: Record<string, jest.Mock> = {}) {
  return {
    generateForAutomation: jest.fn(),
    sendAutomationSummary: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function successfulResult(reportType: AliMonthlyReportAutomationType) {
  return {
    success: true,
    reportType,
    year: PERIOD.year,
    month: PERIOD.month,
    message: 'ok',
    files: [
      {
        id: reportType,
        name: `${reportType}.xlsx`,
        size: '1KB',
        downloadUrl: `/files/${reportType}`,
      },
    ],
    logs: [],
    bitableRecordUrls: [
      `https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE`,
    ],
  };
}
