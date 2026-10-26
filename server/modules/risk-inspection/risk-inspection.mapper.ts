import type {
  AliMonthlyQualityDataset,
  AliMonthlyQualityEvidence,
  AliMonthlyQualityIssue,
  AliMonthlyQualityRating,
  AliRiskInspectionDashboard,
  AliRiskIssue,
  AliRiskLevel,
  AliRiskStatus,
  CrossBuildingRectification,
  CrossInspectionGuide,
  CrossInspectionGuideSource,
  CrossInspectionDashboard,
  CrossInspectionIssue,
  CrossRectificationStatus,
  RiskDistributionItem,
} from '../../../shared/risk-inspection.interface';
import {
  type BitableRecordItem,
  extractDateTimeIso,
  extractDateValue,
  extractDisplayText,
  extractDisplayValues,
  extractNumberValue,
  getRecordId,
  pickField,
} from '../../common/feishu/bitable-direct-read';
import type { ActivePersonnelDirectory } from '../bitable-sync/active-personnel-directory';

interface AliRiskMapperOptions {
  month: string;
  syncedAt: string;
  asOfDate?: string;
}

interface CrossInspectionMapperOptions {
  month?: string;
  syncedAt: string;
}

interface MappedCrossRecord {
  issue: CrossInspectionIssue;
}

export type CrossInspectionGuideRecords = Record<
  CrossInspectionGuideSource,
  BitableRecordItem[]
>;

const LEVEL_LABELS: Record<AliRiskLevel, string> = {
  'ultra-low': '超低风险',
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  unknown: '未分级',
};

const STATUS_LABELS: Record<AliRiskStatus, string> = {
  suspended: '已挂起',
  rectifying: '整改中',
  completed: '已完成',
  unknown: '状态未知',
};

const LEVEL_DISTRIBUTION_ORDER: AliRiskLevel[] = [
  'high',
  'medium',
  'low',
  'ultra-low',
  'unknown',
];

const LEVEL_OPTION_ORDER: AliRiskLevel[] = [
  'low',
  'medium',
  'high',
  'ultra-low',
  'unknown',
];

const STATUS_ORDER: AliRiskStatus[] = [
  'completed',
  'rectifying',
  'suspended',
  'unknown',
];

const QUALITY_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
] as const;

const QUALITY_ITEM_ORDER = ['值班纪律', '表单记录', '事件处理'] as const;

export function mapAliMonthlyQualityRatings(
  records: BitableRecordItem[],
): AliMonthlyQualityRating[] {
  return records.map((record) => {
    const fields = record.fields || {};
    const recent = extractDisplayText(fields['是否属于近期'])
      .trim()
      .toLowerCase();

    return {
      id: getRecordId(record),
      year: extractDisplayText(fields['年份']) || '未填写',
      month: normalizeMonth(extractDisplayText(fields['月份'])) || '未填写',
      building: normalizeBuilding(extractDisplayText(fields['楼栋'])),
      grade: extractDisplayText(fields['评分']),
      cumulativeAPlus: extractNumberValue(fields['累计A+数量']),
      recent: ['√', 'true', '是', '1'].includes(recent),
    };
  });
}

type AliMonthlyQualityMapperOptions = {
  syncedAt: string;
  sources?: AliMonthlyQualityDataset['sources'];
  personnelDirectory?: ActivePersonnelDirectory;
};

