import type {
  AliRiskIssue,
  CrossBuildingRectification,
  CrossInspectionIssue,
} from '@shared/risk-inspection.interface';

export interface RiskDetailField {
  label: string;
  value: string;
  wide?: boolean;
}

export interface RiskDetailPayload {
  title: string;
  description: string;
  fields: RiskDetailField[];
}

export function createAliIssueDetail(
  issue: AliRiskIssue,
): RiskDetailPayload {
  return {
    title: '风险问题详情',
    description: `问题编号：${issue.id}`,
    fields: [
      { label: '问题描述', value: valueOrDash(issue.description), wide: true },
      { label: '楼栋', value: valueOrDash(issue.building) },
      { label: '专业', value: valueOrDash(issue.specialty) },
      { label: '风险等级', value: valueOrDash(issue.levelLabel) },
      { label: '处置状态', value: valueOrDash(issue.statusLabel) },
      { label: '示例人员019', value: valueOrDash(issue.owner) },
      { label: '发现时间', value: valueOrDash(issue.discoveredAt) },
      { label: '截止日期', value: valueOrDash(issue.dueAt) },
      { label: '闭环日期', value: valueOrDash(issue.closedAt) },
      {
        label: '逾期情况',
        value:
          issue.overdueDays > 0 ? `已逾期 ${issue.overdueDays} 天` : '未逾期',
      },
      {
        label: '方舟登记',
        value: issue.recordedInArk ? '已登记' : '未登记',
      },
    ],
  };
}

export function createCrossIssueDetail(
  issue: CrossInspectionIssue,
): RiskDetailPayload {
  return {
    title: '交叉互查问题详情',
    description: `问题编号：${issue.id}`,
    fields: [
      { label: '问题描述', value: valueOrDash(issue.description), wide: true },
      {
        label: '整改情况',
        value: valueOrDash(issue.rectification),
        wide: true,
      },
      { label: '楼栋', value: valueOrDash(issue.building) },
      { label: '月份', value: valueOrDash(issue.month) },
      { label: '标签', value: valueOrDash(issue.tag) },
      { label: '类型', value: valueOrDash(issue.type) },
      { label: '问题提出人', value: valueOrDash(issue.owner) },
      { label: '记录时间', value: valueOrDash(issue.createdAt) },
      { label: '状态', value: statusLabel(issue.status) },
    ],
  };
}

export function createMetricDetail({
  title,
  value,
  month,
  description,
}: {
  title: string;
  value: string;
  month: string;
  description: string;
}): RiskDetailPayload {
  return {
    title,
    description: '摘要指标详情',
    fields: [
      { label: '当前值', value },
      { label: '统计月份', value: month },
      { label: '指标口径', value: description, wide: true },
    ],
  };
}

export function createDistributionDetail({
  scope,
  label,
  value,
  total,
}: {
  scope: string;
  label: string;
  value: number;
  total: number;
}): RiskDetailPayload {
  return {
    title: `${label} · ${scope}分布`,
    description: '问题全景分布详情',
    fields: [
      { label: '数量', value: value.toLocaleString() },
      {
        label: '占比',
        value: `${total > 0 ? ((value / total) * 100).toFixed(1) : '0.0'}%`,
      },
      { label: '分布总数', value: total.toLocaleString() },
    ],
  };
}

export function createTrendDetail({
  label,
  value,
}: {
  label: string;
  value: number;
}): RiskDetailPayload {
  return {
    title: '整改完成率趋势',
    description: '周期数据详情',
    fields: [
      { label: '统计周期', value: label },
      { label: '整改完成率', value: `${value}%` },
    ],
  };
}

export function createCategoryDetail({
  label,
  normal,
  overdue,
}: {
  label: string;
  normal: number;
  overdue: number;
}): RiskDetailPayload {
  return {
    title: `${label} · 问题类型分布`,
    description: '专业问题统计详情',
    fields: [
      { label: '普通问题', value: normal.toLocaleString() },
      { label: '超期问题', value: overdue.toLocaleString() },
      { label: '问题合计', value: (normal + overdue).toLocaleString() },
    ],
  };
}

export function createCrossBuildingDetail(
  item: CrossBuildingRectification,
): RiskDetailPayload {
  return {
    title: `${item.building} · 整改情况`,
    description: '交叉互查楼栋统计详情',
    fields: [
      { label: '问题数量', value: item.issueCount.toLocaleString() },
      {
        label: '已整改数量',
        value: item.completedCount.toLocaleString(),
      },
      { label: '整改率', value: `${item.rate}%` },
    ],
  };
}

function valueOrDash(value: string | null | undefined): string {
  return value?.trim() || '—';
}

function statusLabel(status: CrossInspectionIssue['status']): string {
  const labels: Record<CrossInspectionIssue['status'], string> = {
    closed: '已整改',
    pending: '待整改',
    unresolved: '未解决',
    verification: '待验收',
  };
  return labels[status];
}
