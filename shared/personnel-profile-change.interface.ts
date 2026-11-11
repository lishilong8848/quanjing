import { EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE } from './employee-onboarding';
export const PROFILE_CHANGE_PHOTO_MAX_BYTES =
  EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE.maxBytesPerFile;
export type ProfileChangeField = 'phone' | 'email' | 'photo';
export type ProfileChangeStatus =
  | 'pending'
  | 'approved'
  | 'uploading'
  | 'writing'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'conflict'
  | 'reconciliation';
export interface ProfileChange {
  id: string;
  clientMutationId: string;
  version: number;
  accountId: string;
  applicantName: string;
  createdAt: string;
  updatedAt: string;
  status: ProfileChangeStatus;
  changes: Partial<Record<ProfileChangeField, string>>;
  before: Partial<Record<ProfileChangeField, string>>;
  reviewerName?: string;
  comment?: string;
  message?: string;
}
export interface CreateProfileChange {
  clientMutationId: string;
  phone?: string;
  email?: string;
}
export interface ReviewProfileChange {
  requestId: string;
  expectedVersion: number;
  clientMutationId: string;
  decision: 'approve' | 'reject';
  comment: string;
}

export interface CancelProfileChange {
  requestId: string;
  expectedVersion: number;
  clientMutationId: string;
}
export interface RecoverProfileChange extends CancelProfileChange {
  confirmUnchanged: boolean;
  uploadedPhotoToken?: string;
}
