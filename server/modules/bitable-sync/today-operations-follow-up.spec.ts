import { UnauthorizedException } from '@nestjs/common';
import {
  buildAttendanceFollowUpEvents,
  buildPatrolFollowUpEvent,
} from './today-operations-follow-up';
import {
  buildTodayOperationsFollowUpUrl,
  issueTodayOperationsFollowUpTicket,
  verifyTodayOperationsFollowUpTicket,
} from './today-operations-follow-up.ticket';
import { renderTodayOperationsFollowUpPage } from './today-operations-follow-up.page';
import type { AttendanceSummarySection } from '../duty-schedule/attendance-automation.card';
import type { DailyOperationsPatrolReport } from '../duty-schedule/daily-operations-patrol.types';

const secret = 'test-follow-up-secret-value-123456';

describe('unified today operations follow-up', () => {
  it('maps patrol alerts into one stable daily event and ignores normal checks', () => {
    const report: DailyOperationsPatrolReport = {
      businessDate: '2026-09-09',
      startDate: '2026-09-09',
      endDate: '2026-09-16',
      generatedAt: '2026-09-09T01:30:00.000Z',
      evaluatedFacilityPoints: 100,
      totalIssues: 1,
      hasAlerts: true,
      checks: [
        {
          key: 'facility',
          label: '用电 / PUE / 水耗',
          status: 'normal',
          count: 0,
          summary: '正常',
          issues: [],
        },
        {
          key: 'schedule',
          label: '排班连班风险',
          status: 'alert',
          count: 1,
          summary: '1 项',
          issues: [
            {
              id: 'schedule-risk-001',
              check: 'schedule',
              title: '夜班后接白班',
              detail: 'H楼 莫振豪存在连班风险',
              date: '2026-09-09',
              severity: 'warning',
            },
          ],
        },
      ],
    };

    const first = buildPatrolFollowUpEvent(report);
    const second = buildPatrolFollowUpEvent({
      ...report,
      generatedAt: '2026-09-09T01:35:00.000Z',
    });

    expect(first?.followUpSource).toBe('每日巡视');
    expect(first?.businessDate).toBe('2026-09-09');
    expect(first?.anomalies).toHaveLength(1);
    expect(first?.anomalies[0]).toMatchObject({
      metricKey: 'dailyPatrol.schedule.schedule-risk-001',
      metricLabel: '夜班后接白班',
      scope: 'H楼',
      details: ['H楼 莫振豪存在连班风险'],
    });
    expect(first?.anomalyEventId).toBe(second?.anomalyEventId);
  });

  it('groups attendance anomalies by business date and keeps building and reason evidence', () => {
    const sections: AttendanceSummarySection[] = [
      attendanceSection('今日白班', '2026-09-09', '邱少剑', '110站', '迟到'),
      attendanceSection('昨日白班', '2026-09-08', '张文豪', 'C楼', '未打卡'),
    ];

    const events = buildAttendanceFollowUpEvents(
      sections,
      '2026-09-09T01:35:00.000Z',
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      businessDate: '2026-09-08',
      followUpSource: '考勤通晒',
    });
    expect(events[1].anomalies[0]).toMatchObject({
      businessDate: '2026-09-09',
      scope: '110站',
      details: ['白班 上班：迟到'],
    });
  });

  it('issues a scoped ticket and rejects tampering, expiry, and overlong ranges', () => {
    const ticket = issueTodayOperationsFollowUpTicket(
      {
        from: '2026-09-01',
        through: '2026-09-09',
        issuedAt: Date.parse('2026-09-09T02:00:00.000Z'),
      },
      secret,
    );
    expect(
      verifyTodayOperationsFollowUpTicket(ticket, secret, {
        now: Date.parse('2026-09-09T02:10:00.000Z'),
      }),
    ).toMatchObject({ from: '2026-09-01', through: '2026-09-09' });
    expect(() =>
      verifyTodayOperationsFollowUpTicket(`${ticket}x`, secret, {
        now: Date.parse('2026-09-09T02:10:00.000Z'),
      }),
    ).toThrow(UnauthorizedException);
    expect(() =>
      verifyTodayOperationsFollowUpTicket(ticket, secret, {
        now: Date.parse('2026-09-10T02:01:00.000Z'),
        maxAgeMs: 24 * 60 * 60_000,
      }),
    ).toThrow('已过期');
    expect(() =>
      issueTodayOperationsFollowUpTicket(
        {
          from: '2026-01-01',
          through: '2026-09-09',
          issuedAt: Date.now(),
        },
        secret,
      ),
    ).toThrow('日期范围');
  });

  it('builds an HTTPS deep link without retaining unrelated query parameters', () => {
    const url = new URL(
      buildTodayOperationsFollowUpUrl(
        'https://sm.example.com/base/?old=1#fragment',
        'abc.DEF',
      ),
    );
    expect(url.origin + url.pathname).toBe(
      'https://sm.example.com/base/attendance-anomaly-follow-up',
    );
    expect(url.searchParams.get('ticket')).toBe('abc.DEF');
    expect(url.searchParams.has('old')).toBe(false);
    expect(url.hash).toBe('');
  });

  it('uses the canonical Nantong host for the follow-up page', () => {
    const url = new URL(
      buildTodayOperationsFollowUpUrl(
        'https://www.sm.sjhl.online:3001/',
        'abc.DEF',
      ),
    );

    expect(url.origin + url.pathname).toBe(
      'https://sm.sjhl.online:3001/attendance-anomaly-follow-up',
    );
  });

  it('renders a lightweight modal page with explicit states, ticket scrubbing, idempotent saves, and exit fallback', () => {
    const html = renderTodayOperationsFollowUpPage({ ticket: 'abc.DEF' });

    expect(html).toContain('异常跟进');
    expect(html).toContain('history.replaceState');
    expect(html).toContain('loading');
    expect(html).toContain('submitting');
    expect(html).toContain('success');
    expect(html).toContain('error');
    expect(html).toContain('clientMutationId');
    expect(html).toContain('crypto.randomUUID');
    expect(html).toContain('x-follow-up-ticket');
    expect(html).toContain('window.close()');
    expect(html).toContain('history.back()');
    expect(html).not.toContain('飞书多维表');
  });
});

function attendanceSection(
  title: AttendanceSummarySection['title'],
  date: string,
  name: string,
  building: string,
  reason: '迟到' | '未打卡',
): AttendanceSummarySection {
  return {
    title,
    date,
    normalCount: 0,
    anomalies: [
      {
        key: `${date}:${building}:white:OnDuty:${name}`,
        name,
        building,
        shiftLabel: '白班',
        direction: 'OnDuty',
        expectedAt: `${date} 09:00:00`,
        status: 'on_duty',
        reason,
      },
    ],
  };
}
