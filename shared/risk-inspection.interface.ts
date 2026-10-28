export type RiskSourceStatus = 'fresh' | 'stale';

export type AliRiskLevel = 'ultra-low' | 'low' | 'medium' | 'high' | 'unknown';

export type AliRiskStatus =
  | 'suspended'
  | 'rectifying'
  | 'completed'
  | 'unknown';

export interface RiskDistributionItem {
  key: string;
  label: string;
  value: number;
}

export interface AliMonthlyQualityEvidence {
  name: string;
  size: number | null;
  mimeType: string;
  url: string;
}

export interface AliMonthlyQualityPersonReference {
  recordId: string;
  name: string;
}

export interface AliMonthlyQualityIssue {
  id: string;
  specialty?: string;
  month: string;
  building: string;
  item: string;
  issue: string;
  supplemental: string;
  attachments: AliMonthlyQualityEvidence[];
  images: AliMonthlyQualityEvidence[];
  responsiblePersons: AliMonthlyQualityPersonReference[];
  personMatchStatus: 'matched' | 'none' | 'ambiguous';
}

export type AliMonthlyQualitySourceStatus = 'fresh' | 'stale' | 'error';

export interface AliMonthlyQualityRating {
  id: string;
  year: string;
  month: string;
  building: string;
  grade: string;
  cumulativeAPlus: number | null;
  recent: boolean;
}

export interface AliMonthlyQualitySourceState {
  status: AliMonthlyQualitySourceStatus;
  sourceUpdatedAt: string | null;
  warning: string;
}

export interface AliMonthlyQualityDataset {
  issues: AliMonthlyQualityIssue[];
  ratings: AliMonthlyQualityRating[];
  options: {
    years: string[];
    months: string[];
    buildings: string[];
    items: string[];
  };
  sources: {
    issues: AliMonthlyQualitySourceState;
    ratings: AliMonthlyQualitySourceState;
  };
  sourceUpdatedAt: string | null;
  syncedAt: string;
  sourceStatus: RiskSourceStatus;
  warnings: string[];
}

export interface AliRiskIssue {
  id: string;
  building: string;
  specialty: string;
  level: AliRiskLevel;
  levelLabel: string;
  description: string;
  discoveredAt: string | null;
  dueAt: string | null;
  closedAt: string | null;
  owner: string;
  status: AliRiskStatus;
  statusLabel: string;
  overdueDays: number;
  recordedInArk: boolean;
}

export interface AliRiskInspectionDashboard {
  month: string;
  summary: {
    historyTotal: number;
    unrecorded: number;
    monthlyAdded: number;
    rectificationRate: number;
    monthlyClosed: number;
  };
  severityDistribution: RiskDistributionItem[];
  statusDistribution: RiskDistributionItem[];
  issues: AliRiskIssue[];
  unresolvedIssues: AliRiskIssue[];
  overdueIssues: AliRiskIssue[];
  completionTrend: Array<{ label: string; value: number }>;
  categoryDistribution: Array<{
    label: string;
    normal: number;
    overdue: number;
  }>;
  options: {
    specialties: string[];
    levels: AliRiskLevel[];
    statuses: AliRiskStatus[];
  };
  sourceUpdatedAt: string | null;
  syncedAt: string;
  sourceStatus: RiskSourceStatus;
  warnings: string[];
}

export type CrossRectificationStatus =
  | 'closed'
  | 'pending'
  | 'unresolved'
  | 'verification';

export interface CrossInspectionIssue {
  id: string;
  building: string;
  month: string;
  tag: string;
  type: string;
  description: string;
  owner: string;
  rectification: string;
  status: CrossRectificationStatus;
  createdAt: string | null;
}

export interface CrossBuildingRectification {
  building: string;
  issueCount: number;
  completedCount: number;
  rate: number;
}

export interface CrossInspectionDashboard {
  selectedMonth: string;
  summary: {
    historyTotal: number;
    monthlyTotal: number;
    legacyTotal: number;
    closureRate: number;
  };
  buildingRectification: CrossBuildingRectification[];
  legacyIssues: CrossInspectionIssue[];
  issues: CrossInspectionIssue[];
  options: {
    buildings: string[];
    months: string[];
    types: string[];
  };
  sourceUpdatedAt: string | null;
  syncedAt: string;
  sourceStatus: RiskSourceStatus;
  warnings: string[];
}

export type CrossInspectionGuideSource = 'system' | 'ali' | 'environment';

export interface CrossInspectionGuide {
  id: string;
  source: CrossInspectionGuideSource;
  code: string;
  category: string;
  subcategory: string;
  item: string;
  standard: string;
  method: string;
  level: string;
  cycle: string;
  applicability: string;
}

export interface CrossInspectionGuidePage {
  items: CrossInspectionGuide[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  sourceStatus: RiskSourceStatus;
  syncedAt: string;
  warnings: string[];
}