export function mapAliMonthlyQualityDataset(
  issueRecords: BitableRecordItem[],
  options: AliMonthlyQualityMapperOptions,
): AliMonthlyQualityDataset;
export function mapAliMonthlyQualityDataset(
  issueRecords: BitableRecordItem[],
  ratingRecords: BitableRecordItem[],
  options: AliMonthlyQualityMapperOptions,
): AliMonthlyQualityDataset;
export function mapAliMonthlyQualityDataset(
  issueRecords: BitableRecordItem[],
  ratingRecordsOrOptions: BitableRecordItem[] | AliMonthlyQualityMapperOptions,
  maybeOptions?: AliMonthlyQualityMapperOptions,
): AliMonthlyQualityDataset {
  const ratingRecords = Array.isArray(ratingRecordsOrOptions)
    ? ratingRecordsOrOptions
    : [];
  const options = Array.isArray(ratingRecordsOrOptions)
    ? maybeOptions!
    : ratingRecordsOrOptions;
  const issues = mapAliMonthlyQualityIssues(
    issueRecords,
    options.personnelDirectory,
  );
  const ratings = mapAliMonthlyQualityRatings(ratingRecords);
  const extraBuildings = unique([
    ...issues.map(({ building }) => building),
    ...ratings.map(({ building }) => building),
  ])
    .filter((building) => !QUALITY_BUILDINGS.includes(building as never))
    .sort(compareBuildingLabels);
  const items = unique(issues.map(({ item }) => item)).sort(
    (left, right) =>
      qualityItemIndex(left) - qualityItemIndex(right) ||
      left.localeCompare(right, 'zh-CN'),
  );
  const missingSupplemental = issues.filter(
    ({ supplemental }) => !supplemental,
  ).length;
  const issueSourceUpdatedAt = getLatestRecordDateTime(issueRecords, [
    '最后更新日期',
    '更新时间',
    '创建时间',
  ]);
  const ratingSourceUpdatedAt = getLatestRecordDateTime(ratingRecords, [
    '最后更新日期',
    '更新时间',
    '创建时间',
  ]);
  const sources = options.sources || {
    issues: {
      status: 'fresh' as const,
      sourceUpdatedAt: issueSourceUpdatedAt,
      warning: '',
    },
    ratings: {
      status: 'fresh' as const,
      sourceUpdatedAt: ratingSourceUpdatedAt,
      warning: '',
    },
  };
  const sourceWarnings = [
    sources.issues.warning,
    sources.ratings.warning,
  ].filter(Boolean);

  return {
    issues,
    ratings,
    options: {
      years: unique(
        ratings
          .filter(({ grade }) => Boolean(grade))
          .map(({ year }) => year)
          .filter((year) => year !== '未填写'),
      ).sort((left, right) => yearNumber(right) - yearNumber(left)),
      months: unique([
        ...issues.map(({ month }) => month),
        ...ratings
          .filter(({ grade }) => Boolean(grade))
          .map(({ month }) => month),
      ]).sort((left, right) => monthNumber(right) - monthNumber(left)),
      buildings: [...QUALITY_BUILDINGS, ...extraBuildings],
      items,
    },
    sources,
    sourceUpdatedAt: getLatestRecordDateTime(
      [...issueRecords, ...ratingRecords],
      ['最后更新日期', '更新时间', '创建时间'],
    ),
    syncedAt: options.syncedAt,
    sourceStatus:
      sources.issues.status === 'fresh' && sources.ratings.status === 'fresh'
        ? 'fresh'
        : 'stale',
    warnings: [
      ...sourceWarnings,
      ...(missingSupplemental > 0
        ? [`${missingSupplemental} 条记录缺少问题补充描述`]
        : []),
    ],
  };
}

export function mapAliMonthlyQualityIssues(
  records: BitableRecordItem[],
  personnelDirectory?: ActivePersonnelDirectory,
): AliMonthlyQualityIssue[] {
  return records.map((record) =>
    mapAliMonthlyQualityIssue(record, personnelDirectory),
  );
}

function mapAliMonthlyQualityIssue(
  record: BitableRecordItem,
  personnelDirectory?: ActivePersonnelDirectory,
): AliMonthlyQualityIssue {
  const fields = record.fields || {};
  const recordId = getRecordId(record);
  const building = normalizeBuilding(extractDisplayText(fields['楼栋']));
  const issue = extractDisplayText(fields['问题']) || '未填写';
  const supplemental = extractDisplayText(fields['问题补充描述']);
  const people = resolveQualityIssuePeople(
    `${issue} ${supplemental}`,
    building,
    personnelDirectory,
  );
  return {
    id: recordId,
    month: normalizeMonth(extractDisplayText(fields['月份'])) || '未填写',
    building,
    item: extractDisplayText(fields['检查项目']) || '其他',
    issue,
    supplemental,
    attachments: mapQualityEvidence(fields['附件'], recordId, 'attachment'),
    images: mapQualityEvidence(fields['问题图片'], recordId, 'image'),
    responsiblePersons: people.responsiblePersons,
    personMatchStatus: people.status,
  };
}

