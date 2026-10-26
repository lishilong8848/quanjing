import { buildSystemMonthlyReportReviewOpinionModel } from '../../client/src/pages/SystemMonthlyReport/review-opinions.logic';

describe('system monthly report review opinions', () => {
  it('groups the two review rounds by room and falls back to schedule reviewer', () => {
    const model = buildSystemMonthlyReportReviewOpinionModel(
      ['南通-B', '南通-C'],
      [
        {
          recordId: 'rec-initial-b',
          year: 2026,
          month: 7,
          room: '南通-B',
          round: 'initial',
          reviewer: null,
          submittedAt: '2026-08-04T02:20:00.000Z',
          summary: '本轮审核未发现问题',
          conclusion: 'passed',
          issues: [],
          images: [],
        },
        {
          recordId: 'rec-recheck-b',
          year: 2026,
          month: 7,
          room: '南通-B',
          round: 'recheck',
          reviewer: { openId: 'ou_recheck', name: '顾晓磊' },
          submittedAt: '2026-08-06T02:20:00.000Z',
          summary: '事件问题',
          conclusion: 'has_issues',
          issues: [],
          images: [],
        },
      ] as any,
      [
        {
          recordId: 'sch-initial-b',
          year: 2026,
          month: 7,
          round: 'initial',
          room: '南通-B',
          reviewerRoom: '昆山',
          reviewer: { openId: 'ou_initial', name: '杨占山' },
          reviewDate: null,
        },
      ] as any,
      2026,
      7,
    );

    expect(model.rows).toHaveLength(2);
    expect(model.rows[0]).toMatchObject({
      room: '南通-B',
      initial: { reviewer: { openId: 'ou_initial', name: '杨占山' } },
      recheck: { reviewer: { openId: 'ou_recheck', name: '顾晓磊' } },
    });
    expect(model.summary).toEqual({
      totalRooms: 2,
      initialReviewedRooms: 1,
      recheckReviewedRooms: 1,
      issueRooms: 1,
    });
  });
});
