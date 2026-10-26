export type ContractStatus =
  | 'pending'
  | 'active'
  | 'expiring'
  | 'expired'
  | 'unknown';

export type ContractPaymentRisk =
  | 'completed'
  | 'normal'
  | 'dueSoon'
  | 'overdue'
  | 'undated';

export type ContractSourceKey =
  | 'framework'
  | 'contracts'
  | 'suppliers'
  | 'payments';

export type ContractWorkflowCode =
  | 'payment_due_reminder'
  | 'contract_expiry_reminder';

export type ContractWorkflowTrigger =
  | 'startup'
  | 'poll'
  | 'schedule'
  | 'manual';

export type ContractExpiryDispositionAction = 'renew' | 'void';

export type ContractCreateKind = 'framework' | 'execution';

export type ContractCreateControl =
  | 'text'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'user'
  | 'checkbox'
  | 'attachment';

export type ContractCreateValue = string | number | boolean | string[] | null;

export interface ContractCreateFieldDefinition {
  fieldId: string;
  name: string;
  control: ContractCreateControl;
  required: boolean;
  multiple: boolean;
  group: 'basic' | 'commercial' | 'relationship' | 'attachment' | 'other';
  inputType: 'text' | 'tel' | 'email' | 'url';
  options: Array<{ value: string; label: string }>;
}

export interface ContractCreateFrameworkOption {
  recordId: string;
  name: string;
  code: string;
  startDate: string | null;
  endDate: string | null;
}

export interface ContractCreateSupplierOption {
  recordId: string;
  name: string;
  contacts: Array<{ name: string; phone: string }>;
}

export interface ContractCreatePersonOption {
  openId: string;
  name: string;
}

export interface ContractCreateOptionsResponse {
  kind: ContractCreateKind;
  fields: ContractCreateFieldDefinition[];
  supplierFields: ContractCreateFieldDefinition[];
  frameworks: ContractCreateFrameworkOption[];
  suppliers: ContractCreateSupplierOption[];
  people: ContractCreatePersonOption[];
  upload: {
    accept: 'application/pdf';
    required: true;
    maxFiles: number;
    maxFileSize: number;
  };
}

export interface ContractEditOptionsResponse {
  contract: {
    recordId: string;
    code: string;
    name: string;
  };
  fields: ContractCreateFieldDefinition[];
  values: Record<string, ContractCreateValue>;
  suppliers: ContractCreateSupplierOption[];
  people: ContractCreatePersonOption[];
  supplierRecordId: string;
}

export interface ContractEditRequest {
  fields: Record<string, ContractCreateValue>;
  supplierRecordId?: string;
}

export interface ContractEditResponse {
  ok: true;
  recordId: string;
  message: string;
}

export type ContractCreateSupplierInput =
  | { mode: 'existing'; recordId: string }
  | { mode: 'create'; fields: Record<string, ContractCreateValue> };

export interface ContractCreateRequest {
  kind: ContractCreateKind;
  idempotencyKey: string;
  fields: Record<string, ContractCreateValue>;
  supplier?: ContractCreateSupplierInput;
  linkFramework: boolean;
  frameworkRecordId?: string;
  paymentPlans?: ContractCreatePaymentPlanInput[];
}

export interface ContractCreatePaymentPlanInput {
  period: string;
  plannedAmount: number;
  plannedPaymentDate: string;
  ownerOpenId: string;
}

export interface ContractCreateNotificationResult {
  attempted: boolean;
  recipients: number;
  sent: number;
  failed: number;
  message: string;
}

export interface ContractCreateAttachmentResult {
  name: string;
  accessId: string;
  previewStatus: 'processing' | 'ready' | 'needs_review' | 'failed';
  pageCount: number;
}

export interface ContractCreateResponse {
  kind: ContractCreateKind;
  recordId: string;
  supplierRecordId: string | null;
  supplierCreated: boolean;
  paymentRecordIds: string[];
  attachments: ContractCreateAttachmentResult[];
  notification: ContractCreateNotificationResult;
  message: string;
}

export interface ContractCreateSelfTestResponse {
  ok: true;
  recordId: string;
  baseVerified: true;
  cosReady: true;
  notification: ContractCreateNotificationResult;
  cleanup: {
    baseDeleted: true;
    cosDeleted: true;
    residualRecord: false;
  };
}

export interface ContractPaymentPlanOption {
  recordId: string;
  label: string;
  period: string;
  plannedAmount: number;
  actualAmount: number;
  plannedPaymentDate: string | null;
  paymentDate: string | null;
  status: string;
  ownerOpenId: string;
  ownerName: string;
}

