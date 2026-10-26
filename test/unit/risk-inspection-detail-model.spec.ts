import type {
  AliRiskIssue,
  CrossInspectionIssue,
} from '../../shared/risk-inspection.interface';
import {
  createAliIssueDetail,
  createCategoryDetail,
  createCrossBuildingDetail,
  createCrossIssueDetail,
  createDistributionDetail,
  createMetricDetail,
  createTrendDetail,
} from '../../client/src/pages/RiskInspectionDashboard/detail-model';

const aliIssue: AliRiskIssue = {
  id: 'risk-001',
  building: 'C楼',
  specialty: '电气',
  level: 'medium',
  levelLabel: '中风险',
  description: '配电柜接线松动，存在电气火灾隐患。',
  discoveredAt: '2026-07-02',
  dueAt: '2026-07-10',
  closedAt: null,
  owner: '张建国',
  status: 'rectifying',
  statusLabel: '整改中',
  overdueDays: 9,
  recordedInArk: false,
};

const crossIssue: CrossInspectionIssue = {
  id: 'cross-001',
  building: 'A楼',
  month: '6月',
  tag: '消防安全',
  type: '安全管理',
  description: '3F UPS电池房器材摆放不规范，防火门闭门器松动。',
  owner: '孙小帅',
  rectification: '待更换闭门器后复验',
  status: 'pending',
  createdAt: '2026-06-18',
};

describe('risk inspection detail model', () => {
  it('keeps every operational field when opening an Ali issue', () => {
    const detail = createAliIssueDetail(aliIssue);

    expect(detail.title).toBe('风险问题详情');
    expect(detail.description).toContain('risk-001');
    expect(detail.fields).toEqual(
      expect.arrayContaining([
        { label: '问题描述', value: aliIssue.description, wide: true },
        { label: '楼栋', value: 'C楼' },
        { label: '示例人员019', value: '张建国' },
        { label: '逾期情况', value: '已逾期 9 天' },
        { label: '方舟登记', value: '未登记' },
      ]),
    );
  });

  it('keeps the complete cross-inspection description and rectification', () => {
    const detail = createCrossIssueDetail(crossIssue);

    expect(detail.title).toBe('交叉互查问题详情');
    expect(detail.fields).toEqual(
      expect.arrayContaining([
        { label: '问题描述', value: crossIssue.description, wide: true },
        {
          label: '整改情况',
          value: '待更换闭门器后复验',
          wide: true,
        },
        { label: '问题提出人', value: '孙小帅' },
      ]),
    );
  });

  it('describes metric and distribution values with their context', () => {
    expect(
      createMetricDetail({
        title: '本月新增问题',
        value: '36',
        month: '2026-07',
        description: '统计当月发现的问题数量',
      }),
    ).toMatchObject({
      title: '本月新增问题',
      fields: [
        { label: '当前值', value: '36' },
        { label: '统计月份', value: '2026-07' },
        { label: '指标口径', value: '统计当月发现的问题数量', wide: true },
      ],
    });

    expect(
      createDistributionDetail({
        scope: '风险等级',
        label: '低风险',
        value: 175,
        total: 189,
      }),
    ).toMatchObject({
      title: '低风险 · 风险等级分布',
      fields: [
        { label: '数量', value: '175' },
        { label: '占比', value: '92.6%' },
        { label: '分布总数', value: '189' },
      ],
    });
  });

  it('describes trend, category and building chart data', () => {
    expect(createTrendDetail({ label: '7/13', value: 76.9 })).toMatchObject({
      title: '整改完成率趋势',
      fields: [
        { label: '统计周期', value: '7/13' },
        { label: '整改完成率', value: '76.9%' },
      ],
    });
    expect(
      createCategoryDetail({
        label: '电气',
        normal: 23,
        overdue: 5,
      }),
    ).toMatchObject({
      title: '电气 · 问题类型分布',
      fields: [
        { label: '普通问题', value: '23' },
        { label: '超期问题', value: '5' },
        { label: '问题合计', value: '28' },
      ],
    });
    expect(
      createCrossBuildingDetail({
        building: 'C楼',
        issueCount: 11,
        completedCount: 7,
        rate: 63.6,
      }),
    ).toMatchObject({
      title: 'C楼 · 整改情况',
      fields: [
        { label: '问题数量', value: '11' },
        { label: '已整改数量', value: '7' },
        { label: '整改率', value: '63.6%' },
      ],
    });
  });
});
