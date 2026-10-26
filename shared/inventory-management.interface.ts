export const WAREHOUSE_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
] as const;

export type WarehouseBuilding = (typeof WAREHOUSE_BUILDINGS)[number];

export type WarehouseStorageLocationCategory = '库内' | '库外';

export interface WarehouseStorageLocation {
  recordId: string;
  building: WarehouseBuilding;
  company: string;
  category: WarehouseStorageLocationCategory;
  name: string;
}

export interface WarehouseStorageLocationQuery {
  building: WarehouseBuilding;
  query?: string;
  limit?: number;
}

export interface WarehouseStorageLocationCreateRequest {
  building: WarehouseBuilding;
  category: WarehouseStorageLocationCategory;
  name: string;
  clientMutationId: string;
}

export interface WarehouseStorageLocationCreateResponse {
  item: WarehouseStorageLocation;
  alreadyExists: boolean;
  clientMutationId: string;
}

export type InventoryRiskFilter = 'all' | 'low' | 'negative' | 'idle';
export type InventorySortOption =
  | 'risk'
  | 'quantityAsc'
  | 'quantityDesc'
  | 'usageAsc'
  | 'valueDesc';
export type InventorySourceKey =
  | 'inventory'
  | 'inbound'
  | 'outbound'
  | 'borrow'
  | 'catalog'
  | 'prices'
  | 'stocktake'
  | 'managers';

export interface InventoryManagementSourceStatus {
  configured: boolean;
  count: number;
  message?: string;
}

export interface InventoryManagementItem {
  specialty?: string;
  recordId: string;
  sku: string;
  name: string;
  specification: string;
  brand: string;
  primaryCategory: string;
  secondaryCategory: string;
  building: WarehouseBuilding | '未配置';
  location: string;
  storageType: string;
  quantity: number;
  minimumQuantity: number;
  difference: number;
  unit: string;
  annualUsage: number;
  value: number;
  owners: string[];
  lowStock: boolean;
  negativeStock: boolean;
  idle: boolean;
  pendingConfirmation: boolean;
}

export interface InventoryBuildingSummary {
  building: WarehouseBuilding;
  inventoryLines: number;
  distinctSkus: number;
  totalQuantity: number;
  inventoryValue: number;
  lowStockItems: number;
  negativeStockItems: number;
  idleItems: number;
  owners: string[];
}

export interface InventoryCategorySummary {
  category: string;
  inventoryLines: number;
  distinctSkus: number;
  totalQuantity: number;
  inventoryValue: number;
  lowStockItems: number;
}

export type InventoryMovementType = 'inbound' | 'outbound' | 'borrow';
export type InventoryInboundItemMode = 'existing' | 'new';
export type InventoryOutboundStatus =
  | '待路由'
  | '待审批'
  | '待库房确认'
  | '已驳回'
  | '已出库';

export const INVENTORY_NEW_ITEM_CATEGORY_OPTIONS = [
  {
    primaryCategory: 'A备品备件类',
    secondaryCategories: ['应急件A1', '常备件A2'],
  },
  {
    primaryCategory: 'B工具类',
    secondaryCategories: ['检测工具B1', '日常工具B2', '防护工具B3'],
  },
  {
    primaryCategory: 'C物资类',
    secondaryCategories: ['应急物资C1', '防疫物资C2'],
  },
  {
    primaryCategory: 'D消耗类',
    secondaryCategories: ['运维耗材D1', '办公耗材D2'],
  },
] as const;

export function getInventorySecondaryCategoryOptions(
  primaryCategory: string,
): readonly string[] {
  return (
    INVENTORY_NEW_ITEM_CATEGORY_OPTIONS.find(
      (option) => option.primaryCategory === primaryCategory.trim(),
    )?.secondaryCategories || []
  );
}

export function isInventoryNewItemCategoryPair(
  primaryCategory: string,
  secondaryCategory: string,
): boolean {
  const normalizedSecondaryCategory = secondaryCategory.trim();
  return getInventorySecondaryCategoryOptions(primaryCategory).some(
    (option) => option === normalizedSecondaryCategory,
  );
}

export interface InventoryNewItemInput {
  specialty?: string;
  primaryCategory: string;
  secondaryCategory: string;
  name: string;
  specification: string;
  location: string;
  locationRecordId?: string;
}

export interface InventoryMovementOptionItem {
  specialty?: string;
  catalogRecordId: string;
  inventoryRecordId: string;
  sku: string;
  name: string;
  specification: string;
  brand: string;
  primaryCategory: string;
  secondaryCategory: string;
  building: WarehouseBuilding;
  location: string;
  unit: string;
  availableQuantity: number;
  stockConsistencyError?: string;
}

