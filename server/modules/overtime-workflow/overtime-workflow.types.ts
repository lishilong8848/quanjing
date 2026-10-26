export type OvertimeWorkflowPhase =
  | 'pending_approval'
  | 'approval_pending'
  | 'approved'
  | 'rejected'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'source_deleted';

export interface OvertimeRoutePerson {
  name: string;
  openId: string;
  position: string;
  buildings: string[];
}

export interface OvertimeOrganizationRecord extends OvertimeRoutePerson {
  supervisorNames?: string[];
}

export type OvertimeApprovalRouteKind =
  | 'building_supervisor'
  | 'h_duty_supervisor'
  | 'station_110_electrical_supervisor'
  | 'manager_group';

export interface OvertimeApprovalRouteInput {
  applicant: OvertimeRoutePerson;
  organizationRecords: OvertimeOrganizationRecord[];
  resolveDuty?: (kind: 'overtime_supervisor' | 'overtime_manager' | 'professional_supervisor', fallback: () => OvertimeRoutePerson[], target: { building: string[]; specialty?: string }) => OvertimeRoutePerson[];
}

export interface OvertimeApprovalRoute {
  kind: OvertimeApprovalRouteKind;
  reason: string;
  approvers: OvertimeRoutePerson[];
  approverNames: string[];
}

export interface OvertimeApplicationSnapshot {
  recordId: string;
  applicantName: string;
  applicantOpenId: string;
  building: string;
  position: string;
  plannedStartAt: string;
  plannedEndAt: string;
  plannedHours: number;
  reason: string;
}

export type OvertimeApprovalCardAction = 'approve' | 'reject';

export interface OvertimeApprovalCardActionValue {
  version: 1;
  action: OvertimeApprovalCardAction;
  recordId: string;
}
