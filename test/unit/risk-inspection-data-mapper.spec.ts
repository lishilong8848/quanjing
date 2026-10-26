import type { BitableRecordItem } from '../../server/common/feishu/bitable-direct-read';
import type { ActivePersonnelDirectory } from '../../server/modules/bitable-sync/active-personnel-directory';
import {
  mapAliMonthlyQualityDataset,
  mapAliMonthlyQualityRatings,
  mapAliRiskInspectionDashboard,
  mapCrossInspectionGuides,
  mapCrossInspectionDashboard,
} from '../../server/modules/risk-inspection/risk-inspection.mapper';

function record(
  recordId: string,
  fields: Record<string, unknown>,
): BitableRecordItem {
  return { record_id: recordId, fields };
}

function personnelDirectory(
  entries: Array<{
    recordId: string;
    name: string;
    buildings: Array<'A' | 'B' | 'C' | 'D' | 'E' | 'H' | '110'>;
  }>,
): ActivePersonnelDirectory {
  return {
    personnel: entries.map((entry) => ({
      ...entry,
      openId: `open-${entry.recordId}`,
      employeeNo: null,
      position: '运维值班员',
      systemPosition: '',
      supervisorNames: [],
    })),
    managers: [],
    snapshot: { fetchedAt: 1, expiresAt: 2, stale: false },
    quality: {
      sourceRecordCount: entries.length,
      activeRecordCount: entries.length,
      inactiveRecordCount: 0,
      usablePersonnelCount: entries.length,
      managerCount: 0,
      missingNameCount: 0,
      missingOpenIdCount: 0,
      duplicateOpenIdCount: 0,
      missingBuildingCount: 0,
    },
  };
}