function mapQualityEvidence(
  value: unknown,
  recordId: string,
  kind: 'attachment' | 'image',
): AliMonthlyQualityEvidence[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Record<string, unknown>;
      const name = extractDisplayText(raw.name).trim();
      if (!name) return null;
      return {
        name,
        size:
          typeof raw.size === 'number' && Number.isFinite(raw.size)
            ? raw.size
            : null,
        mimeType: extractDisplayText(raw.type),
        url: `/api/risk-inspection/ali-monthly-quality/evidence/${encodeURIComponent(recordId)}/${kind}/${index}`,
      };
    })
    .filter((item): item is AliMonthlyQualityEvidence => Boolean(item));
}

function resolveQualityIssuePeople(
  description: string,
  building: string,
  personnelDirectory?: ActivePersonnelDirectory,
): {
  responsiblePersons: AliMonthlyQualityIssue['responsiblePersons'];
  status: AliMonthlyQualityIssue['personMatchStatus'];
} {
  const personnel = (personnelDirectory?.personnel || []).filter(
    ({ name, recordId, openId }) => Boolean(name && recordId && openId),
  );
  if (!description.trim() || personnel.length === 0) {
    return { responsiblePersons: [], status: 'none' };
  }

  const byName = new Map<string, typeof personnel>();
  personnel.forEach((entry) => {
    const name = entry.name.trim();
    if (!name || !description.includes(name)) return;
    const existing = byName.get(name) || [];
    existing.push(entry);
    byName.set(name, existing);
  });
  if (byName.size === 0) {
    return { responsiblePersons: [], status: 'none' };
  }

  const issueBuilding = normalizePersonnelBuilding(building);
  const matches: Array<{
    recordId: string;
    name: string;
    mentionIndex: number;
  }> = [];
  let ambiguous = false;
  byName.forEach((candidates, name) => {
    const buildingMatches = issueBuilding
      ? candidates.filter(({ buildings }) => buildings.includes(issueBuilding))
      : [];
    const resolved =
      candidates.length === 1
        ? candidates[0]
        : buildingMatches.length === 1
          ? buildingMatches[0]
          : null;
    if (!resolved) {
      ambiguous = true;
      return;
    }
    matches.push({
      recordId: resolved.recordId,
      name: resolved.name,
      mentionIndex: description.indexOf(name),
    });
  });

  if (ambiguous) {
    return { responsiblePersons: [], status: 'ambiguous' };
  }
  const seen = new Set<string>();
  const responsiblePersons = matches
    .sort(
      (left, right) =>
        left.mentionIndex - right.mentionIndex ||
        left.name.localeCompare(right.name, 'zh-CN'),
    )
    .filter(({ recordId }) => {
      if (seen.has(recordId)) return false;
      seen.add(recordId);
      return true;
    })
    .map(({ recordId, name }) => ({ recordId, name }));
  return { responsiblePersons, status: 'matched' };
}

function normalizePersonnelBuilding(
  building: string,
): ActivePersonnelDirectory['personnel'][number]['buildings'][number] | null {
  const normalized = building.replace(/^南通/u, '').trim();
  if (/^110(?:站|楼)?$/u.test(normalized)) return '110';
  const match = normalized.match(/^([ABCDEH])(?:楼)?$/iu);
  return match
    ? (match[1].toUpperCase() as ActivePersonnelDirectory['personnel'][number]['buildings'][number])
    : null;
}

function qualityItemIndex(item: string): number {
  const index = QUALITY_ITEM_ORDER.indexOf(item as never);
  return index === -1 ? QUALITY_ITEM_ORDER.length : index;
}