export interface InventoryMovementOptionsQuery {
  type: InventoryMovementType;
  building?: WarehouseBuilding;
  query?: string;
  limit?: number;
  refresh?: boolean;
}

interface InventoryMovementCreateRequestBase {
  building: WarehouseBuilding;
  quantity: number;
  occurredAt: string;
  applicantOpenId?: string;
  operatorOpenId?: string;
  reason?: string;
  destinationBuilding?: WarehouseBuilding;
  expectedReturnAt?: string;
}

export interface InventoryNewInboundMovementCreateRequest extends InventoryMovementCreateRequestBase {
  type: 'inbound';
  clientMutationId: string;
  mode: 'new';
  catalogRecordId?: never;
  sku?: never;
  newItem: InventoryNewItemInput;
}

export interface InventoryExistingInboundMovementCreateRequest extends InventoryMovementCreateRequestBase {
  type: 'inbound';
  clientMutationId: string;
  mode: 'existing';
  catalogRecordId: string;
  sku: string;
  newItem?: never;
}

export interface InventoryOutboundMovementCreateRequest {
  type: 'outbound';
  clientMutationId: string;
  catalogRecordId: string;
  sku: string;
  building: WarehouseBuilding;
  quantity: number;
  occurredAt: string;
  applicantOpenId: string;
  reason: string;
}

export interface InventoryBatchAcceptanceItem {
  clientMutationId: string;
  accepted: boolean;
  taskId?: string;
  message: string;
}

export interface InventoryBatchAcceptanceResponse {
  success: true;
  items: InventoryBatchAcceptanceItem[];
}

/** @deprecated Use an explicit strict inbound request mode. */
export interface InventoryMovementCreateLegacyRequest extends InventoryMovementCreateRequestBase {
  type: 'inbound' | 'borrow';
  clientMutationId?: never;
  mode?: never;
  catalogRecordId: string;
  sku: string;
  newItem?: never;
}

export type InventoryMovementCreateRequest =
  | InventoryNewInboundMovementCreateRequest
  | InventoryExistingInboundMovementCreateRequest
  | InventoryOutboundMovementCreateRequest
  | InventoryMovementCreateLegacyRequest;

export interface InventoryMovementCreateResponse {
  success: true;
  recordId: string;
  type: InventoryMovementType;
  message: string;
  movement?: InventoryMovementItem;
}

export type InventoryInboundTaskKind = 'manual' | 'purchase';
export type InventoryInboundTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