export interface ContractPaymentFollowUpOptionsResponse {
  contract: {
    recordId: string;
    code: string;
    name: string;
    ownerOpenId: string;
    ownerName: string;
  };
  periods: string[];
  statuses: string[];
  people: ContractCreatePersonOption[];
  plans: ContractPaymentPlanOption[];
}

export interface ContractPaymentPlanCreateRequest extends ContractCreatePaymentPlanInput {
  idempotencyKey: string;
}

export type ContractPaymentPlanAdjustRequest = ContractCreatePaymentPlanInput;

export interface ContractPaymentPlanConfirmRequest {
  actualAmount: number;
  paymentDate: string;
}

export type ContractPaymentFollowUpAction = 'create' | 'adjust' | 'confirm';

export interface ContractPaymentFollowUpActionResponse {
  ok: true;
  action: ContractPaymentFollowUpAction;
  paymentRecordId: string;
  notification: ContractCreateNotificationResult;
  message: string;
}

export interface ContractNoPaymentRequiredRequest {
  idempotencyKey: string;
}

export interface ContractNoPaymentRequiredResponse {
  ok: true;
  action: 'no_payment_required';
  contractRecordId: string;
  disposition: '无需付款';
  message: string;
}

export interface ContractExpiryDispositionRequest {
  action: ContractExpiryDispositionAction;
  renewalEndDate?: string;
  idempotencyKey?: string;
  paymentPlans?: ContractCreatePaymentPlanInput[];
}

export interface ContractExpiryDispositionResponse {
  recordId: string;
  action: ContractExpiryDispositionAction;
  endDate: string;
  notification: ContractCreateNotificationResult;
  message: string;
}

export interface ContractExpiryDispositionSubmissionResponse {
  recordId: string;
  action: ContractExpiryDispositionAction;
  pending: true;
  taskId: string;
  message: string;
}

export interface ContractExpiryDispositionTask {
  id: string;
  recordId: string;
  action: ContractExpiryDispositionAction;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message: string;
  createdAt: string;
  completedAt?: string;
}

export interface ContractExpiryDispositionTaskStatusResponse {
  success: boolean;
  message?: string;
  task?: ContractExpiryDispositionTask;
}

export interface ContractWorkflowRunResult {
  code: ContractWorkflowCode;
  trigger: ContractWorkflowTrigger;
  startedAt: string;
  completedAt: string;
  scanned: number;
  matched: number;
  sent: number;
  skipped: number;
  failed: number;
  message: string;
}

export interface ContractWorkflowLogItem extends ContractWorkflowRunResult {
  id: string;
}

export interface ContractWorkflowStatusResponse {
  generatedAt: string;
  enabled: boolean;
  configured: boolean;
  source: 'program';
  baseWorkflowsUntouched: true;
  message?: string;
  workflows: Array<{
    code: ContractWorkflowCode;
    name: string;
    originalWorkflowId: string;
    triggerLabel: string;
    scheduleLabel: string;
    enabled: boolean;
    running: boolean;
    nextRunAt: string | null;
    lastRun: ContractWorkflowRunResult | null;
  }>;
  recentLogs: ContractWorkflowLogItem[];
}

export interface ContractWorkflowSelfTestResponse {
  ok: true;
  checkedAt: string;
  contracts: number;
  payments: number;
  organization: number;
  managerReceivers: number;
  message: string;
}

export interface ContractSourceStatus {
  configured: boolean;
  count: number;
  message?: string;
}

export interface ContractManagementItem {
  buildings?: string[];
  recordId: string;
  name: string;
  code: string;
  amount: number;
  contractType: string;
  specialty: string;
  supplier: string;
  owner: string;
  startDate: string | null;
  endDate: string | null;
  status: ContractStatus;
  daysRemaining: number | null;
  expiryDisposition: string;
  paymentFollowUpDisposition?: string;
  paymentCycle: string;
  paymentRequirement: string;
  paymentProgress: {
    plannedAmount: number;
    paidAmount: number;
    completionRate: number;
  };
  attachments: Array<{
    name: string;
    accessId: string;
    previewStatus: 'processing' | 'ready' | 'needs_review' | 'failed';
    pageCount: number;
  }>;
}

export interface ContractPaymentItem {
  recordId: string;
  contractRecordId: string;
  contractName: string;
  contractCode: string;
  label: string;
  cycle: string;
  dueDate: string | null;
  plannedAmount: number;
  actualAmount: number;
  status: string;
  risk: ContractPaymentRisk;
  daysUntilDue: number | null;
  owner: string;
}