export function mapAliRiskInspectionDashboard(
  records: BitableRecordItem[],
  options: AliRiskMapperOptions,
): AliRiskInspectionDashboard {
  const asOfDate = options.asOfDate || formatShanghaiDate(new Date());
  const excludedFollowers = new Set(['姜嘉文', '赵华', '张建飞', '苏峻荣', '顾伟源', '顾海鹏', '尤新未']);
  const issues = records
    .filter(record => !extractDisplayValues(record.fields?.['现场跟进人'])
      .flatMap(value => value.split(/[、,，;；\n]/u))
      .some(name => excludedFollowers.has(name.trim())))
    .map(record => mapAliRiskIssue(record, asOfDate));
  const completedCount = issues.filter(
    ({ status }) => status === 'completed',
  ).length;
  const rectifyingCount = issues.filter(
    ({ status }) => status === 'rectifying',
  ).length;
  const eligibleForRectification = completedCount + rectifyingCount;
  const unresolvedIssues = issues
    .filter(({ status }) => status !== 'completed')
    .sort(compareRiskIssues);
  const overdueIssues = unresolvedIssues
    .filter(({ overdueDays }) => overdueDays > 0)
    .sort((left, right) => right.overdueDays - left.overdueDays);

  return {
    month: options.month,
    summary: {
      historyTotal: issues.length,
      unrecorded: issues.filter(({ recordedInArk }) => !recordedInArk).length,
      monthlyAdded: issues.filter(({ discoveredAt }) =>
        discoveredAt?.startsWith(options.month),
      ).length,
      rectificationRate:
        eligibleForRectification === 0
          ? 0
          : roundOne((completedCount / eligibleForRectification) * 100),
      monthlyClosed: issues.filter(({ closedAt }) =>
        closedAt?.startsWith(options.month),
      ).length,
    },
    severityDistribution: buildDistribution(
      issues.map(({ level }) => level),
      LEVEL_DISTRIBUTION_ORDER,
      LEVEL_LABELS,
    ),
    statusDistribution: buildDistribution(
      issues
        .filter(({ discoveredAt }) => discoveredAt?.startsWith(options.month))
        .map(({ status }) => status),
      STATUS_ORDER,
      STATUS_LABELS,
    ),
    issues,
    unresolvedIssues,
    overdueIssues,
    completionTrend: buildCompletionTrend(issues, asOfDate),
    categoryDistribution: buildCategoryDistribution(issues),
    options: {
      specialties: uniqueSorted(issues.map(({ specialty }) => specialty)),
      levels: LEVEL_OPTION_ORDER.filter((level) =>
        issues.some((issue) => issue.level === level),
      ),
      statuses: STATUS_ORDER.filter(
        (status) =>
          status !== 'completed' &&
          unresolvedIssues.some((issue) => issue.status === status),
      ),
    },
    sourceUpdatedAt: getLatestRecordDateTime(records, [
      '最后更新日期',
      '更新时间',
    ]),
    syncedAt: options.syncedAt,
    sourceStatus: 'fresh',
    warnings: [],
  };
}

export function mapCrossInspectionDashboard(
  records: BitableRecordItem[],
  options: CrossInspectionMapperOptions,
): CrossInspectionDashboard {
  const mapped = records.map(mapCrossInspectionRecord);
  const months = unique(
    mapped.map(({ issue }) => issue.month).filter(Boolean),
  ).sort((left, right) => monthNumber(right) - monthNumber(left));
  const selectedMonth =
    normalizeMonth(options.month) ||
    months[0] ||
    `${new Date().getMonth() + 1}月`;
  const selectedMonthNumber = monthNumber(selectedMonth);
  const issues = mapped.map(({ issue }) => issue);
  const selectedMonthIssues = issues.filter(
    ({ month }) => month === selectedMonth,
  );
  const legacyIssues = issues.filter(
    (issue) =>
      monthNumber(issue.month) < selectedMonthNumber &&
      issue.status !== 'closed',
  );
  const closedIssues = issues.filter(
    ({ status }) => status === 'closed',
  ).length;

  return {
    selectedMonth,
    summary: {
      historyTotal: issues.length,
      monthlyTotal: selectedMonthIssues.length,
      legacyTotal: legacyIssues.length,
      closureRate:
        issues.length === 0
          ? 0
          : roundOne((closedIssues / issues.length) * 100),
    },
    buildingRectification: buildBuildingRectification(mapped, selectedMonth),
    legacyIssues,
    issues,
    options: {
      buildings: unique(issues.map(({ building }) => building))
        .filter(Boolean)
        .sort(compareBuildingLabels),
      months,
      types: unique(issues.map(({ type }) => type)).filter(Boolean),
    },
    sourceUpdatedAt: getLatestRecordDateTime(records, ['创建时间', '更新时间']),
    syncedAt: options.syncedAt,
    sourceStatus: 'fresh',
    warnings: [],
  };
}

