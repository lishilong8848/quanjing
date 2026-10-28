import type { AccessRole, BuildingAdminBuilding } from './access-control.interface';
import type { PersonalPermissionRule } from './business-permissions';
import type { ProfessionalSpecialty } from './professional-access';
import type { AuthorityDuty, AuthorityPerson } from './personnel-authority.interface';
import type { ConfigurationPerson } from './access-configuration.interface';

export interface AccountPermissionTemplate {
  role: AccessRole;
  building: BuildingAdminBuilding | null;
  buildings?: BuildingAdminBuilding[];
  specialties?: ProfessionalSpecialty[];
  personalRules?: PersonalPermissionRule[];
  pagePaths: string[];
  sourceVersion: number;
  /** Frozen authorization; never a live link to a role that may later change. */
  effectiveAuthorization?: import('./authorization-profile').EffectiveAuthorization;
}
export interface PersonnelPermissionArchive {
  accountId: string;
  name: string;
  appId?: string;
  personnelIdentity?: string;
  capturedAt: string;
  configurationRevision: number;
  template: AccountPermissionTemplate;
}
export interface PermissionInheritancePreview {
  source: AccountPermissionTemplate;
  before: AccountPermissionTemplate;
  after: AccountPermissionTemplate;
  conflicts: string[];
  warnings: string[];
  addedPages: string[];
  removedPages: string[];
}
export type HandoverModule = 'purchase' | 'inventory' | 'contracts' | 'leave' | 'overtime';
export interface PendingDuty {
  key: string;
  module: HandoverModule;
  recordId: string;
  title: string;
  dutyRecordId: string;
  phase: 'approval' | 'execution' | 'notification' | 'reconcile';
  status: 'pending' | 'in_progress' | 'terminal';
  stageKey: string;
  version: string;
  recipients: ConfigurationPerson[];
}
export interface HandoverContext {
  from: AuthorityPerson;
  to: AuthorityPerson;
  duties: AuthorityDuty[];
  directoryVersion: string;
}
export interface HandoverPreviewRequest {
  fromPersonId: string;
  toPersonId: string;
  dutyRecordIds: string[];
  mode: 'offboarding' | 'rotation';
  ownership?: HandoverPermissionOwnership[];
}
export interface HandoverGrantChoice { key: string; disposition: 'transfer' | 'retain' | 'shared'; dutyRecordId?: string; }
export interface HandoverPermissionOwnership { sourceAccountId: string; grants: HandoverGrantChoice[]; }
export interface HandoverGrantMetadata { title:string; nativeRole:AccessRole|null; scope:{building:BuildingAdminBuilding|null;buildings?:BuildingAdminBuilding[];specialties?:ProfessionalSpecialty[]}; }
export interface HandoverOwnershipPreview { sourceAccountId: string; kind: 'local' | 'feishu'; source: AccountPermissionTemplate; required: boolean; grantKeys: string[]; grantMetadata?:Record<string,HandoverGrantMetadata>; }
export interface HandoverBaseline {
  configurationRevision: number;
  directoryVersion: string;
  accounts: { id: string; version: number }[];
  duties: { recordId: string; version: number; fingerprint?: string }[];
  pending: { key: string; version: string }[];
  archives?: PermissionArchiveReference[];
}
export interface PermissionArchiveReference {
  accountId: string;
  configurationRevision: number;
  sourceVersion: number;
  templateHash: string;
}
export interface PersonnelHandoverPreview {
  permissionOwnership?: HandoverOwnershipPreview[];
  dutyRouting?: import('./personnel-duty-routing').PersonnelDutyRoutingChange[];
  fingerprint: string;
  requested: HandoverPreviewRequest;
  createdAt: string;
  baseline: HandoverBaseline;
  from: AuthorityPerson;
  to: AuthorityPerson;
  permissions: (PermissionInheritancePreview & { sourceAccountId: string; targetAccountId: string; sourceArchive?: PermissionArchiveReference; transfer?: AccountPermissionTemplate; sourceRetained?: AccountPermissionTemplate })[];
  pending: PendingDuty[];
  excluded: { key: string; reason: string }[];
  conflicts: string[];
  warnings: string[];
}
export interface PreflightResult { ready: boolean; reason?: string; alreadyCompleted?: boolean; }
export interface TransferReceipt {
  itemKey: string;
  mutationId: string;
  module: HandoverModule;
  recordId: string;
  version: string;
  status: 'accepted' | 'already_completed';
}
export interface TransferResult {
  status: 'syncing' | 'success' | 'error';
  error?: string;
}
export interface HandoverAdapter {
  readonly module: HandoverModule;
  listPending(context: HandoverContext): Promise<PendingDuty[]>;
  preflight(context: HandoverContext, item: PendingDuty, mutationId?:string): Promise<PreflightResult>;
  acceptTransfer(context: HandoverContext, item: PendingDuty, mutationId: string): Promise<TransferReceipt>;
  reconcile(context: HandoverContext, receipt: TransferReceipt, options?: { retryFailed?: boolean }): Promise<TransferResult>;
  listRecoveryTasks?():Promise<import('./personnel-task-recovery.interface').PersonnelRecoveryTask[]>;
  previewRecoveryTask?(input:import('./personnel-task-recovery.interface').PersonnelRecoveryRequest):Promise<import('./personnel-task-recovery.interface').PersonnelRecoveryPreview>;
  recoverTask?(input:import('./personnel-task-recovery.interface').PersonnelRecoveryRequest,actor:import('./personnel-task-recovery.interface').PersonnelRecoveryActor,authorize:()=>void):Promise<import('./personnel-task-recovery.interface').PersonnelRecoveryResult>;
}
export interface HandoverConfirmation {
  clientMutationId: string;
  expectedFingerprint: string;
  request: HandoverPreviewRequest;
}
export interface HandoverBatchItem {
  item: PendingDuty;
  status: 'pending' | 'accepted' | 'syncing' | 'success' | 'error' | 'skipped';
  receipt?: TransferReceipt;
  error?: string;
}
export interface HandoverBatch {
  id: string;
  version: number;
  clientMutationId: string;
  fingerprint: string;
  actorId: string;
  actorName: string;
  acceptedAt: string;
  updatedAt: string;
  status: 'accepted' | 'syncing' | 'success' | 'error' | 'cancelled';
  cancelledAt?: string;
  cancelledBy?: string;
  preview: PersonnelHandoverPreview;
  permissionStatus: 'pending' | 'success' | 'error';
  items: HandoverBatchItem[];
}
