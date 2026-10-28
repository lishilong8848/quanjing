import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { AccessConfigurationResponse, AccountMutation, CardRoleMutation, ConfigurationPerson, ManagedAccount } from '@shared/access-configuration.interface';
import type { PersonnelOverview, PersonnelPreviewRequest, PersonnelReadOnlyPreview } from '@shared/personnel-preview.interface';
import type { AuthorizationAccountChange, AuthorizationAccountPreview, AuthorizationRoleList, AuthorizationRoleMutation, AuthorizationRolePreview } from '@shared/authorization-profile';

const PERSONNEL_SOURCE_TIMEOUT_MS = 60_000;
async function request<T>(url: string, data?: unknown, timeout = 15_000): Promise<T> {
  const reading = data === undefined || url === '/personnel-preview' || url.endsWith('/preview') || url === '/personnel-handover/progress';
  try {
    const response = await axiosForBackend({ url: `/api/access/configuration${url}`, method: data === undefined ? 'GET' : 'POST',
      ...(data === undefined ? {} : { data }), timeout });
    if (response.status < 200 || response.status >= 300) throw new Error(`请求失败（${response.status}）`);
    return response.data as T;
  } catch (error) {
    const result = error as { code?: string; response?: { status?: number; data?: { message?: unknown } } };
    const raw = result.response?.data?.message;
    const message = Array.isArray(raw) ? raw.filter(value => typeof value === 'string').join('；') : typeof raw === 'string' ? raw : '';
    throw Object.assign(new Error(message || (result.code === 'ECONNABORTED' ? reading ? '读取超时，请重试' : '保存结果未确认，请核对进度后使用原请求重试' : '请求失败，请检查网络后重试')),{status:result.response?.status});
  }
}
export const loadConfiguration = () => request<AccessConfigurationResponse>('');
export const loadConfigurationPeople = () => request<{ appId: string; people: ConfigurationPerson[]; accounts: ManagedAccount[]; snapshotAt: number; personnelOverview?: PersonnelOverview }>('/people', undefined, PERSONNEL_SOURCE_TIMEOUT_MS);
export const loadPersonnelPreview = (data: PersonnelPreviewRequest) => request<PersonnelReadOnlyPreview>('/personnel-preview', data);
export const loadHandoverPreview=(data:import('@shared/personnel-handover.interface').HandoverPreviewRequest)=>request<import('@shared/personnel-handover.interface').PersonnelHandoverPreview>('/personnel-handover/preview',data);
export const confirmHandover=(data:import('@shared/personnel-handover.interface').HandoverConfirmation)=>request<import('@shared/personnel-handover.interface').HandoverBatch>('/personnel-handover/confirm',data);
export const loadHandoverBatches=(mutation?:string)=>request<import('@shared/personnel-handover.interface').HandoverBatch[]>(`/personnel-handover${mutation?`?clientMutationId=${encodeURIComponent(mutation)}`:''}`);
export const loadHandoverBatch=(id:string)=>request<import('@shared/personnel-handover.interface').HandoverBatch>('/personnel-handover/progress',{id});
export const retryHandover=(id:string,version:number)=>request<import('@shared/personnel-handover.interface').HandoverBatch>('/personnel-handover/retry',{id,version});
export const cancelHandover=(id:string,version:number)=>request<import('@shared/personnel-handover.interface').HandoverBatch>('/personnel-handover/cancel',{id,version});
export const loadRecoveryTasks = () => request<import('@shared/personnel-task-recovery.interface').PersonnelRecoveryTask[]>('/personnel-handover/recovery');
export const loadRecoveryPreview = (input: import('@shared/personnel-task-recovery.interface').PersonnelRecoveryRequest) => request<import('@shared/personnel-task-recovery.interface').PersonnelRecoveryPreview>('/personnel-handover/recovery/preview', input);
export const recoverOriginalTask = (input: import('@shared/personnel-task-recovery.interface').PersonnelRecoveryRequest) => request<import('@shared/personnel-task-recovery.interface').PersonnelRecoveryResult>('/personnel-handover/recovery', input);
export const saveAccount = (data: AccountMutation) => request<AccessConfigurationResponse>('/accounts', data);
export const synchronizePersonnel = () => request<AccessConfigurationResponse>('/personnel-sync', {});
export const previewPersonnelSource = () => request<import('@shared/personnel-source.interface').PersonnelSourcePreview>('/personnel-source/preview', {}, PERSONNEL_SOURCE_TIMEOUT_MS);
export const previewPersonnelBaseline = () => request<import('@shared/personnel-baseline.interface').PersonnelBaselinePreview>('/personnel-baseline/preview', {}, PERSONNEL_SOURCE_TIMEOUT_MS);
export const confirmPersonnelBaseline = (data:import('@shared/personnel-baseline.interface').PersonnelBaselineMutation) => request<AccessConfigurationResponse>('/personnel-baseline/confirm',data, PERSONNEL_SOURCE_TIMEOUT_MS);
export const changePersonnelSource = (data: import('@shared/personnel-source.interface').PersonnelSourceMutation) => request<AccessConfigurationResponse>('/personnel-source', data, PERSONNEL_SOURCE_TIMEOUT_MS);
export const saveCardRole = (data: CardRoleMutation) => request<AccessConfigurationResponse>('/card-roles', data);
export const loadCardMembers = (code: string, building: string | null) => request<{ members: ConfigurationPerson[] | null; description?: string }>(`/card-members?code=${encodeURIComponent(code)}${building ? `&building=${encodeURIComponent(building)}` : ''}`);

export const loadAuthorizationRoles = () => request<AuthorizationRoleList>('/roles');
export const previewAuthorizationRole = (data: AuthorizationRoleMutation) => request<AuthorizationRolePreview>('/roles/preview', data);
export const saveAuthorizationRole = (data: AuthorizationRoleMutation) => request<AccessConfigurationResponse>('/roles', data);
export const loadAccountAuthorization = (accountId: string) => request<AuthorizationAccountPreview>(`/permissions/effective?accountId=${encodeURIComponent(accountId)}`);
export const previewAccountAuthorization = (data: AuthorizationAccountChange) => request<AuthorizationAccountPreview>('/permissions/preview', data);
