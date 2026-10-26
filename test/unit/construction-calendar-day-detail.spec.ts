import { buildCalendarDayDetail } from '../../client/src/pages/ConstructionManagement/calendar-day-detail';

describe('construction calendar day detail', () => {
  it('summarizes scheduled and attention projects for a clicked day', () => {
    const detail = buildCalendarDayDetail(new Date(2026, 4, 30), [
      {
        recordId: 'blocked-project',
        workContent: 'EA118-A楼挖潜机房施工',
        constructionCode: 'SG260505-1031',
        building: 'A楼',
        specialty: '其他',
        stageLabel: '施工准备',
        stageEvidence: '等待挂牌、审批单悬挂和物理隔离照片',
        missing: ['每日作业票校核'],
        blocked: true,
      },
      {
        recordId: 'normal-project',
        workContent: '测试',
        constructionCode: 'SG260505-1030',
        building: 'B楼',
        specialty: '电气',
        stageLabel: '施工过程',
        stageEvidence: '等待施工过程照片',
        missing: [],
        blocked: false,
      },
    ]);

    expect(detail.dateLabel).toBe('2026年5月30日');
    expect(detail.totalCount).toBe(2);
    expect(detail.attentionCount).toBe(1);
    expect(detail.rows).toEqual([
      {
        recordId: 'blocked-project',
        title: 'EA118-A楼挖潜机房施工',
        code: 'SG260505-1031',
        location: 'A楼 · 其他',
        stageLabel: '施工准备',
        stageEvidence: '等待挂牌、审批单悬挂和物理隔离照片',
        status: 'attention',
        statusLabel: '需跟进',
        missing: ['每日作业票校核'],
      },
      {
        recordId: 'normal-project',
        title: '测试',
        code: 'SG260505-1030',
        location: 'B楼 · 电气',
        stageLabel: '施工过程',
        stageEvidence: '等待施工过程照片',
        status: 'scheduled',
        statusLabel: '有施工',
        missing: [],
      },
    ]);
  });
});
