import type { AccessRole, BuildingAdminBuilding } from './access-control.interface';
import type { ProfessionalSpecialty } from './professional-access';

export const CONFIGURATION_PATH = '/system-configuration';
export type ManagedAccessRole = AccessRole;
export interface ManagedAccount {
  id: string;
  kind: 'local' | 'feishu';
  name: string;
  role: ManagedAccessRole;
  building: BuildingAdminBuilding | null;
  buildings?: BuildingAdminBuilding[];
  enabled: boolean;
  deleted: boolean;
  version: number;
  source: 'default' | 'configuration';
  appId?: string;
  openId?: string;
  identityHash?: string;
  passwordConfigured?: boolean;
  loginMethod?: 'personnel-password';
  personnelActive?: boolean;
  siteMember?: boolean;
  personnelAppId?: string;
  external?: boolean;
  specialties?: ProfessionalSpecialty[];
  permissionSource?: 'personnel' | 'manual';
  personnelSpecialties?: string;
  personnelIdentity?: string;
  personalRules?: import('./business-permissions').PersonalPermissionRule[];
  pagePaths?: string[];
  permissionsRevoked?: boolean;
  guestLoginAllowed?: boolean;
  authorizationBinding?: import('./authorization-profile').AuthorizationBinding;
  authorizationOverrides?: import('./authorization-profile').AuthorizationOverrides;
  effectiveAuthorization?: import('./authorization-profile').EffectiveAuthorization;
  reactivationRequired?: boolean;
}
export const CARD_ROLE_CODES = [
  'purchase_manager', 'purchase_approvers', 'purchase_executor',
  'building_executor', 'warehouse_responsible', 'warehouse_notify', 'contract_notify',
] as const;
export type CardRoleCode = typeof CARD_ROLE_CODES[number];
export interface ConfigurationPerson { openId: string; name: string; }
export interface CardRoleRule {
  appId: string;
  code: CardRoleCode;
  building: BuildingAdminBuilding | null;
  members: ConfigurationPerson[];
  version: number;
}
export interface EffectiveCardDuty {
  code: CardRoleCode;
  building: BuildingAdminBuilding | null;
  members: ConfigurationPerson[];
  status: 'resolved' | 'unknown' | 'blocked';
  source: 'personnel' | 'handover' | 'configuration' | 'default';
  sourceStatus?: 'active' | 'pending' | 'error' | 'paused';
  revision: number;
}
export interface ConfigurationAudit {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  target: string;
  action: string;
  before: string;
  after: string;
}
export interface AccessConfigurationResponse {
  schemaVersion?: 1 | 2;
  authorizationTemplates?: import('./authorization-profile').AuthorizationTemplate[];
  effectiveCardDuties?: EffectiveCardDuty[];
  personnelBaseline?: { id:string; confirmedAt:number; actorName:string; count:number };
  personnelSource?: import('./personnel-source.interface').PersonnelSourceState;
  personnelDutyAssignments?: Record<string, import('./personnel-duty-routing').PersonnelDutyAssignment>;
  revision: number;
  appId: string;
  accounts: ManagedAccount[];
  cardRules: CardRoleRule[];
  audit: ConfigurationAudit[];
  personnelSync?: PersonnelSyncStatus;
  rolePageRules?: import('./page-access').RolePageRules;
}
export interface PersonnelSyncStatus {
  attemptDay?: string;
  attempts?: number;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  status: 'idle' | 'syncing' | 'success' | 'error';
  error?: string;
  warning?: string;
  changed?: number;
}
export interface AccountMutation {
  clientMutationId: string;
  expectedRevision: number;
  id?: string;
  kind: 'local' | 'feishu';
  name: string;
  role: ManagedAccessRole;
  building: BuildingAdminBuilding | null;
  buildings?: BuildingAdminBuilding[];
  enabled: boolean;
  deleted?: boolean;
  openId?: string;
  password?: string;
  external?: boolean;
  specialties?: ProfessionalSpecialty[];
  personalRules?: import('./business-permissions').PersonalPermissionRule[];
  pagePaths?: string[];
  authorizationBinding?: import('./authorization-profile').AuthorizationBinding;
  authorizationOverrides?: import('./authorization-profile').AuthorizationOverrides;
  confirmReactivation?: boolean;
}

// 脱敏与保存校验共用请求字段，避免合法授权字段在中间件被丢弃。
export const ACCOUNT_MUTATION_FIELDS = [
  'clientMutationId', 'expectedRevision', 'id', 'kind', 'name', 'role',
  'building', 'enabled', 'deleted', 'openId', 'password', 'external',
  'specialties', 'buildings', 'personalRules', 'pagePaths',
  'authorizationBinding', 'authorizationOverrides', 'confirmReactivation',
] as const satisfies readonly (keyof AccountMutation)[];

export interface CardRoleMutation {
  clientMutationId: string;
  expectedRevision: number;
  code: CardRoleCode;
  building: BuildingAdminBuilding | null;
  members: ConfigurationPerson[];
  restoreDefault?: boolean;
}

export interface PageRoleMutation {
  clientMutationId: string;
  expectedRevision: number;
  role: AccessRole;
  pages: string[];
  restoreDefault?: boolean;
}
