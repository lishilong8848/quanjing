export const TOOL_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
] as const;
export type ToolBuilding = (typeof TOOL_BUILDINGS)[number];
export const TOOL_FLOW_KINDS = [
  'quality',
  'maintenance',
  'repair',
  'scrap',
  'borrow',
  'inspection',
] as const;
export type ToolFlowKind = (typeof TOOL_FLOW_KINDS)[number];
export type ToolSourceKey = 'ledger' | ToolFlowKind;
export const TOOL_SOURCE_LABELS: Record<ToolSourceKey, string> = {
  ledger: '工具台账',
  quality: '不合格工具',
  maintenance: '维护管理',
  repair: '检修管理',
  scrap: '报废管理',
  borrow: '借用管理',
  inspection: '送检管理',
};
export interface OperationsTool {
  specialty?: string;
  id: string;
  name: string;
  code: string;
  building: ToolBuilding | null;
  place: string;
  brand: string;
  model: string;
  unit: string;
  quantity: number | null;
  borrowed: number | null;
  category: string;
  conclusion: string;
  scrapStatus: string;
  maintenanceCycle: string;
  maintenanceDate: string | null;
  maintenanceDue: string | null;
  inspectionCycle: string;
  inspectionDate: string | null;
  inspectionDue: string | null;
  issues: string[];
  checks: Record<string, boolean | null>;
}
export interface OperationsToolFlow {
  id: string;
  kind: ToolFlowKind;
  code: string;
  toolIds: string[];
  name: string;
  building: ToolBuilding | null;
  status: string;
  date: string | null;
  actualDate: string | null;
  quantity: number | null;
  reason: string;
  checks: Record<string, boolean | null>;
  attachments: string[];
}
export interface ToolSourceStatus {
  state: 'loading' | 'ready' | 'stale' | 'error';
  updatedAt: string | null;
  message: string | null;
  sourceUrl: string;
  formUrl: string | null;
}
export interface OperationsToolsSnapshot {
  tools: OperationsTool[];
  flows: OperationsToolFlow[];
  sources: Record<ToolSourceKey, ToolSourceStatus>;
  generatedAt: string;
  refreshing: boolean;
  scopedBuilding: string | null;
}
