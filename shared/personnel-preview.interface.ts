import type { ManagedAccount } from './access-configuration.interface';
import type { AuthorityDuty, AuthorityPerson, PersonnelAuthoritySnapshot } from './personnel-authority.interface';
import type { HandoverModule, PendingDuty, PermissionInheritancePreview } from './personnel-handover.interface';

export interface PersonnelOverviewPerson {
  person: AuthorityPerson;
  accounts: ManagedAccount[];
  archives: { accountId: string; capturedAt: string; role: ManagedAccount['role'] }[];
  duties: AuthorityDuty[];
}
export interface PersonnelOverview {
  mode: 'preview';
  directoryVersion: string;
  snapshotAt: number;
  configurationRevision: number;
  people: PersonnelOverviewPerson[];
  duties: AuthorityDuty[];
  problems: string[];
  issues: PersonnelAuthoritySnapshot['issues'];
}
export interface PersonnelPreviewRequest {
  fromPersonId: string;
  toPersonId: string;
  dutyRecordIds: string[];
  expectedDirectoryVersion: string;
  expectedConfigurationRevision: number;
}
export interface PersonnelPreviewCheck {
  module: HandoverModule;
  label: string;
  status: 'checked' | 'not_selected' | 'unavailable' | 'unsupported';
  scope: string;
  incomplete: string[];
  reason?: string;
  count?: number;
}
export interface PersonnelReadOnlyPreview {
  readOnly: true;
  fingerprint: string;
  directoryVersion: string;
  configurationRevision: number;
  createdAt: string;
  from: AuthorityPerson;
  to: AuthorityPerson;
  duties: AuthorityDuty[];
  permissions: (PermissionInheritancePreview & {
    sourceAccountId: string;
    targetAccountId: string;
    sourceArchiveAt?: string;
  })[];
  pending: PendingDuty[];
  excluded: { key: string; reason: string }[];
  checks: PersonnelPreviewCheck[];
  conflicts: string[];
  warnings: string[];
}
