import type { PersonnelRequestCapacity } from './personnel-permission-request.interface';

export const PERSONNEL_ARCHIVE_CORRECTION_FIELDS = [
  'photo', 'employeeNo', 'phone', 'email', 'position', 'company', 'employment',
  'education', 'training', 'certificates', 'other',
] as const;
export type PersonnelArchiveCorrectionField = typeof PERSONNEL_ARCHIVE_CORRECTION_FIELDS[number];
export const PERSONNEL_ARCHIVE_CORRECTION_FIELD_LABELS: Record<PersonnelArchiveCorrectionField, string> = {
  photo: '照片', employeeNo: '工号', phone: '手机号', email: '电子邮箱', position: '岗位', company: '公司',
  employment: '任职资料', education: '教育经历', training: '培训与演练', certificates: '持证情况', other: '其他资料',
};
export interface CreatePersonnelArchiveCorrection {
  clientMutationId: string;
  fields: PersonnelArchiveCorrectionField[];
  /** Describe the correction without passwords, full identity numbers or unrelated personal data. */
  description: string;
}
export interface CancelPersonnelArchiveCorrection {
  clientMutationId: string; requestId: string; expectedRequestVersion: number;
}
export interface ReviewPersonnelArchiveCorrection extends CancelPersonnelArchiveCorrection {
  decision: 'resolve' | 'reject';
  /** Records what was checked or why rejected; this endpoint never writes the source personnel table. */
  comment: string;
}
export interface PersonnelArchiveCorrection {
  id: string; version: number; accountId: string; applicantName: string;
  fields: PersonnelArchiveCorrectionField[]; description: string;
  status: 'pending' | 'resolved' | 'rejected' | 'cancelled';
  createdAt: string; updatedAt: string;
  reviewerAccountId?: string; reviewerName?: string; comment?: string;
}
export interface PersonnelArchiveCorrectionSummary {
  total: number; pending: number; resolved: number; rejected: number; cancelled: number;
  capacity: PersonnelRequestCapacity;
}
