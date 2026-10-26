import {
  buildDailyPersonnelCheckText,
  getConstructionCrewAuthorizationSummary,
} from '../../shared/construction-personnel-check';
import type { ConstructionCrewMemberItem } from '../../shared/api.interface';

describe('construction personnel check text', () => {
  it('reports only present construction crew members with their certificates', () => {
    const crewMembers: ConstructionCrewMemberItem[] = [
      {
        recordId: 'recCrew1',
        name: '张鹏',
        constructionCode: 'SG260505-1029',
        overviewRecordIds: [],
        phone: null,
        authorizationStartDate: '2026-06-01',
        authorizationEndDate: '2026-06-30',
        authorizationStatus: '授权有效',
        certificateSummary: '低压电工证、高处作业证',
        complianceStatus: '合规',
        issueSummary: null,
      },
      {
        recordId: 'recCrew2',
        name: '示例人员008伟',
        constructionCode: 'SG260505-1029',
        overviewRecordIds: [],
        phone: null,
        authorizationStartDate: '2026-06-01',
        authorizationEndDate: '2026-06-30',
        authorizationStatus: '授权有效',
        certificateSummary: '低压电工证',
        complianceStatus: '合规',
        issueSummary: null,
      },
      {
        recordId: 'recCrew3',
        name: '王成龙',
        constructionCode: 'SG260505-1029',
        overviewRecordIds: [],
        phone: null,
        authorizationStartDate: '2026-06-01',
        authorizationEndDate: '2026-06-30',
        authorizationStatus: '授权有效',
        certificateSummary: '高处作业证',
        complianceStatus: '合规',
        issueSummary: null,
      },
      {
        recordId: 'recCrew4',
        name: '杨建设',
        constructionCode: 'SG260505-1029',
        overviewRecordIds: [],
        phone: null,
        authorizationStartDate: '2026-06-01',
        authorizationEndDate: '2026-06-30',
        authorizationStatus: '授权有效',
        certificateSummary: '台账人员',
        complianceStatus: '合规',
        issueSummary: null,
      },
    ];

    const text = buildDailyPersonnelCheckText(
      crewMembers,
      ['recCrew1', 'recCrew2', 'recCrew3'],
      '',
    );

    expect(text).toBe(
      '已核对施工人员台账；今日参与施工（3人）：张鹏（低压电工证、高处作业证）、示例人员008伟（低压电工证）、王成龙（高处作业证）',
    );
    expect(text).not.toContain('未参与施工');
    expect(text).not.toContain('杨建设');
  });

  it('leaves certificate text blank when a present member has no certificate', () => {
    const crewMembers: ConstructionCrewMemberItem[] = [
      {
        recordId: 'recCrew1',
        name: '张鹏',
        constructionCode: 'SG260505-1029',
        overviewRecordIds: [],
        phone: null,
        authorizationStartDate: '2026-06-01',
        authorizationEndDate: '2026-06-30',
        authorizationStatus: '授权有效',
        certificateSummary: null,
        complianceStatus: null,
        issueSummary: null,
      },
    ];

    const text = buildDailyPersonnelCheckText(crewMembers, ['recCrew1'], '');

    expect(text).toBe('已核对施工人员台账；今日参与施工（1人）：张鹏');
    expect(text).not.toContain('证件未登记');
  });

  it('keeps expired roster members visible but excludes them from personnel check text', () => {
    const crewMembers: ConstructionCrewMemberItem[] = [
      {
        recordId: 'recCrewExpired',
        name: '示例人员013',
        constructionCode: 'SG260505-1041',
        overviewRecordIds: [],
        phone: null,
        authorizationStartDate: '2026-05-22',
        authorizationEndDate: '2026-07-20',
        authorizationStatus: '已过期',
        certificateSummary: '高处作业证',
        complianceStatus: '合规',
        issueSummary: null,
      },
    ];

    const summary = getConstructionCrewAuthorizationSummary(crewMembers);

    expect(summary).toMatchObject({
      totalCount: 1,
      authorizedCount: 0,
      expiredCount: 1,
      notice: '该项目授权人员已过期，需更新授权',
    });
    expect(summary.authorizedMembers).toEqual([]);
    expect(
      buildDailyPersonnelCheckText(crewMembers, ['recCrewExpired'], '旧草稿'),
    ).toBe('');
  });

  it('reports mixed authorization issues without hiding authorized members', () => {
    const crewMembers: ConstructionCrewMemberItem[] = [
      {
        recordId: 'recCrewValid',
        name: '张鹏',
        constructionCode: 'SG260505-1041',
        overviewRecordIds: [],
        phone: null,
        authorizationStartDate: '2026-07-21',
        authorizationEndDate: '2026-07-31',
        authorizationStatus: '授权有效',
        certificateSummary: '低压电工证',
        complianceStatus: '合规',
        issueSummary: null,
      },
      {
        recordId: 'recCrewFuture',
        name: '示例人员017',
        constructionCode: 'SG260505-1041',
        overviewRecordIds: [],
        phone: null,
        authorizationStartDate: '2026-07-28',
        authorizationEndDate: '2026-07-31',
        authorizationStatus: '未开始',
        certificateSummary: '动火作业证',
        complianceStatus: '合规',
        issueSummary: null,
      },
    ];

    const summary = getConstructionCrewAuthorizationSummary(crewMembers);

    expect(summary).toMatchObject({
      totalCount: 2,
      authorizedCount: 1,
      pendingCount: 1,
      notice: '该项目有 1 名人员授权尚未生效，暂不可参与今日核查',
    });
    expect(summary.authorizedMembers.map((member) => member.recordId)).toEqual([
      'recCrewValid',
    ]);
  });
});
