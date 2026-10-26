import type { BuildingAdminBuilding } from './access-control.interface';
import type { ProfessionalSpecialty } from './professional-access';
import type { AuthorityDutyKind } from './personnel-authority.interface';

export interface PersonnelDutyDefinition {
  appId: string;
  dutyRecordId: string;
  origin?: 'personnel_position';
  kind: AuthorityDutyKind;
  buildings: BuildingAdminBuilding[] | null;
  specialties: ProfessionalSpecialty[] | null;
  startsAt: number;
  endsAt: number | null;
  version: number;
  members: { personId: string; recordId: string; openId: string; name: string }[];
}
export type PersonnelDutyAssignment = PersonnelDutyDefinition & (
  { confirmedBatchId: string; baselineConfirmationId?: never } |
  { baselineConfirmationId: string; confirmedBatchId?: never }
);
export interface PersonnelDutyRoutingChange {
  previousFingerprint: string;
  assignment: PersonnelDutyDefinition;
}
