import {
  buildDailyOperationsPatrolCard,
  type DailyOperationsPatrolCardOptions,
} from './daily-operations-patrol.card';
import type {
  DailyOperationsPatrolCheckResult,
  DailyOperationsPatrolReport,
} from './daily-operations-patrol.types';

describe('daily operations patrol card', () => {
  it('renders a compact green card with all four normal checks', () => {
    const card = buildDailyOperationsPatrolCard(report([]), {
      dashboardUrl: 'https://sm.example.test/today-operations-panorama',
      scheduleUrl: 'https://sm.example.test/monthly-schedule',
    });
    const text = JSON.stringify(card);

    expect((card.header as any).template).toBe('green');
    expect(text).toContain('南通每日运维巡视同步 · 正常');
    expect(text).toContain('用电 / PUE / 水耗');
    expect(text).toContain('排班连班风险');
    expect(text).toContain('计划冲突');
    expect(text).toContain('天气告警');
    expect(text).toContain('未发现异常');
    expect(text).toContain('打开南通全景看板');
    expect(text).toContain('打开南通排班');
    expect(text).not.toContain('form');
    expect(text).not.toContain('workflowType');
  });

  it('renders a red card and caps expanded issue details at eight', () => {
    const issues = Array.from({ length: 10 }, (_, index) => ({
      id: `issue-${index + 1}`,
      check: 'facility' as const,
      title: `异常 ${index + 1}`,
      detail: `明细 ${index + 1}`,
      date: '2026-09-06',
      severity: 'warning' as const,
    }));
    const card = buildDailyOperationsPatrolCard(
      report([
        {
          key: 'facility',
          label: '用电 / PUE / 水耗',
          status: 'alert',
          count: 10,
          summary: '10 项需关注',
          issues,
        },
      ]),
      {
        followUpUrl:
          'https://sm.example.test/attendance-anomaly-follow-up?ticket=signed.ticket',
      },
    );
    const text = JSON.stringify(card);

    expect((card.header as any).template).toBe('red');
    expect(text).toContain('南通每日运维巡视同步 · 发现 10 项');
    expect(text).toContain('异常 8');
    expect(text).not.toContain('异常 9');
    expect(text).toContain('另 2 项请打开看板核对');
    expect(text).toContain('异常跟进');
    expect(text).toContain('signed.ticket');
  });

  it('omits navigation buttons when public URLs are unavailable', () => {
    const card = buildDailyOperationsPatrolCard(report([]), {});
    const text = JSON.stringify(card);

    expect(text).not.toContain('打开南通全景看板');
    expect(text).not.toContain('打开南通排班');
  });
});

function report(
  overrides: DailyOperationsPatrolCheckResult[],
): DailyOperationsPatrolReport {
  const byKey = new Map(overrides.map((item) => [item.key, item]));
  const checks: DailyOperationsPatrolCheckResult[] = [
    normal('facility', '用电 / PUE / 水耗'),
    normal('schedule', '排班连班风险'),
    normal('plan', '计划冲突'),
    normal('weather', '天气告警'),
  ].map((item) => byKey.get(item.key) || item);
  const totalIssues = checks.reduce((sum, item) => sum + item.count, 0);
  return {
    businessDate: '2026-09-07',
    startDate: '2026-09-07',
    endDate: '2026-09-14',
    generatedAt: '2026-09-07T01:30:05.000Z',
    evaluatedFacilityPoints: 13,
    checks,
    totalIssues,
    hasAlerts: totalIssues > 0,
  };
}

function normal(
  key: DailyOperationsPatrolCheckResult['key'],
  label: string,
): DailyOperationsPatrolCheckResult {
  return {
    key,
    label,
    status: 'normal',
    count: 0,
    summary: '检查完成',
    issues: [],
  };
}

const _optionsTypeCheck: DailyOperationsPatrolCardOptions = {};
void _optionsTypeCheck;
