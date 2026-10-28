import type { AccessRole, AccessPrincipal } from './access-control.interface';
import { hasBusinessPermissionSomewhere } from './business-permissions';
import type { AliMonthlyQualityEvidence } from './risk-inspection.interface';

export const ORGANIZATION_PERSON_PROFILE_ROLES = [
  'admin',
  'editor',
] as const satisfies readonly AccessRole[];

export function canViewOrganizationPersonProfile(principal: AccessRole | AccessPrincipal): boolean {
  if(typeof principal!=='string' && principal.effectiveAuthorization) return hasBusinessPermissionSomewhere(principal,{module:'organization_profile',action:'read'});
  return (ORGANIZATION_PERSON_PROFILE_ROLES as readonly AccessRole[]).includes(
    typeof principal==='string'?principal:principal.role,
  );
}

export const ORGANIZATION_PERSON_PROFILE_SOURCES = [
  'organization',
  'certificate',
] as const;

export type OrganizationPersonProfileSource =
  (typeof ORGANIZATION_PERSON_PROFILE_SOURCES)[number];

export function parseOrganizationPersonProfileSource(
  value: unknown,
): OrganizationPersonProfileSource {
  if (
    typeof value === 'string' &&
    (ORGANIZATION_PERSON_PROFILE_SOURCES as readonly string[]).includes(value)
  ) {
    return value as OrganizationPersonProfileSource;
  }
  throw new Error('人员档案来源无效');
}

export const MBTI_TYPE_CODES = [
  'ISTJ',
  'ISFJ',
  'INFJ',
  'INTJ',
  'ISTP',
  'ISFP',
  'INFP',
  'INTP',
  'ESTP',
  'ESFP',
  'ENFP',
  'ENTP',
  'ESTJ',
  'ESFJ',
  'ENFJ',
  'ENTJ',
] as const;

export type MbtiTypeCode = (typeof MBTI_TYPE_CODES)[number];

export type OrganizationPersonEmploymentStatus =
  | 'active'
  | 'departed'
  | 'transferred'
  | 'unknown';

export interface OrganizationPersonProfileScores {
  responsibility: number | null;
  stability: number | null;
  collaboration: number | null;
  growthPotential: number | null;
}

export interface OrganizationPersonAbilityScore {
  key:
    | 'electricalOperations'
    | 'hvacFundamentals'
    | 'emergencyResponse'
    | 'safetyCompliance'
    | 'teamwork'
    | 'drillPractice';
  label: string;
  score: number | null;
  benchmark: number | null;
}

export interface OrganizationPersonEmploymentHistoryItem {
  id: string;
  date: string | null;
  title: string;
  description: string | null;
  kind: 'entry' | 'position' | 'transfer' | 'departure';
}

export interface OrganizationPersonTrainingSummary {
  completedCourses: number | null;
  totalCourses: number | null;
  completionRate: number | null;
  averageScore: number | null;
  attendanceRate: number | null;
  finalScore: number | null;
}

export interface OrganizationPersonDrillSummary {
  annualCount: number | null;
  latestRating: string | null;
  latestTitle: string | null;
  latestDate: string | null;
}

export interface OrganizationPersonCertificate {
  id: string;
  name: string;
  status: 'valid' | 'expiring' | 'expired' | 'unknown';
  expiryDate: string | null;
}

export type OrganizationPersonCertificateSource =
  | 'personnel'
  | 'certificate'
  | 'demo'
  | null;

export interface OrganizationPersonQualityRecord {
  id: string;
  year: string | null;
  month: string;
  building: string;
  item: string;
  issue: string;
  supplemental: string;
  attachments: AliMonthlyQualityEvidence[];
  images: AliMonthlyQualityEvidence[];
}

export interface OrganizationPersonQualityAssessment {
  status: 'ready' | 'stale' | 'unavailable';
  records: OrganizationPersonQualityRecord[];
  sourceUpdatedAt: string | null;
}

export interface OrganizationPersonProfileDetail {
  recordId: string;
  name: string;
  employeeNo: string | null;
  photoUrl: string | null;
  employmentStatus: OrganizationPersonEmploymentStatus;
  position: string | null;
  systemPosition: string | null;
  company: string | null;
  employmentType: string | null;
  buildingsSpecialties: string[];
  team: string | null;
  shift: string | null;
  supervisorName: string | null;
  phone: string | null;
  email: string | null;
  idCardMasked: string | null;
  entryDate: string | null;
  departureDate: string | null;
  departureReason: string | null;
  education: string | null;
  school: string | null;
  major: string | null;
  graduationDate: string | null;
  hobbies: string[];
  vehiclePlate: string | null;
  specialties: string[];
  mbti: MbtiTypeCode | null;
  profileScores: OrganizationPersonProfileScores;
  abilities: OrganizationPersonAbilityScore[];
  employmentHistory: OrganizationPersonEmploymentHistoryItem[];
  training: OrganizationPersonTrainingSummary;
  drill: OrganizationPersonDrillSummary;
  certificates: OrganizationPersonCertificate[];
  certificateSource: OrganizationPersonCertificateSource;
  qualityAssessment: OrganizationPersonQualityAssessment;
  updatedAt: string | null;
}

export interface OrganizationPersonProfileResponse {
  profile: OrganizationPersonProfileDetail;
}
