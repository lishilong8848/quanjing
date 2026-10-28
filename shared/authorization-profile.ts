import type { AccessRole, BuildingAdminBuilding } from './access-control.interface';
import type { PersonalPermissionRule } from './business-permissions';
import type { ProfessionalSpecialty } from './professional-access';

/** null is an explicit empty base, never an implicit administrator/editor role. */
export interface AuthorizationBasePolicy {
  nativeRole: AccessRole | null;
  pages: string[];
  rules: PersonalPermissionRule[];
}
export interface AuthorizationPolicy extends AuthorizationBasePolicy {
  /** Static, non-recursive grants retained by a personnel handover, at most eight. */
  grantSnapshots?: AuthorizationGrantSnapshot[];
}
export interface AuthorizationGrantSnapshot {
  baseline: AuthorizationBasePolicy;
  overrides: AuthorizationOverrides;
  /** Later layers take precedence; no more than eight, never nested. */
  overrideLayers?: AuthorizationOverrides[];
  /** A native building/professional role must retain the originating account's scope. */
  scope: { building: BuildingAdminBuilding | null; buildings?: BuildingAdminBuilding[]; specialties?: ProfessionalSpecialty[] };
}
export interface AuthorizationOverrides {
  rules: PersonalPermissionRule[];
  allowPages: string[];
  denyPages: string[];
}
export interface AuthorizationTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  builtin: boolean;
  /** Disabling prevents new assignments; existing followers keep their policy. */
  enabled: boolean;
  policy: AuthorizationPolicy;
}
export type AuthorizationBinding =
  | { mode: 'follow'; templateId: string }
  | { mode: 'independent'; policy: AuthorizationPolicy };
export interface EffectiveAuthorization {
  mode: AuthorizationBinding['mode'];
  templateId?: string;
  templateVersion?: number;
  baseline: AuthorizationPolicy;
  overrides: AuthorizationOverrides;
}
export interface AuthorizationAccountChange {
  accountId: string;
  expectedRevision: number;
  binding: AuthorizationBinding;
  overrides: AuthorizationOverrides;
  building?: BuildingAdminBuilding | null;
  buildings?: BuildingAdminBuilding[];
  specialties?: ProfessionalSpecialty[];
}
export interface AuthorizationAccountMutation extends AuthorizationAccountChange {
  clientMutationId: string;
}
export interface AuthorizationAccountPreview {
  revision: number;
  accountId: string;
  before: EffectiveAuthorization;
  after: EffectiveAuthorization;
  sessionWillBeRevoked: boolean;
}
export interface AuthorizationRoleMutation {
  clientMutationId: string;
  expectedRevision: number;
  id?: string;
  name: string;
  description: string;
  enabled: boolean;
  policy: AuthorizationPolicy;
  deleted?: boolean;
}
export interface AuthorizationRoleList {
  revision: number;
  roles: (AuthorizationTemplate & { followerCount: number })[];
}
export interface AuthorizationRolePreview {
  revision: number;
  role: AuthorizationTemplate;
  affectedAccounts: { accountId: string; name: string; sessionWillBeRevoked: boolean; before: EffectiveAuthorization; after: EffectiveAuthorization }[];
}

export function detachAuthorization(effective: EffectiveAuthorization): {
  authorizationBinding: AuthorizationBinding;
  authorizationOverrides: AuthorizationOverrides;
} {
  return {
    authorizationBinding: { mode: 'independent', policy: structuredClone(effective.baseline) },
    authorizationOverrides: structuredClone(effective.overrides),
  };
}