export function mapCrossInspectionGuides(
  records: CrossInspectionGuideRecords,
): CrossInspectionGuide[] {
  return (
    [
      ...records.system.map((record) =>
        mapCrossInspectionGuide(record, 'system'),
      ),
      ...records.ali.map((record) => mapCrossInspectionGuide(record, 'ali')),
      ...records.environment.map((record) =>
        mapCrossInspectionGuide(record, 'environment'),
      ),
    ] satisfies CrossInspectionGuide[]
  ).filter(({ code, item }) => code !== '—' || item !== '—');
}

function mapAliRiskIssue(
  record: BitableRecordItem,
  asOfDate: string,
): AliRiskIssue {
  const fields = record.fields || {};
  const rawLevel = extractDisplayText(
    pickField(fields, ['风险等级', '风险级别']),
  );
  const rawStatus = extractDisplayText(
    pickField(fields, ['风险状态', '当前状态']),
  );
  const dueAt = extractDateValue(
    pickField(fields, ['截止日期', '计划完成日期']),
  );
  const status = normalizeAliStatus(rawStatus);

  return {
    id: getRecordId(record),
    building: normalizeBuilding(
      extractDisplayText(pickField(fields, ['楼栋', '机楼'])),
    ),
    specialty: normalizeSpecialty(
      extractDisplayText(pickField(fields, ['专业', '问题归属'])),
    ),
    level: normalizeAliLevel(rawLevel),
    levelLabel: rawLevel ? ensureRiskSuffix(rawLevel) : '未分级',
    description:
      extractDisplayText(
        pickField(fields, ['风险&问题内容描述', '问题描述', '问题']),
      ) || '—',
    discoveredAt: extractDateValue(pickField(fields, ['发现时间', '发现日期'])),
    dueAt,
    closedAt: extractDateValue(pickField(fields, ['实际关闭日期', '关闭日期'])),
    owner:
      extractDisplayText(
        fields['现场跟进人'],
      ) || '—',
    status,
    statusLabel: rawStatus || STATUS_LABELS[status],
    overdueDays:
      status === 'completed' ? 0 : calculateOverdueDays(dueAt, asOfDate),
    recordedInArk: parseCheckbox(fields['是否录入方舟']),
  };
}

function mapCrossInspectionRecord(
  record: BitableRecordItem,
): MappedCrossRecord {
  const fields = record.fields || {};
  const rectification = extractDisplayText(fields['整改情况']);
  const issue: CrossInspectionIssue = {
    id: getRecordId(record),
    building: normalizeBuilding(extractDisplayText(fields['楼栋'])),
    month: normalizeMonth(extractDisplayText(fields['月份'])),
    tag: extractDisplayText(fields['检查范围']) || '其他',
    type: extractDisplayText(fields['类型']) || '其他',
    description: extractDisplayText(fields['问题']) || '—',
    owner: extractDisplayText(fields['问题提交人']) || '—',
    rectification,
    status: normalizeCrossStatus(rectification),
    createdAt: extractDateTimeIso(fields['创建时间']),
  };

  return { issue };
}

