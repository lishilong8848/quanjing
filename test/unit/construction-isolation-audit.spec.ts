import { buildDailyIsolationAuditSummary } from '../../client/src/pages/ConstructionManagement/daily-isolation-audit';

describe('daily isolation audit summary', () => {
  it('keeps structured isolation audit details for the review dialog', () => {
    const feedback =
      '结论：不通过｜水印核验：不通过（缺失：项目/机房标题、地点）｜现场核验：不通过（未识别：隔离带、警示牌、施工铭牌）';
    const summary = buildDailyIsolationAuditSummary(feedback);

    expect(summary).toEqual({
      tone: 'issue',
      title: '挂牌隔离AI审核：需复核',
      description: '结论：不通过；水印核验：通过；现场核验：不通过',
      rawText: feedback,
      details: [
        {
          label: '结论',
          tone: 'issue',
          value: '不通过',
        },
        {
          label: '水印核验',
          tone: 'success',
          value: '通过',
        },
        {
          label: '现场核验',
          tone: 'issue',
          value: '不通过（未识别：隔离带、警示牌、施工铭牌）',
        },
      ],
    });
    expect(summary).toHaveProperty('rawText', feedback);
  });
});
