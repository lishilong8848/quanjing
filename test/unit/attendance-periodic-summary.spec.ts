import { buildAttendancePeriodicSummaryCard } from '../../server/modules/duty-schedule/attendance-periodic-summary.card';
import {
  getNextAttendancePeriodicSummaryBatch,
  getRecoverableAttendancePeriodicSummaryRuns,
} from '../../server/modules/duty-schedule/attendance-periodic-summary.scheduler';
import type { AttendanceAnomaly } from '../../server/modules/duty-schedule/attendance-automation.rules';

describe('attendance periodic summary schedule', () => {
  it('runs the weekly summary every Monday at 10:00 Shanghai for the prior Monday-Sunday', () => {
    const batch = getNextAttendancePeriodicSummaryBatch(
      new Date('2026-09-14T01:59:59.999Z'),
    );

    expect(batch.scheduledAt.toISOString()).toBe('2026-09-14T02:00:00.000Z');
    expect(batch.runs).toEqual([
      expect.objectContaining({
        period: 'weekly',
        startDate: '2026-09-07',
        endDate: '2026-09-13',
      }),
    ]);
  });

  it('runs both independent cards when Monday is also the first day of a month', () => {
    const batch = getNextAttendancePeriodicSummaryBatch(
      new Date('2026-06-01T01:59:59.999Z'),
    );

    expect(batch.scheduledAt.toISOString()).toBe('2026-06-01T02:00:00.000Z');
    expect(batch.runs).toEqual([
      expect.objectContaining({
        period: 'weekly',
        startDate: '2026-05-25',
        endDate: '2026-05-31',
      }),
      expect.objectContaining({
        period: 'monthly',
        startDate: '2026-05-01',
        endDate: '2026-05-31',
      }),
    ]);
  });

  it.each([
    ['2026-09-14T01:59:59.999Z', []],
    ['2026-09-14T02:00:00.000Z', ['weekly']],
    ['2026-09-14T02:29:59.999Z', ['weekly']],
    ['2026-09-14T02:30:00.000Z', []],
    ['2026-09-14T23:45:00.000Z', []],
  ])(
    'only recovers Monday weekly summary during the 10:00-10:30 Shanghai window at %s',
    (value, periods) => {
      expect(
        getRecoverableAttendancePeriodicSummaryRuns(new Date(value)).map(
          (run) => run.period,
        ),
      ).toEqual(periods);
    },
  );

  it.each([
    ['2026-09-01T01:59:59.999Z', []],
    ['2026-09-01T02:00:00.000Z', ['monthly']],
    ['2026-09-01T02:29:59.999Z', ['monthly']],
    ['2026-09-01T02:30:00.000Z', []],
    ['2026-09-01T23:45:00.000Z', []],
  ])(
    'only recovers first-of-month summary during the 10:00-10:30 Shanghai window at %s',
    (value, periods) => {
      expect(
        getRecoverableAttendancePeriodicSummaryRuns(new Date(value)).map(
          (run) => run.period,
        ),
      ).toEqual(periods);
    },
  );

  it('recovers weekly and monthly summaries independently when the first day is Monday', () => {
    expect(
      getRecoverableAttendancePeriodicSummaryRuns(
        new Date('2026-06-01T02:15:00.000Z'),
      ).map((run) => run.period),
    ).toEqual(['weekly', 'monthly']);
  });
});

describe('attendance periodic summary card', () => {
  const anomaly = (
    key: string,
    name: string,
    building: string,
    reason: AttendanceAnomaly['reason'],
    expectedAt: string,
  ): AttendanceAnomaly => ({
    key,
    name,
    building,
    shiftLabel: '白班',
    direction: key.endsWith('off') ? 'OffDuty' : 'OnDuty',
    expectedAt,
    status: 'on_duty',
    reason,
  });

  it('shows one compact overview and groups the current effective anomalies by building', () => {
    const card = buildAttendancePeriodicSummaryCard({
      period: 'weekly',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      fetchedAt: '2026-09-08 10:00',
      checkedCount: 88,
      followUpUrl:
        'https://sm.example.com/attendance-anomaly-follow-up?ticket=abc.DEF',
      anomalies: [
        anomaly('c-late-1', '张三', 'C楼', '迟到', '2026-09-02 09:00:00'),
        anomaly('c-late-2', '张三', 'C楼', '迟到', '2026-09-04 09:00:00'),
        anomaly('a-early-off', '李四', 'A楼', '早退', '2026-09-03 18:00:00'),
        anomaly('h-missing', '王五', 'H楼', '未打卡', '2026-09-05 09:00:00'),
        anomaly(
          'station-missing',
          '赵六',
          '110站',
          '未查询到有效打卡',
          '2026-09-06 09:00:00',
        ),
        anomaly(
          'b-review',
          '钱七',
          'B楼',
          '补卡审批未通过',
          '2026-09-07 09:00:00',
        ),
      ],
    });
    const text = JSON.stringify(card);

    expect(card.header.template).toBe('red');
    expect(text).toContain('上周考勤通晒');
    expect(text).toContain('异常 5 人 · 6 项');
    expect(text).toContain('迟到 2');
    expect(text).toContain('早退 1');
    expect(text).toContain('未打卡且未补卡 2');
    expect(text).toContain('其他待核验 1');
    expect(text).toContain('C楼');
    expect(text).toContain('张三×2');
    expect(text).toContain('110站');
    expect(text).toContain('已补卡并转为正常的记录不计入');
    expect(text).toContain('异常跟进');
    expect(text).toContain(
      'https://sm.example.com/attendance-anomaly-follow-up',
    );
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(30 * 1024);
  });

  it('still sends a green monthly card when the period has records but no anomaly', () => {
    const card = buildAttendancePeriodicSummaryCard({
      period: 'monthly',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      fetchedAt: '2026-09-01 10:00',
      checkedCount: 520,
      anomalies: [],
    });
    const text = JSON.stringify(card);

    expect(card.header.template).toBe('green');
    expect(text).toContain('上月考勤通晒');
    expect(text).toContain('未发现迟到、早退或未打卡且未补卡');
    expect(text).toContain('共核验 520 项');
  });

  it('never labels an empty archive period as normal', () => {
    const card = buildAttendancePeriodicSummaryCard({
      period: 'weekly',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      fetchedAt: '2026-09-08 10:00',
      checkedCount: 0,
      anomalies: [],
    });
    const text = JSON.stringify(card);

    expect(card.header.template).toBe('orange');
    expect(text).toContain('暂无可核验记录');
    expect(text).not.toContain('未发现迟到');
  });

  it('keeps a large or dirty period within the Feishu card size limit', () => {
    const anomalies = Array.from({ length: 1_200 }, (_, index) =>
      anomaly(
        `dirty-${index}`,
        `超长姓名${String(index).padStart(4, '0')}${'甲'.repeat(80)}`,
        `异常楼栋${index % 30}`,
        index % 2 === 0 ? '迟到' : '未打卡',
        '2026-08-15 09:00:00',
      ),
    );

    const card = buildAttendancePeriodicSummaryCard({
      period: 'monthly',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      fetchedAt: '2026-09-01 10:00',
      checkedCount: 2_000,
      anomalies,
    });
    const text = JSON.stringify(card);

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(30 * 1024);
    expect(text).toContain('另 23 个楼栋');
    expect(text).toContain('异常 1200 人 · 1200 项');
  });
});
