import type { OrganizationPersonProfileDetail } from './organization-person-profile';

/** Self-service view; no source record identifier, credentials, or unrelated quality records. */
export type PersonalArchiveProfile = Omit<OrganizationPersonProfileDetail, 'recordId' | 'qualityAssessment'>;

export interface PersonalArchiveResponse {
  status: 'ready' | 'unbound';
  profile: PersonalArchiveProfile | null;
  snapshotAt: string | null;
}
