import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AliMonthlyReportTaskCoordinatorService } from '../../server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service';
import {
  readAliMonthlyReportTaskStateFile,
  writeAliMonthlyReportTaskStateFile,
  type AliMonthlyReportAutomationState,
  type AliMonthlyReportAutomationType,
} from '../../server/modules/ali-monthly-report/ali-monthly-report-task-state';

// The real coordinator and on-disk lease/ledger run below; no gateway or notifier is constructed.
jest.mock(
  '../../server/modules/ali-monthly-report/ali-monthly-report.service',
  () => ({
    AliMonthlyReportService: class AliMonthlyReportService {},
  }),
);

const PERIOD = { year: 2026, month: 10 } as const;
const ORIGINAL_TIME = '2026-11-03T01:00:43.064Z';
const RETRY_TIME = new Date('2026-11-03T02:00:44.000Z');
const HOUR_MS = 60 * 60 * 1000;
const ORIGINAL_URL =
  'https://vnet.feishu.cn/base/synthetic?table=tblPower&recordId=recOctoberPower';
const EXISTING_FILE = 'EA118机柜超功耗告警统计10月份_20261103_083021.xlsx';

function initialState(): AliMonthlyReportAutomationState {
  return {
    version: 1,
    periods: {
      '2026-10': {
        year: 2026,
        month: 10,
        lastAttemptAt: ORIGINAL_TIME,
        tasks: {
          alarm_analysis: {
            status: 'succeeded',
            attempts: 1,
            updatedAt: ORIGINAL_TIME,
            fileName: 'synthetic-2026-10-alarm.xlsx',
            recordUrl:
              'https://vnet.feishu.cn/base/synthetic?recordId=recAlarm',
          },
          over_power: {
            status: 'failed',
            attempts: 1,
            updatedAt: ORIGINAL_TIME,
            error: '请先在“配置”中填写：阿里超功率多维表配置路径',
          },
          staff_roster: {
            status: 'succeeded',
            attempts: 1,
            updatedAt: ORIGINAL_TIME,
            fileName: 'synthetic-2026-10-staff.xlsx',
            recordUrl:
              'https://vnet.feishu.cn/base/synthetic?recordId=recStaff',
          },
        },
      },
    },
  };
}

function reusedResult(
  reportType: AliMonthlyReportAutomationType = 'over_power',
  year = 2026,
  month = 10,
) {
  return {
    success: true,
    reportType,
    year,
    month,
    action: 'downloaded_existing_attachment',
    message: '已获取已有附件，未生成或上传',
    files: [
      {
        id: 'synthetic-existing-file',
        name: EXISTING_FILE,
        size: '21KB',
        downloadUrl: '/synthetic/existing.xlsx',
      },
    ],
    logs: [],
    bitableRecordUrls: [ORIGINAL_URL],
  };
}

function serviceWith(
  generateForAutomation = jest.fn().mockResolvedValue(reusedResult()),
) {
  return {
    generateForAutomation,
    sendAutomationSummary: jest.fn().mockResolvedValue(undefined),
    uploadBitableFile: jest.fn(() => {
      throw new Error('No upload is permitted in this test');
    }),
    createBitableRecord: jest.fn(() => {
      throw new Error('No source write is permitted in this test');
    }),
  };
}

