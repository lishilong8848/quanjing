import type { PersonnelDutyAssignment } from './personnel-duty-routing';
import type { PersonnelSourceBinding, PersonnelSourcePreview } from './personnel-source.interface';

export type PersonnelBaselineRoute = Omit<PersonnelDutyAssignment, 'confirmedBatchId' | 'baselineConfirmationId'>;
export interface PersonnelBaselineEvidence {
  source: string;
  observedAt: number;
  members: { openId: string; name: string }[];
  problem?: string;
}
export interface PersonnelBaselinePreview {
  configurationRevision: number;
  directoryVersion: string;
  oldSourceFingerprint: string;
  previewFingerprint: string;
  checkedAt: number;
  canConfirm: boolean;
  problems: string[];
  unmanagedKinds?: PersonnelSourcePreview['unmanagedKinds'];
  rows: (PersonnelSourcePreview['rows'][number] & { source: string })[];
  assignments: Record<string, PersonnelBaselineRoute>;
}
export interface PersonnelBaselineConfirmation {
  id: string;
  source: PersonnelSourceBinding;
  directoryVersion: string;
  oldSourceFingerprint: string;
  previewFingerprint: string;
  confirmedAt: number;
  actorId: string;
  actorName: string;
  rows: Record<string, PersonnelBaselineRoute>;
}
export interface PersonnelBaselineState {
  currentId: string;
  confirmations: Record<string, PersonnelBaselineConfirmation>;
}
export interface PersonnelBaselineMutation {
  clientMutationId: string;
  expectedRevision: number;
  expectedFingerprint: string;
}