function mapCrossInspectionGuide(
  record: BitableRecordItem,
  source: CrossInspectionGuideSource,
): CrossInspectionGuide {
  const fields = record.fields || {};

  if (source === 'system') {
    return {
      id: `${source}:${getRecordId(record)}`,
      source,
      code: extractDisplayText(fields['风险编号']) || '—',
      category: extractDisplayText(fields['一级分类']) || '未分类',
      subcategory: joinGuideCategories([
        extractDisplayText(fields['二级分类']),
        extractDisplayText(fields['三级分类']),
      ]),
      item: extractDisplayText(fields['检查项']) || '—',
      standard: extractDisplayText(fields['备注']),
      method: extractDisplayText(fields['检查方法']),
      level: extractDisplayText(fields['风险等级']),
      cycle: extractDisplayText(fields['排查周期']),
      applicability: extractDisplayText(fields['是否适用']),
    };
  }

  if (source === 'ali') {
    return {
      id: `${source}:${getRecordId(record)}`,
      source,
      code: extractDisplayText(fields['文本']) || '—',
      category: extractDisplayText(fields['专业']) || '未分类',
      subcategory: joinGuideCategories([
        extractDisplayText(fields['类别']),
        extractDisplayText(fields['设备名称']),
      ]),
      item: extractDisplayText(fields['检查项目']) || '—',
      standard: extractDisplayText(fields['参考标准']),
      method: extractDisplayText(fields['检查方法']),
      level: '',
      cycle: '',
      applicability: '',
    };
  }

  return {
    id: `${source}:${getRecordId(record)}`,
    source,
    code: extractDisplayText(fields['序号']) || '—',
    category: extractDisplayText(fields['检查项']) || '未分类',
    subcategory: '',
    item: extractDisplayText(fields['检查细项']) || '—',
    standard: '',
    method: '现场检查',
    level: '',
    cycle: '',
    applicability: '',
  };
}

function joinGuideCategories(values: string[]): string {
  return values.filter(Boolean).join(' / ');
}

function buildBuildingRectification(
  records: MappedCrossRecord[],
  selectedMonth: string,
): CrossBuildingRectification[] {
  const groups = new Map<string, MappedCrossRecord[]>();
  for (const record of records) {
    if (record.issue.month !== selectedMonth || !record.issue.building) {
      continue;
    }
    const current = groups.get(record.issue.building) || [];
    current.push(record);
    groups.set(record.issue.building, current);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => compareBuildingLabels(left, right))
    .map(([building, buildingRecords]) => {
      const issueCount = buildingRecords.length;
      const completedCount = buildingRecords.filter(
        ({ issue }) => issue.status === 'closed',
      ).length;

      return {
        building,
        issueCount,
        completedCount,
        rate: roundOne((completedCount / Math.max(1, issueCount)) * 100),
      };
    });
}

function buildDistribution<T extends string>(
  values: T[],
  order: T[],
  labels: Record<T, string>,
): RiskDistributionItem[] {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return order
    .filter((key) => counts.has(key))
    .map((key) => ({
      key,
      label: labels[key],
      value: counts.get(key) || 0,
    }))
    .sort((left, right) => right.value - left.value);
}

function buildCategoryDistribution(issues: AliRiskIssue[]) {
  const overdueIds = new Set(
    issues.filter(({ overdueDays }) => overdueDays > 0).map(({ id }) => id),
  );
  const counts = new Map<string, { normal: number; overdue: number }>();
  for (const issue of issues) {
    const current = counts.get(issue.specialty) || { normal: 0, overdue: 0 };
    if (overdueIds.has(issue.id)) {
      current.overdue += 1;
    } else {
      current.normal += 1;
    }
    counts.set(issue.specialty, current);
  }
  return [...counts.entries()]
    .sort((left, right) => {
      const leftTotal = left[1].normal + left[1].overdue;
      const rightTotal = right[1].normal + right[1].overdue;
      return rightTotal - leftTotal || left[0].localeCompare(right[0], 'zh-CN');
    })
    .slice(0, 5)
    .map(([label, countsForLabel]) => ({ label, ...countsForLabel }));
}

