export type PurchaseItemMode = 'existing' | 'new';
export type PurchaseBuilding =
  | 'H楼'
  | 'A楼'
  | 'B楼'
  | 'C楼'
  | 'D楼'
  | 'E楼'
  | '110站';
export type PurchaseSpecialty =
  | '电气'
  | '暖通'
  | '弱电'
  | '消防'
  | '土建'
  | '其他';
export type PurchaseMethod = '需求自采（楼内）' | '综合采购';
export type PurchaseChannel = '线上' | '线下';
export type ProcurementForm = '三方比价' | '单一采购';
export type ComparisonSatisfied = '是' | '否';

export interface PurchaseApplicationSharedInput {
  applicantRecordId: string;
  applicantOpenId: string;
  applicantName: string;
  applicantEmployeeNo: string;
  applicantPosition: string;
  applicantBuilding: string;
  building: PurchaseBuilding;
  specialty: PurchaseSpecialty;
  purchaseMethod: PurchaseMethod;
  purchaseChannel: PurchaseChannel;
  supplier: string;
  onlineUrl: string;
  procurementForm: ProcurementForm;
  comparisonSatisfied: ComparisonSatisfied;
  singleReason: string;
  requirementSummary: string;
  expectedDeliveryDate: string;
  immediateOutbound: boolean;
  notes: string;
}

export interface PurchaseApplicationApplicant {
  recordId: string;
  openId: string;
  name: string;
  employeeNo: string;
  position: string;
  building: string;
  specialty: string;
}

export interface PurchaseApplicationApplicantSearchParams {
  self?: boolean;
  building?: string;
  query?: string;
  limit?: number;
}

export interface PurchaseApplicationItemInput {
  lineId: string;
  mode: PurchaseItemMode;
  catalogRecordId: string;
  sku: string;
  primaryCategory: string;
  secondaryCategory: string;
  itemName: string;
  specification: string;
  brand: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  shippingFee: number;
  discount: number;
  onlineUrls?: string[];
}

export interface PurchaseApplicationBatchRequest {
  shared: PurchaseApplicationSharedInput;
  items: PurchaseApplicationItemInput[];
}

export interface PurchaseApplicationValidationIssue {
  code: string;
  path: string;
  message: string;
  lineId?: string;
}

export interface PurchaseApplicationValidationResult {
  value: PurchaseApplicationBatchRequest | null;
  issues: PurchaseApplicationValidationIssue[];
}

export interface PurchaseApplicationCatalogItem {
  recordId: string;
  sku: string;
  name: string;
  building: string;
  specialty: string;
  primaryCategory: string;
  secondaryCategory: string;
  specification: string;
  brand: string;
  unit: string;
}

export interface PurchaseApplicationCatalogSearchParams {
  building?: string;
  primaryCategory?: string;
  secondaryCategory?: string;
  query?: string;
  limit?: number;
}

export interface PurchaseApplicationOptionsResponse {
  buildings: PurchaseBuilding[];
  specialties: PurchaseSpecialty[];
  purchaseMethods: PurchaseMethod[];
  purchaseChannels: PurchaseChannel[];
  procurementForms: ProcurementForm[];
  comparisonOptions: ComparisonSatisfied[];
  primaryCategories: string[];
  secondaryCategories: string[];
}

export interface PurchaseApplicationSubmitResponse {
  success: boolean;
  created: Array<{
    lineId: string;
    recordId: string;
    requestCode: string;
    executionRecordId?: string;
  }>;
  failed: Array<{
    lineId: string;
    message: string;
  }>;
  warnings: Array<{
    lineId: string;
    executionRecordId: string;
    message: string;
  }>;
  message: string;
}

export interface PurchaseApplicationSubmissionResponse {
  pending: true;
  taskId: string;
  message: string;
}

export interface PurchaseApplicationSubmissionTask {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'uncertain';
  message: string;
  createdAt: string;
  completedAt?: string;
  definitelyNotWritten?: boolean;
  result?: PurchaseApplicationSubmitResponse;
}

export interface PurchaseApplicationSubmissionTaskStatusResponse {
  success: boolean;
  message?: string;
  task?: PurchaseApplicationSubmissionTask;
}