interface InventoryInboundTaskBase {
  id: string;
  kind: InventoryInboundTaskKind;
  status: InventoryInboundTaskStatus;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryInboundPendingTask extends InventoryInboundTaskBase {
  status: 'pending';
}

export interface InventoryInboundRunningTask extends InventoryInboundTaskBase {
  status: 'running';
}

export interface InventoryInboundCompletedTask extends InventoryInboundTaskBase {
  status: 'completed';
  completedAt: string;
  result: InventoryMovementCreateResponse | PurchaseInboundConfirmResponse;
}

export interface InventoryInboundFailedTask extends InventoryInboundTaskBase {
  status: 'failed';
  completedAt: string;
  definitelyNotWritten: true;
}

export type InventoryInboundTask =
  | InventoryInboundPendingTask
  | InventoryInboundRunningTask
  | InventoryInboundCompletedTask
  | InventoryInboundFailedTask;

export interface InventoryInboundAcceptedResponse {
  accepted: true;
  taskId: string;
  kind: InventoryInboundTaskKind;
  status: InventoryInboundTaskStatus;
  message: string;
  result?: InventoryMovementCreateResponse | PurchaseInboundConfirmResponse;
  definitelyNotWritten?: boolean;
}

export interface InventoryInboundTaskStatusResponse {
  success: true;
  task: InventoryInboundTask;
}

export interface InventoryOutboundMovementCreateResponse {
  success: true;
  recordId: string;
  type: 'outbound';
  alreadyProcessed: boolean;
  message: string;
  movement: InventoryOutboundMovementItem;
}

export type InventoryOutboundTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'uncertain';

interface InventoryOutboundTaskBase {
  id: string;
  status: InventoryOutboundTaskStatus;
  message: string;
  createdAt: string;
}

export interface InventoryOutboundPendingTask extends InventoryOutboundTaskBase {
  status: 'pending';
}

export interface InventoryOutboundRunningTask extends InventoryOutboundTaskBase {
  status: 'running';
}

export interface InventoryOutboundCompletedTask extends InventoryOutboundTaskBase {
  status: 'completed';
  completedAt: string;
  result: InventoryOutboundMovementCreateResponse;
}

export interface InventoryOutboundFailedTask extends InventoryOutboundTaskBase {
  status: 'failed';
  completedAt: string;
  definitelyNotWritten: true;
}

export interface InventoryOutboundUncertainTask extends InventoryOutboundTaskBase {
  status: 'uncertain';
  completedAt: string;
  definitelyNotWritten: false;
}

export type InventoryOutboundTask =
  | InventoryOutboundPendingTask
  | InventoryOutboundRunningTask
  | InventoryOutboundCompletedTask
  | InventoryOutboundFailedTask
  | InventoryOutboundUncertainTask;

export interface InventoryOutboundAcceptedResponse {
  accepted: true;
  taskId: string;
  status: InventoryOutboundTaskStatus;
  message: string;
  result?: InventoryOutboundMovementCreateResponse;
  definitelyNotWritten?: boolean;
}

export interface InventoryOutboundTaskStatusResponse {
  success: true;
  task: InventoryOutboundTask;
}

export type InventoryMovementDeletionType = 'inbound' | 'outbound';

export type InventoryMovementDeletionTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'uncertain';

export interface CreateInventoryMovementDeletionRequest {
  clientMutationId: string;
  movementType: InventoryMovementDeletionType;
  recordId: string;
}

export interface InventoryMovementDeletionResult {
  recordId: string;
  type: InventoryMovementDeletionType;
  purchaseRolledBack: boolean;
  message: string;
}

interface InventoryMovementDeletionTaskBase {
  id: string;
  status: InventoryMovementDeletionTaskStatus;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryMovementDeletionPendingTask extends InventoryMovementDeletionTaskBase {
  status: 'pending';
}

export interface InventoryMovementDeletionRunningTask extends InventoryMovementDeletionTaskBase {
  status: 'running';
}

export interface InventoryMovementDeletionCompletedTask extends InventoryMovementDeletionTaskBase {
  status: 'completed';
  completedAt: string;
  result: InventoryMovementDeletionResult;
}

export interface InventoryMovementDeletionFailedTask extends InventoryMovementDeletionTaskBase {
  status: 'failed';
  completedAt: string;
  definitelyNotDeleted: true;
}

export interface InventoryMovementDeletionUncertainTask extends InventoryMovementDeletionTaskBase {
  status: 'uncertain';
  completedAt: string;
  definitelyNotDeleted: false;
}

export type InventoryMovementDeletionTask =
  | InventoryMovementDeletionPendingTask
  | InventoryMovementDeletionRunningTask
  | InventoryMovementDeletionCompletedTask
  | InventoryMovementDeletionFailedTask
  | InventoryMovementDeletionUncertainTask;

export interface InventoryMovementDeletionAcceptedResponse {
  accepted: true;
  taskId: string;
  status: InventoryMovementDeletionTaskStatus;
  message: string;
  result?: InventoryMovementDeletionResult;
  definitelyNotDeleted?: boolean;
}

export interface InventoryMovementDeletionTaskStatusResponse {
  success: true;
  task: InventoryMovementDeletionTask;
}

export interface InventoryOutboundConfirmRequest {
  clientMutationId: string;
}

export interface InventoryOutboundConfirmResponse {
  success: true;
  recordId: string;
  alreadyConfirmed: boolean;
  message: string;
  movement: InventoryOutboundMovementItem;
}

export type PurchaseInboundItemMode = InventoryInboundItemMode;
export type PurchasePendingInboundAction =
  | 'needs_selection'
  | 'ready'
  | 'needs_mapping'
  | 'needs_catalog';

export interface PurchasePendingInboundItem {
  responsibilityGeneration?: number;
  specialty?: string;
  executionRecordId: string;
  submissionRecordId: string;
  requestCode: string;
  mode: PurchaseInboundItemMode | null;
  sku: string;
  itemName: string;
  specification: string;
  brand: string;
  primaryCategory: string;
  secondaryCategory: string;
  building: WarehouseBuilding;
  quantity: number;
  unit: string;
  signedAt: string | null;
  action: PurchasePendingInboundAction;
  catalogRecordId: string;
  actionReason: string;
  preparedCategory?: PurchaseInboundPreparedCategory;
}

export interface PurchasePendingInboundResponse {
  generatedAt: string;
  items: PurchasePendingInboundItem[];
}

export interface PurchaseInboundNewItemInput extends InventoryNewItemInput {
  locationRecordId?: string;
  brand?: string;
  unit?: string;
  minimumQuantity?: number;
}

export interface PurchaseInboundCategoryPrepareRequest {
  executionRecordId: string;
  clientMutationId: string;
  building: WarehouseBuilding;
  quantity: number;
  occurredAt: string;
  newItem: PurchaseInboundNewItemInput;
}

export interface PurchaseInboundCategoryPrepareResponse {
  catalogRecordId: string;
  sku: string;
  alreadyPrepared: boolean;
  preparedAt: string;
}

export type PurchaseInboundCategoryTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

interface PurchaseInboundCategoryTaskBase {
  id: string;
  status: PurchaseInboundCategoryTaskStatus;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseInboundCategoryPendingTask extends PurchaseInboundCategoryTaskBase {
  status: 'pending';
}

export interface PurchaseInboundCategoryRunningTask extends PurchaseInboundCategoryTaskBase {
  status: 'running';
}

export interface PurchaseInboundCategoryCompletedTask extends PurchaseInboundCategoryTaskBase {
  status: 'completed';
  completedAt: string;
  result: PurchaseInboundCategoryPrepareResponse;
}

export interface PurchaseInboundCategoryFailedTask extends PurchaseInboundCategoryTaskBase {
  status: 'failed';
  completedAt: string;
  definitelyNotPrepared: true;
}

export type PurchaseInboundCategoryTask =
  | PurchaseInboundCategoryPendingTask
  | PurchaseInboundCategoryRunningTask
  | PurchaseInboundCategoryCompletedTask
  | PurchaseInboundCategoryFailedTask;

export interface PurchaseInboundCategoryAcceptedResponse {
  accepted: true;
  taskId: string;
  status: PurchaseInboundCategoryTaskStatus;
  message: string;
  result?: PurchaseInboundCategoryPrepareResponse;
  definitelyNotPrepared?: boolean;
}

export interface PurchaseInboundCategoryTaskStatusResponse {
  success: true;
  task: PurchaseInboundCategoryTask;
}

export interface PurchaseInboundPreparedCategory {
  catalogRecordId: string;
  sku: string;
  preparedAt: string;
  clientMutationId: string;
  building: WarehouseBuilding;
  quantity: number;
  occurredAt: string;
  newItem: PurchaseInboundNewItemInput;
}

/** @deprecated Legacy purchase dialog input without a required location. */
export interface PurchaseInboundLegacyNewItemInput {
  primaryCategory: string;
  secondaryCategory: string;
  name: string;
  specification: string;
  location?: string;
  brand: string;
  unit: string;
  minimumQuantity: number;
}

interface PurchaseInboundConfirmRequestBase {
  responsibilityGeneration?: number;
  executionRecordId: string;
  quantity: number;
  occurredAt: string;
}

export interface PurchaseNewInboundConfirmRequest extends PurchaseInboundConfirmRequestBase {
  building: WarehouseBuilding;
  clientMutationId: string;
  mode: 'new';
  catalogRecordId?: never;
  sku?: never;
  preparedCatalogRecordId: string;
  generatedSku: string;
  newItem: PurchaseInboundNewItemInput;
}

export interface PurchaseExistingInboundConfirmRequest extends PurchaseInboundConfirmRequestBase {
  building: WarehouseBuilding;
  clientMutationId: string;
  mode: 'existing';
  catalogRecordId: string;
  sku: string;
  newItem?: never;
}

/** @deprecated Use a strict purchase inbound request with target building. */
export interface PurchaseInboundConfirmLegacyRequest extends PurchaseInboundConfirmRequestBase {
  building?: never;
  clientMutationId?: never;
  mode: PurchaseInboundItemMode;
  catalogRecordId?: string;
  sku: string;
  newItem?: PurchaseInboundLegacyNewItemInput;
}

export type PurchaseInboundConfirmRequest =
  | PurchaseNewInboundConfirmRequest
  | PurchaseExistingInboundConfirmRequest
  | PurchaseInboundConfirmLegacyRequest;

export interface PurchaseInboundConfirmResponse {
  success: true;
  executionRecordId: string;
  catalogRecordId: string;
  inboundRecordId: string;
  alreadyProcessed: boolean;
  message: string;
  notificationWarnings: string[];
  movement?: InventoryMovementItem;
}

export interface InventoryMovementItem {
  specialty?: string;
  recordId: string;
  clientMutationId?: string;
  pendingSync?: boolean;
  type: InventoryMovementType;
  sku: string;
  name: string;
  specification: string;
  quantity: number;
  unit: string;
  building: WarehouseBuilding | '未配置';
  destinationBuilding: WarehouseBuilding | '未配置' | '';
  location: string;
  reason: string;
  approvalRejectionReason?: string;
  operator: string;
  applicant: string;
  status: string;
  occurredAt: string | null;
  expectedReturnAt: string | null;
  overdue: boolean;
  sourceKind?: 'manual' | 'purchase';
}

export type InventoryOutboundMovementItem = Omit<
  InventoryMovementItem,
  'type' | 'status'
> & {
  type: 'outbound';
  status: InventoryOutboundStatus;
};

export interface InventoryMovementCollection {
  inbound: InventoryMovementItem[];
  outbound: InventoryOutboundMovementItem[];
  borrow: InventoryMovementItem[];
}

export interface InventoryMovementsQuery {
  allowedBuildings?: readonly WarehouseBuilding[];
  type: InventoryMovementType;
  page?: number;
  pageSize?: number;
  search?: string;
  building?: WarehouseBuilding | 'all';
  status?: string;
}

export interface InventoryMovementSummary {
  totalRecords: number;
  totalQuantity: number;
  overdueItems: number;
  statusCounts: Array<{ status: string; count: number }>;
}

export interface InventoryMovementsResponse {
  items: InventoryMovementItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary: InventoryMovementSummary;
}

export interface InventoryStocktakeBuildingProgress {
  building: WarehouseBuilding;
  total: number;
  completed: number;
  completionRate: number;
  responsible: string;
}

export interface InventoryStocktakeSummary {
  year: number | null;
  month: number | null;
  total: number;
  completed: number;
  completionRate: number;
  buildings: InventoryStocktakeBuildingProgress[];
}

export interface InventoryManagementDashboard {
  generatedAt: string;
  sourceUrl: string;
  summary: {
    inventoryLines: number;
    distinctSkus: number;
    totalQuantity: number;
    inventoryValue: number;
    lowStockItems: number;
    negativeStockItems: number;
    idleItems: number;
    pendingConfirmationItems: number;
    unassignedInventoryLines: number;
  };
  buildings: InventoryBuildingSummary[];
  categories: InventoryCategorySummary[];
  alerts: InventoryManagementItem[];
  movements: InventoryMovementCollection;
  stocktake: InventoryStocktakeSummary;
  stocktakeHistory?: InventoryStocktakeSummary[];
  sectionStatus: Record<InventorySourceKey, InventoryManagementSourceStatus>;
}

export interface InventoryItemsQuery {
  allowedBuildings?: readonly WarehouseBuilding[];
  page?: number;
  pageSize?: number;
  search?: string;
  building?: WarehouseBuilding | 'all';
  category?: string;
  risk?: InventoryRiskFilter;
  sort?: InventorySortOption;
}

export interface InventoryItemsResponse {
  items: InventoryManagementItem[];
  categories: string[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export type InventoryWorkflowCode =
  | 'purchase_backfill'
  | 'purchase_h'
  | 'purchase_abcde'
  | 'item_confirmation';

export type InventoryWorkflowTrigger =
  | 'schedule'
  | 'poll'
  | 'manual'
  | 'retry'
  | 'startup';

export interface InventoryWorkflowRunResult {
  runId: string;
  code: InventoryWorkflowCode;
  trigger: InventoryWorkflowTrigger;
  startedAt: string;
  finishedAt: string;
  scanned: number;
  candidates: number;
  processed: number;
  skipped: number;
  failed: number;
  notified: number;
  errors: Array<{ recordId: string; message: string }>;
}

export interface InventoryWorkflowLogItem {
  recordId: string;
  code: InventoryWorkflowCode;
  workflowName: string;
  sourceRecordId: string;
  targetRecordId: string;
  stage: string;
  attempts: number;
  result: string;
  error: string;
  lastRunAt: string | null;
  completedAt: string | null;
  selfTest: boolean;
}

export interface InventoryWorkflowStatusItem {
  code: InventoryWorkflowCode;
  name: string;
  originalWorkflowId: string;
  triggerLabel: string;
  scheduleLabel: string;
  enabled: boolean;
  running: boolean;
  nextRunAt: string | null;
  lastRun: InventoryWorkflowRunResult | null;
}

export interface InventoryWorkflowStatusResponse {
  generatedAt: string;
  enabled: boolean;
  configured: boolean;
  source: 'program';
  workflows: InventoryWorkflowStatusItem[];
  recentLogs: InventoryWorkflowLogItem[];
  message?: string;
}

export interface InventoryWorkflowSelfTestResponse {
  success: boolean;
  startedAt: string;
  finishedAt: string;
  marker: string;
  createdRecordIds: string[];
  deletedRecordIds: string[];
  remainingRecords: number;
  checks: Array<{ name: string; success: boolean; message: string }>;
}
