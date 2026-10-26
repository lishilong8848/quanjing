import { buildAttendanceMorningBrief } from '../../server/modules/duty-schedule/attendance-morning-brief.card';
import {
  getNextAttendanceAutomationRun,
  buildLiveAttendanceWindow,
} from '../../server/modules/duty-schedule/attendance-automation.scheduler';
import { getTodayAttendanceFinalTasks } from '../../server/modules/duty-schedule/today-attendance.tasks';

const input = {
  reportDate: '2026-09-08',
  fetchedAt: '2026-09-08 09:30',
  scheduleUrl: 'https://example.test/monthly-schedule',
  dashboardUrl: 'https://example.test/today-operations-panorama',
  followUpUrl:
    'https://example.test/attendance-anomaly-follow-up?ticket=signed.ticket',
  archiveRecordCount: 40_000,
  sections: [
    {
      title: '昨日白班' as const,
      date: '2026-09-07',
      normalCount: 2,
      anomalies: [
        {
          key: 'one',
          name: '测试甲',
          building: 'H楼',
          shiftLabel: '白班',
          direction: 'OnDuty' as const,
          expectedAt: '2026-09-07 09:00:00',
          status: 'on_duty' as const,
          reason: '未打卡' as const,
        },
        {
          key: 'two',
          name: '测试甲',
          building: 'H楼',
          shiftLabel: '白班',
          direction: 'OffDuty' as const,
          expectedAt: '2026-09-07 18:00:00',
          status: 'on_duty' as const,
          reason: '未打卡' as const,
        },
      ],
    },
  ],
  patrol: null,
};

it('includes yesterday alarm tagging anomalies with a direct date link, but omits zero', () => {
  const alarmTagAnomalies = {
    date: '2026-09-07',
    count: 3,
    detailsUrl: 'https://example.test/alarm-tag-anomalies?date=2026-09-07',
  };
  const card = buildAttendanceMorningBrief(Object.assign({}, input, { alarmTagAnomalies }));
  const text = JSON.stringify(card);
  expect(text).toContain('昨日告警异常打标 3 项，需要跟踪处理');
  expect(text).toContain('2026-09-07');
  expect(text).toContain('查看告警异常');
  expect(text).toContain(alarmTagAnomalies.detailsUrl);
  expect(text).toContain('open_url');
  const zero = JSON.stringify(buildAttendanceMorningBrief(Object.assign({}, input, {
    alarmTagAnomalies: { ...alarmTagAnomalies, count: 0 },
  })));
  expect(zero).not.toContain('昨日告警异常');
  expect(zero).not.toContain('查看告警异常');
});

it('marks an otherwise normal card orange for alarm tags only', () => {
  const normal = {
    ...input,
    sections: [], archiveRecordCount: undefined,
    patrol: { businessDate: input.reportDate, startDate: input.reportDate, endDate: '2026-09-15', generatedAt: '2026-09-08T01:30:00Z', evaluatedFacilityPoints: 3, checks: [], totalIssues: 0, hasAlerts: false },
    alarmTagAnomalies: { date: '2026-09-07', count: 1, detailsUrl: 'https://example.test/alarm-tag-anomalies?date=2026-09-07' },
  };
  expect(buildAttendanceMorningBrief(normal).header.template).toBe('orange');
  expect(buildAttendanceMorningBrief({ ...normal, alarmTagAnomalies: { ...normal.alarmTagAnomalies, count: 0 } }).header.template).toBe('green');
});

it('moves only the morning final boundary to 09:30', () => {
  expect(
    getNextAttendanceAutomationRun(
      new Date('2026-09-08T01:29:59Z'),
    ).scheduledAt.toISOString(),
  ).toBe('2026-09-08T01:30:00.000Z');
  expect(
    buildLiveAttendanceWindow('morning-off-duty-check', '2026-09-08').end,
  ).toBe('2026-09-08 09:30:59');
  expect(
    getTodayAttendanceFinalTasks(new Date('2026-09-08T01:30:00Z')),
  ).toEqual(['morning-off-duty-check']);
});

