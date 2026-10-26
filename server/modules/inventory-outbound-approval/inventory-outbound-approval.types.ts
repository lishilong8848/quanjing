import type { WarehouseBuilding } from '../../../shared/inventory-management.interface';

export type InventoryOutboundApprovalAction = 'approve' | 'reject';

export interface InventoryOutboundApprovalApprover {
  openId: string;
  name: string;
}

export interface InventoryOutboundApprovalSnapshot {
  recordId: string;
  outboundNumber: string;
  version: number;
  policyVersion: string;
  applicantOpenId: string;
  applicantName: string;
  itemName: string;
  sku: string;
  specification: string;
  brand: string;
  quantity: number;
  unit: string;
  availableStock: number;
  building: WarehouseBuilding;
  location: string;
  reason: string;
  appliedAt: string;
  approvers: InventoryOutboundApprovalApprover[];
  managerRecipients?: InventoryOutboundApprovalApprover[];
}

export type InventoryOutboundApprovalRequestIdentity = Pick<
  InventoryOutboundApprovalSnapshot,
  | 'recordId'
  | 'outboundNumber'
  | 'applicantOpenId'
  | 'sku'
  | 'quantity'
  | 'building'
  | 'reason'
  | 'appliedAt'
>;

export type InventoryOutboundApprovalWorkKind =
  | 'approvalCardDelivery'
  | 'baseSync'
  | 'cardPatch'
  | 'resultNotification';

export type InventoryOutboundApprovalWorkStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface InventoryOutboundApprovalWorkState {
  id: string;
  kind: InventoryOutboundApprovalWorkKind;
  status: InventoryOutboundApprovalWorkStatus;
  attemptCount: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastError?: string;
  completedAt?: string;
}

export interface InventoryOutboundApprovalCardDelivery extends InventoryOutboundApprovalWorkState {
  kind: 'approvalCardDelivery';
  recipientOpenId: string;
  recipientName: string;
  deliveryUuid: string;
  messageId?: string;
}

export interface InventoryOutboundApprovalBaseSync extends InventoryOutboundApprovalWorkState {
  kind: 'baseSync';
}

export interface InventoryOutboundApprovalCardPatch extends InventoryOutboundApprovalWorkState {
  kind: 'cardPatch';
  recipientOpenId: string;
  recipientName: string;
  messageId: string;
}

export interface InventoryOutboundApprovalResultNotification extends InventoryOutboundApprovalWorkState {
  kind: 'resultNotification';
  recipientOpenId: string;
  recipientName: string;
  deliveryUuid: string;
  messageId?: string;
}

export interface InventoryOutboundApprovalRecoveredResultDelivery {
  recipientOpenId: string;
  recipientName: string;
  deliveryUuid: string;
  messageId: string;
}

export interface InventoryOutboundApprovalDecision {
  action: InventoryOutboundApprovalAction;
  actorOpenId: string;
  actorName: string;
  messageId: string;
  eventId: string;
  decidedAt: string;
  reason: string;
}

export type InventoryOutboundApprovalRegistrationStatus =
  | 'pending_base'
  | 'ready';

export interface InventoryOutboundApprovalRegistration {
  status: InventoryOutboundApprovalRegistrationStatus;
  attemptCount: number;
  lastAttemptAt?: string;
  lastError?: string;
  confirmedAt?: string;
}

export interface InventoryOutboundApprovalEntry {
  snapshot: InventoryOutboundApprovalSnapshot;
  snapshotFingerprint: string;
  registeredAt: string;
  updatedAt: string;
  registration: InventoryOutboundApprovalRegistration;
  approvalCards: InventoryOutboundApprovalCardDelivery[];
  decision?: InventoryOutboundApprovalDecision;
  baseSync?: InventoryOutboundApprovalBaseSync;
  cardPatches: InventoryOutboundApprovalCardPatch[];
  resultNotifications: InventoryOutboundApprovalResultNotification[];
  completedAt?: string;
  personnelHandover?: InventoryPendingHandover;
  personnelHandoverFromVersion?: number;
  managerNotificationHandovers?: InventoryManagerNotificationHandover[];
}

export interface InventoryPendingHandoverInput {
  recordId: string;
  expectedVersion: number;
  mutationId: string;
  dutyRecordId: string;
  sourcePersonRecordId: string;
  sourceOpenId: string;
  target: InventoryOutboundApprovalApprover & { personRecordId: string };
}

export interface InventoryPendingHandover extends InventoryPendingHandoverInput {
  targetVersion: number;
  fingerprint: string;
  acceptedAt: string;
}

export interface InventoryManagerNotificationHandoverInput extends InventoryPendingHandoverInput {
  expectedGeneration: number;
}
export interface InventoryManagerNotificationHandover extends InventoryManagerNotificationHandoverInput {
  targetGeneration: number;
  fingerprint: string;
  acceptedAt: string;
}

export interface InventoryOutboundApprovalDecisionInput {
  recordId: string;
  version: number;
  actorOpenId: string;
  messageId: string;
  eventId: string;
  action: InventoryOutboundApprovalAction;
  reason?: string;
}

export interface InventoryOutboundApprovalDecisionClaimResult {
  claimed: boolean;
  idempotent: boolean;
  decision: InventoryOutboundApprovalDecision;
  entry: InventoryOutboundApprovalEntry;
}

export interface InventoryOutboundApprovalWorkRef {
  recordId: string;
  version: number;
  kind: InventoryOutboundApprovalWorkKind;
  recipientOpenId?: string;
}

export interface InventoryOutboundApprovalClaimedWorkRef extends InventoryOutboundApprovalWorkRef {
  leaseToken: string;
}

export type InventoryOutboundApprovalWork =
  | InventoryOutboundApprovalCardDelivery
  | InventoryOutboundApprovalBaseSync
  | InventoryOutboundApprovalCardPatch
  | InventoryOutboundApprovalResultNotification;

export type InventoryOutboundApprovalWorkClaimResult =
  | {
      claimed: true;
      leaseToken: string;
      work: InventoryOutboundApprovalWork;
      entry: InventoryOutboundApprovalEntry;
    }
  | {
      claimed: false;
      work: InventoryOutboundApprovalWork;
      entry: InventoryOutboundApprovalEntry;
    };

export interface InventoryOutboundApprovalWorkCompletionInput extends InventoryOutboundApprovalClaimedWorkRef {
  messageId?: string;
}

export interface InventoryOutboundApprovalWorkFailureInput extends InventoryOutboundApprovalClaimedWorkRef {
  error: string;
  nextAttemptAt?: string;
}
