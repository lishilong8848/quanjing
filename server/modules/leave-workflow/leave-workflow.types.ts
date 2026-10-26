import type { LeaveOriginalPostBackfill } from '../../../shared/leave-original-post-backfill';
export type { LeaveOriginalPostBackfill } from '../../../shared/leave-original-post-backfill';
import type { TwoLevelSubstituteCandidate } from './leave-two-level-substitution';

export type LeaveApprovalClass = 'ordinary' | 'manager_direct' | 'manager';

export type LeaveDiscipline =
  | 'electrical'
  | 'hvac'
  | 'weak_current'
  | 'fire'
  | null;

export type LeaveApprovalStageKey = 'supervisor' | 'manager';

export interface LeaveRoutePerson {
  personRecordId?: string;
  name: string;
  openId: string;
  position: string;
  buildings: string[];
}

export interface LeaveSubstituteCandidate {
  personRecordId: string;
  name: string;
  openId: string;
  position: string;
  buildings: string[];
}

export interface LeaveShiftCandidateSet {
  shiftKey: string;
  candidates: LeaveSubstituteCandidate[];
  twoLevelCandidates?: TwoLevelSubstituteCandidate[];
}

export interface LeaveShiftAssignmentSelection {
  shiftKey: string;
  substitutePersonRecordId: string;
  backfillPersonRecordId?: string;
  originalPostSignature?: string;
}

export interface LeaveShiftSubstituteAssignment extends LeaveShiftAssignmentSelection {
  scheduleRecordIds: string[];
  scheduleDate: string;
  startAt: string;
  endAt: string;
  shift: string;
  buildings: string[];
  teams: string[];
  substituteName: string;
  substituteOpenId: string;
  updatedByOpenId: string;
  updatedByName: string;
  updatedAt: string;
  originalPostBackfills?: LeaveOriginalPostBackfill[];
}

export interface LeaveOrganizationRecord extends LeaveRoutePerson {
  supervisorNames?: string[];
}

export interface LeaveApprovalStage {
  key: LeaveApprovalStageKey;
  approvers: LeaveRoutePerson[];
  resolutionPolicy: 'first_legal_action';
}

export interface LeaveNotificationPlan {
  managerRecipients?: LeaveRoutePerson[];
  finalResultRecipients: LeaveRoutePerson[];
  professionalRecipients: LeaveRoutePerson[];
  substituteRecipients: LeaveRoutePerson[];
}

export interface LeaveApprovalPlan {
  approvalClass: LeaveApprovalClass;
  discipline: LeaveDiscipline;
  approvalDayCount: number;
  stages: LeaveApprovalStage[];
  notificationPlan: LeaveNotificationPlan;
}

export interface LeaveApprovalRoutingInput {
  applicant: LeaveRoutePerson;
  organizationRecords: LeaveOrganizationRecord[];
  approvalDayCount: number;
  managerEscalationApprovers?: LeaveRoutePerson[];
  resolveDuty?: (kind: 'leave_supervisor' | 'leave_manager' | 'professional_supervisor', fallback: () => LeaveRoutePerson[], target: { building: string[]; specialty?: string }) => LeaveRoutePerson[];
}