function buildCompletionTrend(
  issues: AliRiskIssue[],
  asOfDate: string,
): Array<{ label: string; value: number }> {
  const end = parseDateOnly(asOfDate);
  if (!end) return [];

  return Array.from({ length: 5 }, (_, index) => {
    const daysBack = (4 - index) * 7;
    const periodEnd = addDays(end, -daysBack);
    const periodStart = addDays(periodEnd, -6);
    const recordsInWeek = issues.filter((issue) => {
      const discovered = parseDateOnly(issue.discoveredAt);
      return discovered && discovered >= periodStart && discovered <= periodEnd;
    });
    const completedInWeek = recordsInWeek.filter(
      ({ status }) => status === 'completed',
    ).length;
    return {
      label: `${periodStart.getMonth() + 1}/${periodStart.getDate()}`,
      value:
        recordsInWeek.length === 0
          ? 0
          : roundOne((completedInWeek / recordsInWeek.length) * 100),
    };
  });
}

function normalizeAliLevel(value: string): AliRiskLevel {
  if (value.includes('超低')) return 'ultra-low';
  if (value.includes('高')) return 'high';
  if (value.includes('中') || value.includes('一般')) return 'medium';
  if (value.includes('低')) return 'low';
  return 'unknown';
}

function normalizeAliStatus(value: string): AliRiskStatus {
  if (value.includes('完成') || value.includes('闭环')) return 'completed';
  if (value.includes('整改')) return 'rectifying';
  if (value.includes('挂起')) return 'suspended';
  return 'unknown';
}

function normalizeCrossStatus(value: string): CrossRectificationStatus {
  return value.trim() ? 'closed' : 'unresolved';
}

function normalizeSpecialty(value: string): string {
  const normalized = value.trim().replace(/专业$/u, '');
  if (normalized === '其他风险') return '其他';
  return normalized || '未分类';
}

function normalizeBuilding(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '未分配';
  if (/园区/u.test(normalized)) return '园区级';
  if (/110/u.test(normalized)) return '110站';
  const match = normalized.match(/([ABCDEH])(?:楼|栋)?/iu);
  return match ? `${match[1].toUpperCase()}楼` : normalized;
}

function normalizeMonth(value: string | undefined): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const monthMatch = normalized.match(
    /(?:^\d{4}[-/])?(1[0-2]|0?[1-9])(?:月)?$/u,
  );
  if (!monthMatch) return normalized;
  return `${Number(monthMatch[1])}月`;
}

function monthNumber(value: string): number {
  const match = value.match(/(\d{1,2})/u);
  return match ? Number(match[1]) : 0;
}

function yearNumber(value: string): number {
  const match = value.match(/\d{4}/u);
  return match ? Number(match[0]) : 0;
}

function parseCheckbox(value: unknown): boolean {
  if (value === true) return true;
  const text = extractDisplayText(value).trim().toLowerCase();
  return ['true', 'yes', '1', '是', '已录入', '✓', '✔'].includes(text);
}

function calculateOverdueDays(dueAt: string | null, asOfDate: string): number {
  const due = parseDateOnly(dueAt);
  const current = parseDateOnly(asOfDate);
  if (!due || !current || due >= current) return 0;
  return Math.floor((current.getTime() - due.getTime()) / 86_400_000);
}

function parseDateOnly(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function compareRiskIssues(left: AliRiskIssue, right: AliRiskIssue): number {
  return (
    String(left.dueAt || '9999-12-31').localeCompare(
      String(right.dueAt || '9999-12-31'),
    ) || left.id.localeCompare(right.id)
  );
}

function ensureRiskSuffix(value: string): string {
  return value.endsWith('风险') ? value : `${value}风险`;
}

function getLatestRecordDateTime(
  records: BitableRecordItem[],
  fieldNames: string[],
): string | null {
  const values = records
    .map((record) => {
      const fields = record.fields || {};
      return (
        extractDateTimeIso(pickField(fields, fieldNames)) ||
        extractDateTimeIso(record.last_modified_time)
      );
    })
    .filter((value): value is string => Boolean(value));
  return values.sort().at(-1) || null;
}

function formatShanghaiDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueSorted(values: string[]): string[] {
  return unique(values).filter(Boolean).sort();
}

function compareBuildingLabels(left: string, right: string): number {
  const buildingOrder = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'];
  const leftIndex = buildingOrder.indexOf(left);
  const rightIndex = buildingOrder.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (
      (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
      (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
    );
  }
  return left.localeCompare(right, 'zh-CN');
}
