import { buildAttendanceDailySummaryCard } from '../../server/modules/duty-schedule/attendance-automation.card';

describe('buildAttendanceDailySummaryCard', () => {
  it('renders the three dated attendance periods with an explicit normal state', () => {
    const card = buildAttendanceDailySummaryCard({
      reportDate: '2026-09-04',
      fetchedAt: '2026-09-04 09:05',
      label: '每日汇总',
      sections: [
        {
          title: '今日白班',
          date: '2026-09-04',
          anomalies: [],
          normalCount: 8,
        },
        {
          title: '昨日白班',
          date: '2026-09-03',
          anomalies: [],
          normalCount: 9,
        },
        {
          title: '昨日夜班',
          date: '2026-09-03',
          anomalies: [],
          normalCount: 4,
        },
      ],
      scheduleUrl: 'https://example.com/nantong/monthly-schedule',
    });

    const markdown = card.body.elements
      .filter((element) => element.tag === 'markdown')
      .map((element) => element.content);

    expect(card.header).toMatchObject({
      template: 'green',
      title: {
        content: '【每日汇总】南通园区考勤正常 · 2026-09-04',
      },
    });
    expect(markdown).toEqual([
      '**汇总日期 2026-09-04**　<font color="grey">数据截至 2026-09-04 09:05</font>',
      '**今日白班 · 2026-09-04**\n<font color="green">无异常</font>　｜　<font color="green">正常 8 项</font>',
      '**昨日白班 · 2026-09-03**\n<font color="green">无异常</font>　｜　<font color="green">正常 9 项</font>',
      '**昨日夜班 · 2026-09-03**\n<font color="green">无异常</font>　｜　<font color="green">正常 4 项</font>',
    ]);
  });
});
