import {
  DEMO_MEETINGS,
  overviewStats,
  selectDemoMeetings,
  demoTrend,
} from '../../client/src/pages/MeetingManagement/overview-data';

describe('会议总览演示数据', () => {
  it('全部标记演示，数量与事项状态从同一明细计算', () => {
    expect(DEMO_MEETINGS).toHaveLength(68);
    expect(DEMO_MEETINGS.every((item) => item.isDemo)).toBe(true);
    expect(new Set(DEMO_MEETINGS.map((item) => item.id)).size).toBe(68);
    const stats = overviewStats(DEMO_MEETINGS);
    expect(stats.closed + stats.pending).toBe(stats.actions);
    expect(stats.minutes).toBe(
      DEMO_MEETINGS.filter((item) => item.hasMinutes).length,
    );
  });
  it('时间、范围和性质取交集，下钻与图表汇总一致', () => {
    const rows = selectDemoMeetings(DEMO_MEETINGS, {
      month: '2026-10',
      scope: '客户',
    });
    expect(
      rows.every(
        (item) => item.date.startsWith('2026-10') && item.scope === '客户',
      ),
    ).toBe(true);
    expect(
      demoTrend(DEMO_MEETINGS).reduce((sum, month) => sum + month.total, 0),
    ).toBe(68);
    expect(
      overviewStats(
        selectDemoMeetings(DEMO_MEETINGS, { query: '不存在的议题' }),
      ).meetings,
    ).toBe(0);
  });
});
