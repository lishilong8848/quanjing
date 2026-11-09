import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttendanceDailySummaryStore } from '../../server/modules/duty-schedule/attendance-daily-summary.store';

describe('AttendanceDailySummaryStore', () => {
  const originalEnv = process.env;
  let stateDir = '';

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'attendance-summary-test-'));
    process.env = {
      ...originalEnv,
      ATTENDANCE_AUTOMATION_STATE_DIR: stateDir,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('merges scheduled checks by expectation key without double counting', async () => {
    const store = new AttendanceDailySummaryStore();
    const base = {
      name: '支佳伟',
      building: 'H楼',
      shiftLabel: '白班',
      expectedAt: '2026-09-05 09:00:00',
      status: 'on_duty' as const,
    };

    await store.mergeLiveCheck({
      task: 'morning-on-duty-reminder',
      businessDate: '2026-09-05',
      generatedAt: '2026-09-05T00:55:00.000Z',
      normal: [],
      excluded: [],
      anomalies: [
        {
          ...base,
          key: 'h-on',
          direction: 'OnDuty',
          reason: '未打卡',
        },
      ],
    });
    await store.mergeLiveCheck({
      task: 'morning-off-duty-check',
      businessDate: '2026-09-05',
      generatedAt: '2026-09-05T01:05:00.000Z',
      normal: [{ key: 'h-off-normal' }],
      excluded: [{ key: 'leave-excluded' }],
      anomalies: [
        {
          ...base,
          key: 'h-on',
          direction: 'OnDuty',
          reason: '迟到',
        },
      ],
    });

    await expect(store.read('2026-09-05')).resolves.toMatchObject({
      generatedAt: '2026-09-05T01:05:00.000Z',
      expected: 2,
      normal: 1,
      excluded: 1,
      anomalies: [expect.objectContaining({ key: 'h-on', reason: '迟到' })],
    });
  });

  it('removes cancelled overtime and newly approved leave from earlier checks', async () => {
    const store = new AttendanceDailySummaryStore();
    const base = { businessDate: '2026-09-08', normal: [], excluded: [] };
    const event = {
      name: '测试甲',
      building: 'A楼',
      shiftLabel: '白班',
      expectedAt: '2026-09-08 09:00:00',
      direction: 'OnDuty' as const,
      reason: '未打卡' as const,
    };
    await store.mergeLiveCheck({
      ...base,
      task: 'morning-off-duty-check',
      generatedAt: '2026-09-08T01:30:00Z',
      anomalies: [
        { ...event, key: 'regular-a', status: 'on_duty' },
        {
          ...event,
          key: '2026-09-08:building_a:overtime_white:OnDuty:测试甲:ot1',
          status: 'overtime',
        },
      ],
    });
    const result = await store.mergeLiveCheck({
      ...base,
      task: 'evening-off-duty-check',
      generatedAt: '2026-09-08T10:35:00Z',
      anomalies: [],
      isExcluded: (item: { key: string }) => item.key === 'regular-a',
    } as Parameters<typeof store.mergeLiveCheck>[0]);
    expect(result.anomalies).toEqual([]);
    expect(result.expected).toBe(0);
    expect(result.excluded).toBe(1);
  });

  it('merges only confirmed correction targets without replacing the current execution result', async () => {
    const store = new AttendanceDailySummaryStore();
    const businessDate = '2026-09-08';
    const anomaly = {
      name: '测试甲', building: 'A楼', shiftLabel: '白班',
      expectedAt: '2026-09-08 09:00:00', direction: 'OnDuty' as const,
      reason: '未打卡', status: 'on_duty' as const,
    };
    await store.mergeLiveCheck({
      businessDate, task: 'morning-off-duty-check', executionId: 'current',
      generatedAt: '2026-09-08T01:30:00Z', normal: [], excluded: [],
      anomalies: ['corrected', 'unconfirmed', 'unrelated'].map(key => ({ ...anomaly, key })),
    });
    await store.write({
      version: 1, businessDate, source: 'dingtalk-archive',
      generatedAt: '2026-09-08T02:00:00Z',
      expected: 2, normal: 2, excluded: 0, anomalies: [],
    }, { targetKeys: ['corrected', 'unconfirmed'], normalKeys: ['corrected', 'unrelated'] });
    const summary = await store.read(businessDate);
    expect(summary?.checks?.['morning-off-duty-check']).toMatchObject({ executionId: 'current', normalKeys: ['corrected'] });
    expect(summary?.anomalies.map(item => item.key)).toEqual(['unconfirmed', 'unrelated']);
  });

  it('retains recorded final checks when a full historical archive is written again', async () => {
    const store = new AttendanceDailySummaryStore();
    const businessDate = '2026-09-08';
    const morning = await store.mergeLiveCheck({
      task: 'morning-off-duty-check',
      businessDate,
      executionId: 'morning-execution',
      generatedAt: '2026-09-08T01:30:00Z',
      normal: [{ key: 'morning-normal' }],
      excluded: [],
      anomalies: [],
    });
    const evening = await store.mergeLiveCheck({
      task: 'evening-off-duty-check',
      businessDate,
      executionId: 'evening-execution',
      generatedAt: '2026-09-08T12:00:00Z',
      normal: [{ key: 'evening-normal' }],
      excluded: [{ key: 'approved-leave' }],
      anomalies: [],
    });

    const archive = {
      version: 1 as const,
      businessDate,
      source: 'dingtalk-archive' as const,
      generatedAt: '2026-09-09T00:30:00Z',
      expected: 10,
      normal: 10,
      excluded: 2,
      anomalies: [],
    };
    await store.write(archive);
    await expect(store.read(businessDate)).resolves.toEqual({
      ...archive,
      checks: evening.checks,
    });

    const correctedArchive = { ...archive, generatedAt: '2026-09-11T00:31:00Z', expected: 11, normal: 11 };
    await store.write(correctedArchive);
    await expect(store.read(businessDate)).resolves.toEqual({
      ...correctedArchive,
      checks: {
        'morning-off-duty-check': morning.checks?.['morning-off-duty-check'],
        'evening-off-duty-check': evening.checks?.['evening-off-duty-check'],
      },
    });
  });
});