describe('existing over-power attachment retry preserves already successful work', () => {
  let directory = '';
  let statePath = '';
  let original: AliMonthlyReportAutomationState;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ali-existing-retry-'));
    statePath = join(directory, 'synthetic', 'automation.json');
    original = initialState();
    writeAliMonthlyReportTaskStateFile(original, { statePath });
  });

  afterEach(() => {
    if (directory && existsSync(directory))
      rmSync(directory, { recursive: true, force: true });
  });

  function coordinator(service: ReturnType<typeof serviceWith>) {
    return new AliMonthlyReportTaskCoordinatorService(service as never, {
      statePath,
      retryIntervalMs: HOUR_MS,
    });
  }

  function preservedSuccesses() {
    const tasks = readAliMonthlyReportTaskStateFile({ statePath }).periods[
      '2026-10'
    ].tasks;
    for (const type of ['alarm_analysis', 'staff_roster'] as const) {
      expect(JSON.stringify(tasks[type])).toBe(
        JSON.stringify(original.periods['2026-10'].tasks[type]),
      );
    }
    return tasks;
  }

  it('retries only over_power and records the original attachment URL without replaying the two successful jobs', async () => {
    const service = serviceWith();
    await expect(
      coordinator(service).runDue(PERIOD, RETRY_TIME),
    ).resolves.toMatchObject({ status: 'success', succeeded: 3, failed: 0 });
    expect(service.generateForAutomation.mock.calls).toEqual([
      ['over_power', 2026, 10],
    ]);
    expect(preservedSuccesses().over_power).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      fileName: EXISTING_FILE,
      recordUrl: ORIGINAL_URL,
    });
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(1);
    expect(service.uploadBitableFile).not.toHaveBeenCalled();
    expect(service.createBitableRecord).not.toHaveBeenCalled();
  });

  it('does not process or renotify a completed period after another scheduler tick or a fresh coordinator instance', async () => {
    const service = serviceWith();
    await coordinator(service).runDue(PERIOD, RETRY_TIME);
    const bytes = readFileSync(statePath);
    await expect(
      coordinator(service).runDue(
        PERIOD,
        new Date(RETRY_TIME.getTime() + HOUR_MS * 10),
      ),
    ).resolves.toBeNull();
    expect(service.generateForAutomation).toHaveBeenCalledTimes(1);
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(1);
    expect(readFileSync(statePath)).toEqual(bytes);
    preservedSuccesses();
  });

  it('shares a simultaneous click in one coordinator without starting a second attachment operation', async () => {
    let release!: (result: ReturnType<typeof reusedResult>) => void;
    const service = serviceWith(
      jest.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    );
    const instance = coordinator(service);
    const first = instance.runDue(PERIOD, RETRY_TIME);
    const second = instance.runDue(PERIOD, RETRY_TIME);
    expect(second).toBe(first);
    expect(service.generateForAutomation.mock.calls).toEqual([
      ['over_power', 2026, 10],
    ]);
    release(reusedResult());
    await first;
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(1);
    preservedSuccesses();
  });

  it('uses the shared on-disk lease to reject concurrent work by another coordinator', async () => {
    let release!: (result: ReturnType<typeof reusedResult>) => void;
    const firstService = serviceWith(
      jest.fn(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      ),
    );
    const secondService = serviceWith();
    const first = coordinator(firstService).runDue(PERIOD, RETRY_TIME);
    await expect(
      coordinator(secondService).runDue(PERIOD, RETRY_TIME),
    ).resolves.toBeNull();
    expect(secondService.generateForAutomation).not.toHaveBeenCalled();
    expect(secondService.sendAutomationSummary).not.toHaveBeenCalled();
    release(reusedResult());
    await first;
    expect(firstService.generateForAutomation).toHaveBeenCalledTimes(1);
    preservedSuccesses();
  });

  it.each([
    [
      'download rejected',
      () => Promise.reject(new Error('没有找到 2026年10月 的超功率附件')),
    ],
    [
      'missing source URL',
      () => Promise.resolve({ ...reusedResult(), bitableRecordUrls: [] }),
    ],
    [
      'blank source URL',
      () => Promise.resolve({ ...reusedResult(), bitableRecordUrls: ['   '] }),
    ],
    [
      'missing downloaded file',
      () => Promise.resolve({ ...reusedResult(), files: [] }),
    ],
  ] as const)(
    'keeps over_power failed on %s and preserves both successful jobs',
    async (_label, reply) => {
      const service = serviceWith(jest.fn(reply));
      await expect(
        coordinator(service).runDue(PERIOD, RETRY_TIME),
      ).resolves.toMatchObject({
        status: 'partial_failure',
        succeeded: 2,
        failed: 1,
      });
      const task = preservedSuccesses().over_power;
      expect(task.status).toBe('failed');
      expect(task.attempts).toBe(2);
      expect(task.error).toBeTruthy();
      expect(task.fileName).toBeUndefined();
      expect(task.recordUrl).toBeUndefined();
      expect(service.generateForAutomation.mock.calls).toEqual([
        ['over_power', 2026, 10],
      ]);
      expect(service.uploadBitableFile).not.toHaveBeenCalled();
      expect(service.createBitableRecord).not.toHaveBeenCalled();
    },
  );

  it('retries only summary delivery after its failure and does not re-download the recovered attachment', async () => {
    const service = serviceWith();
    service.sendAutomationSummary.mockRejectedValueOnce(
      new Error('synthetic summary timeout'),
    );
    const instance = coordinator(service);
    await expect(instance.runDue(PERIOD, RETRY_TIME)).resolves.toMatchObject({
      status: 'success',
      notificationSent: false,
    });
    await expect(
      instance.runDue(PERIOD, new Date(RETRY_TIME.getTime() + HOUR_MS)),
    ).resolves.toMatchObject({ status: 'success', notificationSent: true });
    expect(service.generateForAutomation).toHaveBeenCalledTimes(1);
    expect(service.sendAutomationSummary).toHaveBeenCalledTimes(2);
    expect(
      service.sendAutomationSummary.mock.calls[0][0].notificationFingerprint,
    ).toBe(
      service.sendAutomationSummary.mock.calls[1][0].notificationFingerprint,
    );
    preservedSuccesses();
  });

  it('creates separate November work instead of treating October successes or its attachment as November results', async () => {
    const originalPeriod = JSON.stringify(original.periods['2026-10']);
    const service = serviceWith(
      jest.fn(
        async (
          type: AliMonthlyReportAutomationType,
          year: number,
          month: number,
        ) => ({
          ...reusedResult(type, year, month),
          files: [
            {
              id: 'synthetic-november',
              name: `synthetic-${year}-${month}-${type}.xlsx`,
              size: '1KB',
              downloadUrl: '/synthetic/november.xlsx',
            },
          ],
          bitableRecordUrls: [
            `https://vnet.feishu.cn/base/synthetic?recordId=rec${year}${month}${type}`,
          ],
        }),
      ),
    );
    await coordinator(service).runDue(
      { year: 2026, month: 11 },
      new Date('2026-12-03T01:00:00.000Z'),
    );
    expect(service.generateForAutomation.mock.calls).toEqual([
      ['alarm_analysis', 2026, 11],
      ['over_power', 2026, 11],
      ['staff_roster', 2026, 11],
    ]);
    const state = readAliMonthlyReportTaskStateFile({ statePath });
    expect(JSON.stringify(state.periods['2026-10'])).toBe(originalPeriod);
    expect(state.periods['2026-11'].tasks.over_power).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      fileName: 'synthetic-2026-11-over_power.xlsx',
    });
    expect(state.periods['2026-11'].tasks.over_power.recordUrl).not.toBe(
      ORIGINAL_URL,
    );
  });
});
