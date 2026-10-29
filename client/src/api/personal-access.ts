import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { EffectiveAuthorization } from '@shared/authorization-profile';
import type { createPermissionCatalog } from '@shared/permission-catalog';
import type { CreatePersonnelPermissionRequest, PersonnelPermissionRequest, ReviewPersonnelPermissionRequest } from '@shared/personnel-permission-request.interface';
import type { PersonalArchiveResponse } from '@shared/personnel-archive.interface';
import { personalPrivateRequest } from './personal-private-request';

export type PersonalPermissionCatalog = ReturnType<typeof createPermissionCatalog>;
export interface PersonalProfile {
  displayName: string;
  accountId: string;
  canChangePassword: boolean;
  requiresPasswordChange: boolean;
  effectiveAuthorization: EffectiveAuthorization | null;
  catalog: PersonalPermissionCatalog;
}
export interface ChangePersonalPassword { currentPassword: string; newPassword: string; confirmPassword: string; clientMutationId: string }
export interface ResetPersonalPassword { employeeName: string; identityNumber: string; newPassword: string; confirmPassword: string; clientMutationId: string }

async function request<T>(url: string, data?: unknown, password = false, options?: { signal?: AbortSignal; timeout?: number }): Promise<T> {
  try {
    const response = await axiosForBackend({ url, method: data === undefined ? 'GET' : 'POST',
      ...(data === undefined ? {} : { data }), ...(options?.signal ? { signal: options.signal } : {}), timeout: options?.timeout ?? (password ? 60_000 : 15_000) });
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error('请求失败'), { response });
    return response.data as T;
  } catch (failure) {
    const error = failure as { code?: string; response?: { status?: number; data?: { message?: unknown } } };
    const raw = error.response?.data?.message;
    const message = Array.isArray(raw) ? raw.filter(value => typeof value === 'string').join('；') : typeof raw === 'string' ? raw : '';
    const uncertain = password && (!error.response || error.response.status === 401 || error.response.status === 408 || (error.response.status || 0) >= 500);
    throw Object.assign(new Error(uncertain
      ? '密码更新结果未确认，可能已更新，请尝试新密码登录；也可保留当前内容，使用原请求重试。'
      : message || (data === undefined ? '读取失败，请重试' : '提交结果未确认，请保留当前内容并重试')), { status: error.response?.status, uncertain });
  }
}

async function passwordRequest(url: '/api/access/personal/password/change' | '/api/access/personal/password/reset', data: ChangePersonalPassword | ResetPersonalPassword): Promise<void> {
  await personalPrivateRequest<{ success: true }>(url, { body: data });
}
export const getPersonalProfile = () => request<PersonalProfile>('/api/access/personal/profile');
export const changePersonalPassword = (data: ChangePersonalPassword) => passwordRequest('/api/access/personal/password/change', data);
export const resetPersonalPassword = (data: ResetPersonalPassword) => passwordRequest('/api/access/personal/password/reset', data);
export const listOwnPermissionRequests = () => request<PersonnelPermissionRequest[]>('/api/access/personal/permission-requests');
export const createPermissionRequest = (data: CreatePersonnelPermissionRequest) => request<PersonnelPermissionRequest>('/api/access/personal/permission-requests', data);
export const listPermissionRequests = () => request<PersonnelPermissionRequest[]>('/api/access/configuration/permission-requests');
export const reviewPermissionRequest = (data: ReviewPersonnelPermissionRequest) => request<PersonnelPermissionRequest>('/api/access/configuration/permission-requests', data);

export const getPersonalArchive = (signal?: AbortSignal) => personalPrivateRequest<PersonalArchiveResponse>('/api/access/personal/archive', { signal });

/** The caller never supplies a record ID, token or upstream URL. */
export async function getPersonalArchivePhoto(signal?: AbortSignal): Promise<Blob> {
  return personalPrivateRequest<Blob>('/api/access/personal/archive/photo', { signal, photo: true });
}