it('groups by building and person, distinguishes directions, dates and capacity warning', () => {
  const card = buildAttendanceMorningBrief(input);
  const text = JSON.stringify(card);
  expect(text).toContain('南通每日运维巡视同步');
  expect(text).not.toContain('每日运维简报');
  expect(text).toContain('昨日白班');
  expect(text).toContain('2026-09-07');
  expect(text.match(/H楼/g)).toHaveLength(1);
  expect(text.match(/测试甲/g)).toHaveLength(1);
  expect(text).toContain('上班');
  expect(text).toContain('下班');
  expect(text).toContain('40,000');
  expect(text).toContain('备份');
  expect(text).toContain('巡视数据暂不可用');
  expect(card.header.template).toBe('orange');
  expect(card.body.elements.length).toBeLessThanOrEqual(5);
  expect(
    card.body.elements.every((element) => element.tag === 'column_set'),
  ).toBe(true);
  expect(text).toContain('text_tag');
  expect(text).toContain('异常跟进');
  expect(text).toContain('signed.ticket');
});

it('does not warn below capacity threshold and never labels uncollected data normal', () => {
  const text = JSON.stringify(
    buildAttendanceMorningBrief({
      ...input,
      archiveRecordCount: 39_999,
      sections: [],
      followUpUrl: '',
    }),
  );
  expect(text).not.toContain('请备份');
  expect(text).toContain('暂无核验记录');
  expect(text).not.toContain('未发现异常');
  expect(text).not.toContain('异常跟进');
});

it('labels attendance unavailable without hiding available patrol checks', () => {
  const card = buildAttendanceMorningBrief({
    ...input,
    archiveRecordCount: undefined,
    sections: [],
    attendanceUnavailableReason: '钉钉考勤数据拉取失败',
    patrol: {
      businessDate: '2026-09-08',
      startDate: '2026-09-08',
      endDate: '2026-09-15',
      generatedAt: '2026-09-08T01:30:00.000Z',
      evaluatedFacilityPoints: 21,
      checks: [
        {
          check: 'facility',
          label: '用电 / PUE / 水耗',
          status: 'normal',
          count: 0,
          issues: [],
        },
        {
          check: 'weather',
          label: '天气告警',
          status: 'normal',
          count: 0,
          issues: [],
        },
      ],
      totalIssues: 0,
      hasAlerts: false,
    },
  });
  const text = JSON.stringify(card);

  expect(text).toContain('考勤待核验');
  expect(text).toContain('钉钉考勤数据拉取失败');
  expect(text).toContain('用电 / PUE / 水耗');
  expect(text).toContain('天气告警');
  expect(text).not.toContain('考勤异常 0 项');
  expect(card.header.template).toBe('orange');
});

it('monthly training appears from the 25th for incomplete assessments only', () => {
  const trainingParticipation = [
    {
      building: 'A楼',
      people: 11,
      target: 11,
      trainingCompletionRate: 100,
      assessmentPassRate: 100,
    },
    {
      building: 'B楼',
      people: 10,
      target: 10,
      trainingCompletionRate: 75,
      assessmentPassRate: 0,
    },
    {
      building: 'D楼',
      people: 13,
      target: 13,
      trainingCompletionRate: 58.333,
      assessmentPassRate: 0,
    },
    {
      building: 'H楼',
      people: 8,
      target: 8,
      trainingCompletionRate: 66.7,
      assessmentPassRate: null,
    },
  ];
  const before = JSON.stringify(
    buildAttendanceMorningBrief({
      ...input,
      reportDate: '2026-09-24',
      trainingParticipation,
    }),
  );
  const due = JSON.stringify(
    buildAttendanceMorningBrief({
      ...input,
      reportDate: '2026-09-25',
      trainingParticipation,
    }),
  );
  const nextMonth = JSON.stringify(
    buildAttendanceMorningBrief({
      ...input,
      reportDate: '2026-10-01',
      trainingParticipation,
    }),
  );

  expect(before).not.toContain('月度培训进展');
  expect(nextMonth).not.toContain('月度培训进展');
  expect(due).toContain('月度培训进展 · 2026-09');
  expect(due).toContain('**B楼**　培训 75%　考核 0%');
  expect(due).toContain('**D楼**　培训 58.3%　考核 0%');
  expect(due).not.toContain('**A楼**　培训');
  expect(due).not.toContain('**H楼**　培训');
  expect(due).toContain('异常跟进');
});

it('monthly training omits the section when every assessment is complete', () => {
  const text = JSON.stringify(
    buildAttendanceMorningBrief({
      ...input,
      reportDate: '2026-09-26',
      trainingParticipation: [
        {
          building: 'A楼',
          people: 11,
          target: 11,
          trainingCompletionRate: 100,
          assessmentPassRate: 100,
        },
      ],
    }),
  );
  expect(text).not.toContain('月度培训进展');
});