describe('risk inspection data mapper', () => {
  test('maps monthly quality ratings from formula values without leaking raw fields', () => {
    const result = mapAliMonthlyQualityRatings([
      record('rating-b-july', {
        年份: '2026年',
        月份: '7月',
        楼栋: 'B楼',
        评分: 'A+',
        '累计A+数量': { type: 2, value: [1] },
        是否属于近期: {
          type: 1,
          value: [{ type: 'text', text: '√' }],
        },
        file_token: 'must-not-leak',
      }),
      record('rating-a-august', {
        年份: '2026年',
        月份: '8月',
        楼栋: 'A楼',
        '累计A+数量': { type: 2, value: [2] },
      }),
    ]);

    expect(result).toEqual([
      {
        id: 'rating-b-july',
        year: '2026年',
        month: '7月',
        building: 'B楼',
        grade: 'A+',
        cumulativeAPlus: 1,
        recent: true,
      },
      {
        id: 'rating-a-august',
        year: '2026年',
        month: '8月',
        building: 'A楼',
        grade: '',
        cumulativeAPlus: 2,
        recent: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('type');
    expect(JSON.stringify(result)).not.toContain('value');
  });

  test('combines issue and rating records without selecting empty future rating months', () => {
    const result = mapAliMonthlyQualityDataset(
      [
        record('quality-b-july', {
          月份: '7月',
          检查项目: '值班纪律',
          楼栋: 'B楼',
          问题: '交接班记录不完整',
        }),
      ],
      [
        record('rating-b-july', {
          年份: '2026年',
          月份: '7月',
          楼栋: 'B楼',
          评分: 'A+',
          '累计A+数量': { type: 2, value: [1] },
        }),
        record('rating-b-august', {
          年份: '2026年',
          月份: '8月',
          楼栋: 'B楼',
          '累计A+数量': { type: 2, value: [1] },
        }),
      ],
      {
        syncedAt: '2026-08-26T08:00:00.000Z',
        sources: {
          issues: { status: 'fresh', sourceUpdatedAt: null, warning: '' },
          ratings: { status: 'fresh', sourceUpdatedAt: null, warning: '' },
        },
      },
    );

    expect(result.ratings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'rating-b-july',
          grade: 'A+',
          cumulativeAPlus: 1,
        }),
      ]),
    );
    expect(result.options.years).toEqual(['2026年']);
    expect(result.options.months).toEqual(['7月']);
    expect(result.sources).toEqual({
      issues: { status: 'fresh', sourceUpdatedAt: null, warning: '' },
      ratings: { status: 'fresh', sourceUpdatedAt: null, warning: '' },
    });
  });

  test('maps monthly quality fields and strips Feishu evidence credentials', () => {
    const result = mapAliMonthlyQualityDataset(
      [
        record('quality-a-july', {
          月份: '7月',
          检查项目: '值班纪律',
          楼栋: 'A楼',
          问题: '夜班人员瞌睡',
          问题补充描述: '已完成提醒谈话',
          附件: [
            {
              name: '记录.jpg',
              size: 1024,
              type: 'image/jpeg',
              file_token: 'hidden-file-token',
              tmp_url: 'https://example.invalid/temporary',
            },
          ],
          问题图片: [
            {
              name: '现场.jpg',
              size: 2048,
              type: 'image/jpeg',
              file_token: 'hidden-image-token',
            },
          ],
          更新时间: '2026-07-31T02:00:00.000Z',
        }),
      ],
      { syncedAt: '2026-08-26T08:00:00.000Z' },
    );

    expect(result.issues[0]).toEqual({
      id: 'quality-a-july',
      month: '7月',
      building: 'A楼',
      item: '值班纪律',
      issue: '夜班人员瞌睡',
      supplemental: '已完成提醒谈话',
      attachments: [
        {
          name: '记录.jpg',
          size: 1024,
          mimeType: 'image/jpeg',
          url: '/api/risk-inspection/ali-monthly-quality/evidence/quality-a-july/attachment/0',
        },
      ],
      images: [
        {
          name: '现场.jpg',
          size: 2048,
          mimeType: 'image/jpeg',
          url: '/api/risk-inspection/ali-monthly-quality/evidence/quality-a-july/image/0',
        },
      ],
      responsiblePersons: [],
      personMatchStatus: 'none',
    });
    expect(result.sourceUpdatedAt).toBe('2026-07-31T02:00:00.000Z');
    expect(JSON.stringify(result)).not.toContain('hidden-file-token');
    expect(JSON.stringify(result)).not.toContain('hidden-image-token');
    expect(JSON.stringify(result)).not.toContain('example.invalid');
  });

  test('links exact personnel mentions by stable record id and disambiguates duplicate names by building', () => {
    const directory = personnelDirectory([
      { recordId: 'person-zhang', name: '示例人员008', buildings: ['A'] },
      { recordId: 'person-wang-a', name: '王伟', buildings: ['A'] },
      { recordId: 'person-wang-b', name: '王伟', buildings: ['B'] },
    ]);
    const result = mapAliMonthlyQualityDataset(
      [
        record('quality-a-people', {
          月份: '7月',
          检查项目: '值班纪律',
          楼栋: 'A楼',
          问题: '示例人员008睡岗，王伟未按规定巡检',
        }),
        record('quality-e-ambiguous', {
          月份: '7月',
          检查项目: '值班纪律',
          楼栋: 'E楼',
          问题: '王伟未按规定巡检',
        }),
      ],
      {
        syncedAt: '2026-08-26T08:00:00.000Z',
        personnelDirectory: directory,
      },
    );

    expect(result.issues[0]).toMatchObject({
      responsiblePersons: [
        { recordId: 'person-zhang', name: '示例人员008' },
        { recordId: 'person-wang-a', name: '王伟' },
      ],
      personMatchStatus: 'matched',
    });
    expect(result.issues[1]).toMatchObject({
      responsiblePersons: [],
      personMatchStatus: 'ambiguous',
    });
    expect(JSON.stringify(result)).not.toContain('open-person');
  });

  test('orders monthly quality options and reports missing descriptions', () => {
    const result = mapAliMonthlyQualityDataset(
      [
        record('quality-a-july', {
          月份: '7月',
          检查项目: '值班纪律',
          楼栋: 'A',
          问题: '夜班人员瞌睡',
          问题补充描述: '已处理',
        }),
        record('quality-b-june', {
          月份: '6',
          检查项目: '表单记录',
          楼栋: '南通B楼',
          问题: '维护单漏填',
        }),
      ],
      { syncedAt: '2026-08-26T08:00:00.000Z' },
    );

    expect(result.options).toEqual({
      years: [],
      months: ['7月', '6月'],
      buildings: ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'],
      items: ['值班纪律', '表单记录'],
    });
    expect(result.warnings).toContain('1 条记录缺少问题补充描述');
  });

  test('maps Ali risk records and derives dashboard metrics from source data', () => {
    const result = mapAliRiskInspectionDashboard(
      [
        record('ali-completed-july', {
          是否录入方舟: true,
          发现时间: '2026-07-01',
          专业: '电气专业',
          楼栋: 'A',
          风险等级: '中',
          风险状态: '已完成',
          '风险&问题内容描述': '配电柜隐患已完成整改',
          现场跟进人: '示例人员008',
          截止日期: '2026-07-05',
          实际关闭日期: '2026-07-04',
          最后更新日期: '2026-07-04T01:00:00.000Z',
        }),
        record('ali-rectifying-july', {
          是否录入方舟: false,
          发现时间: 1784044800000,
          专业: ['消防专业'],
          楼栋: 'B',
          风险等级: '低',
          风险状态: '整改中',
          '风险&问题内容描述': '消防通道堆物',
          '跟进人（飞书）': [{ name: '示例人员013', open_id: 'sensitive-open-id' }],
          截止日期: '2026-07-10',
        }),
        record('ali-suspended-june', {
          发现时间: '2026-06-20',
          专业: 'EHS',
          楼栋: '园区级',
          风险等级: '超低',
          风险状态: '已挂起',
          '风险&问题内容描述': '待外部条件具备后处理',
          阿里跟进人: '示例人员017',
          截止日期: '2026-07-20',
        }),
        record('ali-completed-june', {
          是否录入方舟: true,
          发现时间: '2026-06-01',
          专业: '消防专业',
          楼栋: 'C',
          风险等级: '中',
          风险状态: '已完成',
          '风险&问题内容描述': '历史问题已闭环',
          现场跟进人: '赵六',
          截止日期: '2026-06-10',
          实际关闭日期: '2026-06-09',
        }),
      ],
      {
        month: '2026-07',
        syncedAt: '2026-07-18T02:00:00.000Z',
        asOfDate: '2026-07-18',
      },
    );

    expect(result.summary).toEqual({
      historyTotal: 4,
      unrecorded: 2,
      monthlyAdded: 2,
      rectificationRate: 66.7,
      monthlyClosed: 1,
    });
    const issues = Reflect.get(result, 'issues') as
      | Array<{ id: string }>
      | undefined;
    expect(issues).toEqual(expect.any(Array));
    expect(issues?.map(({ id }) => id)).toEqual([
      'ali-completed-july',
      'ali-rectifying-july',
      'ali-suspended-june',
      'ali-completed-june',
    ]);
    expect(issues).toHaveLength(result.summary.historyTotal);
    expect(result.severityDistribution).toEqual([
      { key: 'medium', label: '中风险', value: 2 },
      { key: 'low', label: '低风险', value: 1 },
      { key: 'ultra-low', label: '超低风险', value: 1 },
    ]);
    expect(result.statusDistribution).toEqual([
      { key: 'completed', label: '已完成', value: 1 },
      { key: 'rectifying', label: '整改中', value: 1 },
    ]);
    expect(
      result.statusDistribution.reduce((total, item) => total + item.value, 0),
    ).toBe(result.summary.monthlyAdded);
    expect(result.unresolvedIssues.map((issue) => issue.id)).toEqual([
      'ali-rectifying-july',
      'ali-suspended-june',
    ]);
    expect(result.overdueIssues).toHaveLength(1);
    expect(result.overdueIssues[0]).toMatchObject({
      id: 'ali-rectifying-july',
      specialty: '消防',
      building: 'B楼',
      level: 'low',
      status: 'rectifying',
      owner: '—',
      overdueDays: 8,
    });
    expect(result.options).toEqual({
      specialties: ['EHS', '消防', '电气'],
      levels: ['low', 'medium', 'ultra-low'],
      statuses: ['rectifying', 'suspended'],
    });
    expect(result.sourceUpdatedAt).toBe('2026-07-04T01:00:00.000Z');
    expect(JSON.stringify(result)).not.toContain('sensitive-open-id');
  });

  test('maps cross-inspection building totals from the same issue rows shown in the drill-down list', () => {
    const result = mapCrossInspectionDashboard(
      [
        record('cross-a-1', {
          月份: '6',
          楼栋: '南通A楼',
          类型: '其他',
          检查范围: '消防安全',
          问题: '消防通道堆物',
          问题提交人: [{ name: '孙小帅', open_id: 'hidden-open-id' }],
          整改情况: '已补齐',
          当月问题数量: [4],
          当月问题整改完成数量: [4],
          整改率: [1],
          创建时间: '2026-06-03T01:00:00.000Z',
        }),
        record('cross-a-2', {
          月份: ['6'],
          楼栋: ['南通A楼'],
          类型: '演练',
          检查范围: '标识管理',
          问题: '标识模糊',
          问题提交人: [{ name: '李勇' }],
          整改情况: '',
          当月问题数量: [4],
          当月问题整改完成数量: [4],
          整改率: [1],
        }),
        record('cross-c-1', {
          月份: '6',
          楼栋: '南通C楼',
          类型: '变更',
          检查范围: '设备运行',
          问题: 'PDU风扇异响',
          问题提交人: [{ name: '王伟' }],
          整改情况: '重新培训演练',
          当月问题数量: [11],
          当月问题整改完成数量: [7],
          整改率: [0.63636],
        }),
        record('cross-c-may', {
          月份: '5',
          楼栋: '南通C楼',
          类型: '其他',
          检查范围: '用电安全',
          问题: '历史配电问题',
          问题提交人: [{ name: '刘洋' }],
          整改情况: '',
          当月问题数量: [8],
          当月问题整改完成数量: [6],
          整改率: [0.75],
        }),
        record('cross-a-may-closed', {
          月份: '5',
          楼栋: '南通A楼',
          类型: '其他',
          检查范围: '通道管理',
          问题: '历史问题已完成整改',
          问题提交人: [{ name: '示例人员008' }],
          整改情况: '已更新',
        }),
        record('cross-c-july-open', {
          月份: '7',
          楼栋: '南通C楼',
          类型: '其他',
          检查范围: '设备运行',
          问题: '筛选月之后新增的待整改问题',
          问题提交人: [{ name: '赵雷' }],
          整改情况: '',
        }),
      ],
      {
        month: '6月',
        syncedAt: '2026-07-18T02:00:00.000Z',
      },
    );

    expect(result.summary).toEqual({
      historyTotal: 6,
      monthlyTotal: 3,
      legacyTotal: 1,
      closureRate: 50,
    });
    expect(result.issues).toHaveLength(result.summary.historyTotal);
    expect(
      result.issues.filter(({ month }) => month === result.selectedMonth),
    ).toHaveLength(result.summary.monthlyTotal);
    expect(result.buildingRectification).toEqual([
      {
        building: 'A楼',
        issueCount: 2,
        completedCount: 1,
        rate: 50,
      },
      {
        building: 'C楼',
        issueCount: 1,
        completedCount: 1,
        rate: 100,
      },
    ]);
    expect(result.legacyIssues.map((issue) => issue.id)).toEqual([
      'cross-c-may',
    ]);
    expect(result.legacyIssues).toHaveLength(result.summary.legacyTotal);
    expect(result.issues[0]).toMatchObject({
      id: 'cross-a-1',
      building: 'A楼',
      month: '6月',
      tag: '消防安全',
      type: '其他',
      description: '消防通道堆物',
      owner: '孙小帅',
      status: 'closed',
    });
    expect(result.options).toEqual({
      buildings: ['A楼', 'C楼'],
      months: ['7月', '6月', '5月'],
      types: ['其他', '演练', '变更'],
    });
    expect(JSON.stringify(result)).not.toContain('hidden-open-id');
  });

  test('treats every non-empty rectification result as closed and keeps empty rows unresolved', () => {
    const result = mapCrossInspectionDashboard(
      [
        record('closed-by-update', {
          月份: '6',
          楼栋: '南通A楼',
          整改情况: '已更新应急预案',
        }),
        record('closed-by-training', {
          月份: '6',
          楼栋: '南通B楼',
          整改情况: '重新培训并完成演练',
        }),
        record('still-open', {
          月份: '6',
          楼栋: '南通C楼',
          整改情况: '',
        }),
      ],
      {
        month: '6月',
        syncedAt: '2026-07-20T00:00:00.000Z',
      },
    );

    expect(result.issues.map(({ status }) => status)).toEqual([
      'closed',
      'closed',
      'unresolved',
    ]);
    expect(result.summary.closureRate).toBe(66.7);
  });

  test('calculates closure rate from the full ledger instead of the selected month only', () => {
    const result = mapCrossInspectionDashboard(
      [
        record('historical-closed', {
          月份: '5',
          整改情况: '已销项',
        }),
        record('current-open', {
          月份: '6',
          整改情况: '',
        }),
      ],
      {
        month: '6月',
        syncedAt: '2026-07-20T00:00:00.000Z',
      },
    );

    expect(result.summary).toMatchObject({
      historyTotal: 2,
      monthlyTotal: 1,
      closureRate: 50,
    });
  });

  test('maps the three Base guide tables into one searchable guide contract', () => {
    const result = mapCrossInspectionGuides({
      system: [
        record('system-1', {
          风险编号: 'GL-RYZZ-RY-1',
          一级分类: '管理风险',
          二级分类: '人员组织管理',
          三级分类: '人员信息管理',
          检查项: '核查人员资质及证照档案。',
          风险等级: '中',
          排查周期: '季度',
          检查方法: '现场核查',
          是否适用: '适用',
        }),
      ],
      ali: [
        record('ali-guide-1', {
          文本: 'ALI-001',
          专业: '弱电',
          类别: '电气系统',
          设备名称: '系统供电',
          检查项目: '检查配电回路单点故障。',
          参考标准: '主备服务器应采用双路 UPS 供电。',
          检查方法: '现场检查',
        }),
      ],
      environment: [
        record('environment-1', {
          序号: 'XCHJ-001',
          检查项: '卫生环境',
          检查细项: '机房各区域应干净整洁。',
        }),
        record('environment-empty', {}),
      ],
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: 'system:system-1',
        source: 'system',
        code: 'GL-RYZZ-RY-1',
        category: '管理风险',
        subcategory: '人员组织管理 / 人员信息管理',
        item: '核查人员资质及证照档案。',
        level: '中',
        cycle: '季度',
        method: '现场核查',
      }),
      expect.objectContaining({
        id: 'ali:ali-guide-1',
        source: 'ali',
        code: 'ALI-001',
        category: '弱电',
        subcategory: '电气系统 / 系统供电',
        item: '检查配电回路单点故障。',
        standard: '主备服务器应采用双路 UPS 供电。',
      }),
      expect.objectContaining({
        id: 'environment:environment-1',
        source: 'environment',
        code: 'XCHJ-001',
        category: '卫生环境',
        item: '机房各区域应干净整洁。',
      }),
    ]);
  });
});
