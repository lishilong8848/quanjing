import type { EffectiveAuthorization } from '@shared/authorization-profile';
import type { AccessRole, BuildingAdminBuilding } from '@shared/access-control.interface';
import type { ProfessionalSpecialty } from '@shared/professional-access';
import type { createPermissionCatalog } from '@shared/permission-catalog';
import type { CreatePersonnelPermissionRequest, PersonnelPermissionRequest, ReviewPersonnelPermissionRequest, UpdatePersonnelPermissionRequest, CancelPersonnelPermissionRequest, PersonnelPermissionRequestSummary } from '@shared/personnel-permission-request.interface';
import type { CreatePersonnelArchiveCorrection, CancelPersonnelArchiveCorrection, ReviewPersonnelArchiveCorrection, PersonnelArchiveCorrection, PersonnelArchiveCorrectionSummary } from '@shared/personnel-archive-correction.interface';
import type { PersonalArchiveResponse } from '@shared/personnel-archive.interface';
import { personalPrivateRequest } from './personal-private-request';

export type PersonalPermissionCatalog = ReturnType<typeof createPermissionCatalog>;
export interface PersonalProfile {
  displayName: string;
  accountId: string;
  canChangePassword: boolean;
  requiresPasswordChange: boolean;
  authorizationVersion?: number;
  effectiveAuthorization: EffectiveAuthorization | null;
  catalog: PersonalPermissionCatalog;
  authorizationSummary?: { mode: 'follow' | 'independent' | 'legacy'; templateName: string | null; nativeRole: AccessRole | null; scopeSource: 'account' };
  suggestedScopes?: { buildings: BuildingAdminBuilding[]; specialties: ProfessionalSpecialty[] };
}
export interface ChangePersonalPassword { currentPassword: string; newPassword: string; confirmPassword: string; clientMutationId: string }
export interface ResetPersonalPassword { employeeName: string; identityNumber: string; newPassword: string; confirmPassword: string; clientMutationId: string }

export const getPersonalProfile = () => personalPrivateRequest<PersonalProfile>('/api/access/personal/profile');
export const changePersonalPassword = async (body: ChangePersonalPassword): Promise<void> => { await personalPrivateRequest('/api/access/personal/password/change', { body }); };
export const resetPersonalPassword = async (body: ResetPersonalPassword): Promise<void> => { await personalPrivateRequest('/api/access/personal/password/reset', { body }); };
export const listOwnPermissionRequests = () => personalPrivateRequest<PersonnelPermissionRequest[]>('/api/access/personal/permission-requests');
export const createPermissionRequest = (body: CreatePersonnelPermissionRequest) => personalPrivateRequest<PersonnelPermissionRequest>('/api/access/personal/permission-requests', { body });
export const updatePermissionRequest = (body: UpdatePersonnelPermissionRequest) => personalPrivateRequest<PersonnelPermissionRequest>('/api/access/personal/permission-requests/update', { body });
export const cancelPermissionRequest = (body: CancelPersonnelPermissionRequest) => personalPrivateRequest<PersonnelPermissionRequest>('/api/access/personal/permission-requests/cancel', { body });
export const getOwnPermissionRequestSummary = () => personalPrivateRequest<PersonnelPermissionRequestSummary>('/api/access/personal/permission-requests/summary');
export const listPermissionRequests = () => personalPrivateRequest<PersonnelPermissionRequest[]>('/api/access/configuration/permission-requests');
export const reviewPermissionRequest = (body: ReviewPersonnelPermissionRequest) => personalPrivateRequest<PersonnelPermissionRequest>('/api/access/configuration/permission-requests', { body });
export const getAdminPermissionRequestSummary = () => personalPrivateRequest<PersonnelPermissionRequestSummary>('/api/access/configuration/permission-requests/summary');

export const listOwnArchiveCorrections = () => personalPrivateRequest<PersonnelArchiveCorrection[]>('/api/access/personal/archive-corrections');
export const createArchiveCorrection = (body: CreatePersonnelArchiveCorrection) => personalPrivateRequest<PersonnelArchiveCorrection>('/api/access/personal/archive-corrections', { body });
export const cancelArchiveCorrection = (body: CancelPersonnelArchiveCorrection) => personalPrivateRequest<PersonnelArchiveCorrection>('/api/access/personal/archive-corrections/cancel', { body });
export const getOwnArchiveCorrectionSummary = () => personalPrivateRequest<PersonnelArchiveCorrectionSummary>('/api/access/personal/archive-corrections/summary');
export const listAdminArchiveCorrections = () => personalPrivateRequest<PersonnelArchiveCorrection[]>('/api/access/configuration/archive-corrections');
export const reviewArchiveCorrection = (body: ReviewPersonnelArchiveCorrection) => personalPrivateRequest<PersonnelArchiveCorrection>('/api/access/configuration/archive-corrections', { body });
export const getAdminArchiveCorrectionSummary = () => personalPrivateRequest<PersonnelArchiveCorrectionSummary>('/api/access/configuration/archive-corrections/summary');

export const getPersonalArchive = (signal?: AbortSignal) => personalPrivateRequest<PersonalArchiveResponse>('/api/access/personal/archive', { signal });
/** The caller never supplies a record ID, token or upstream URL. */
export const getPersonalArchivePhoto = (signal?: AbortSignal) => personalPrivateRequest<Blob>('/api/access/personal/archive/photo', { signal, photo: true });