export interface ContractFrameworkRelationItem {
  frameworkRecordId: string;
  frameworkName: string;
  frameworkCode: string;
  startDate: string | null;
  endDate: string | null;
  status: ContractStatus;
  daysRemaining: number | null;
  executionAmount: number;
  executionContracts: Array<{
    recordId: string;
    name: string;
    code: string;
    amount: number;
    status: ContractStatus;
    supplier: string;
    owner: string;
    endDate: string | null;
  }>;
}

export interface ContractSupplierDirectoryContact {
  name: string;
  phone: string;
}

export interface ContractSupplierDirectoryContract {
  recordId: string;
  name: string;
  code: string;
  amount: number;
  status: ContractStatus;
  startDate: string | null;
  endDate: string | null;
}

export type ContractSupplierCooperationDepth =
  | 'over_100k'
  | '50k_to_100k'
  | 'under_50k';

export interface ContractSupplierDirectoryItem {
  supplierId: string;
  name: string;
  directoryEntryCount: number;
  contacts: ContractSupplierDirectoryContact[];
  parkLiaisons: string[];
  relatedContracts: ContractSupplierDirectoryContract[];
  activeContractCount: number;
  linkedContractAmount: number;
  cooperationDepth: ContractSupplierCooperationDepth;
}

export interface ContractSupplierDirectory {
  summary: {
    totalSuppliers: number;
    directoryEntries: number;
    linkedContracts: number;
    contactsWithPhone: number;
    phoneCoverageRate: number;
  };
  items: ContractSupplierDirectoryItem[];
}

export interface ContractPaymentSummary {
  contractRecordId: string;
  contractName: string;
  contractCode: string;
  owner: string;
  plannedAmount: number;
  paidAmount: number;
  pendingAmount: number;
  completionRate: number;
  totalPlans: number;
  completedPlans: number;
  pendingPlans: number;
  nextDueDate: string | null;
  overduePlans: number;
}

export type ContractPaymentFollowUpReason = 'missing_plan' | 'unpaid_plan';

export interface ContractPaymentFollowUpItem {
  contractRecordId: string;
  contractName: string;
  contractCode: string;
  owner: string;
  contractAmount: number;
  contractEndDate: string;
  reason: ContractPaymentFollowUpReason;
  planCount: number;
  unpaidPlanCount: number;
  plannedAmount: number;
  paidAmount: number;
  pendingAmount: number;
  attachments: ContractManagementItem['attachments'];
}

export interface ContractBreakdownItem {
  label: string;
  count: number;
  amount: number;
  percentage: number;
}

export interface ContractManagementDashboard {
  generatedAt: string;
  sourceUrl: string;
  summary: {
    totalContracts: number;
    activeContracts: number;
    expiringContracts: number;
    expiredContracts: number;
    pendingContracts: number;
    totalValue: number;
    frameworkContracts: number;
    activeFrameworkContracts: number;
    plannedPaymentAmount: number;
    paidAmount: number;
    pendingPaymentAmount: number;
    overduePayments: number;
    supplierCount: number;
  };
  paymentProgress: {
    plannedAmount: number;
    paidAmount: number;
    pendingAmount: number;
    completionRate: number;
    paidCount: number;
    pendingCount: number;
  };
  contracts: ContractManagementItem[];
  unsignedContracts: ContractManagementItem[];
  payments: ContractPaymentItem[];
  contractRisks: ContractManagementItem[];
  paymentRisks: ContractPaymentItem[];
  frameworkRelations: {
    summary: {
      totalFrameworks: number;
      activeFrameworks: number;
      linkedFrameworks: number;
      unlinkedFrameworks: number;
      linkedExecutionContracts: number;
      linkedExecutionAmount: number;
    };
    items: ContractFrameworkRelationItem[];
  };
  supplierDirectory: ContractSupplierDirectory;
  contractPaymentSummaries: ContractPaymentSummary[];
  paymentFollowUps: ContractPaymentFollowUpItem[];
  paymentDataQuality: {
    missingContract: number;
    pendingMissingDate: number;
    zeroAmount: number;
  };
  typeBreakdown: Array<ContractBreakdownItem & { contractType: string }>;
  specialtyBreakdown: Array<ContractBreakdownItem & { specialty: string }>;
  sectionStatus: Record<ContractSourceKey, ContractSourceStatus>;
}
