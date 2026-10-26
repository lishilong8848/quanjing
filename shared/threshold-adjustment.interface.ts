import type { ThresholdRecord } from './threshold-management.interface';

export interface ThresholdPerson {
  openId: string;
  name: string;
}
export type ThresholdApprovalRole = 'building' | 'professional';
export type ThresholdAdjustmentState =
  | 'routing'
  | 'pending'
  | 'approved'
  | 'awaiting_completion'
  | 'confirmed'
  | 'applying'
  | 'completed'
  | 'rejected'
  | 'conflict';
export interface ThresholdAdjustmentInput {
  clientMutationId: string;
  thresholdId: string;
  expectedVersion: number;
  expectedContent: string;
  value: string;
  reason: string;
  plannedAt: string;
  engineerOpenId?: string;
}
export interface ThresholdApprovalDecision {
  action: 'approve' | 'reject';
  actor: ThresholdPerson;
  at: string;
  eventId: string;
  messageId: string;
  reason: string;
}
export interface ThresholdApprovalStage {
  role: ThresholdApprovalRole;
  approver: ThresholdPerson;
  decision?: ThresholdApprovalDecision;
}
export interface ThresholdAdjustment {
  id: string;
  revision: number;
  policyVersion: 'threshold-dual-approval-v1';
  clientMutationId: string;
  applicant: ThresholdPerson;
  engineer: ThresholdPerson;
  before: ThresholdRecord;
  value: string;
  reason: string;
  submittedAt: string;
  plannedAt: string;
  execution?: {
    round: number;
    nextReminderAt: string;
    replies: {
      eventId: string;
      messageId: string;
      actor: ThresholdPerson;
      at: string;
      completed: boolean;
    }[];
  };
  state: ThresholdAdjustmentState;
  stages: ThresholdApprovalStage[];
  managers: ThresholdPerson[];
  error?: string;
  appliedRecord?: ThresholdRecord;
  syncState: 'pending' | 'success' | 'error';
}
export interface ThresholdAdjustmentContext {
  engineers: (ThresholdPerson & { profession: string; buildings: string[] })[];
  roles: (ThresholdPerson & {
    position: string;
    professions: string[];
    buildings: string[];
  })[];
  applicant?: ThresholdPerson;
  error?: string;
}
export const THRESHOLD_ADJUSTMENT_LABELS: Record<
  ThresholdAdjustmentState,
  string
> = {
  routing: '审批准备中',
  pending: '待审批',
  approved: '审批通过',
  awaiting_completion: '待工程师确认',
  confirmed: '调整已确认',
  applying: '阈值同步中',
  completed: '已生效',
  rejected: '已驳回',
  conflict: '阈值已变化',
};
