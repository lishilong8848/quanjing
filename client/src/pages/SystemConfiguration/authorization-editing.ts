import type { EffectiveAuthorization } from '@shared/authorization-profile';
import type { BusinessAction } from '@shared/business-permissions';
import { editPersonalPermission, type PersonalPermissionMode, type PersonalPermissionScope } from './personal-permission-editing';

export function editAuthorizationAction(value: EffectiveAuthorization, template: boolean, scope: PersonalPermissionScope, action: BusinessAction, mode: PersonalPermissionMode, newId: () => string): EffectiveAuthorization {
  if (template) return { ...value, baseline: { ...value.baseline, rules: editPersonalPermission(value.baseline.rules, scope, action, mode, newId) } };
  return { ...value, overrides: { ...value.overrides, rules: editPersonalPermission(value.overrides.rules, scope, action, mode, newId) } };
}

export function editAuthorizationPage(value: EffectiveAuthorization, template: boolean, page: string, mode: PersonalPermissionMode): EffectiveAuthorization {
  if (template) return { ...value, baseline: { ...value.baseline, pages: mode === 'allow' ? [...new Set([...value.baseline.pages, page])] : value.baseline.pages.filter(item => item !== page) } };
  return { ...value, overrides: { ...value.overrides,
    allowPages: [...value.overrides.allowPages.filter(item => item !== page), ...(mode === 'allow' ? [page] : [])],
    denyPages: [...value.overrides.denyPages.filter(item => item !== page), ...(mode === 'deny' ? [page] : [])],
  } };
}

export function authorizationPageMode(value: EffectiveAuthorization, page: string): PersonalPermissionMode {
  return value.overrides.denyPages.includes(page) ? 'deny' : value.overrides.allowPages.includes(page) ? 'allow' : 'inherit';
}

export const emptyAuthorizationOverrides = () => ({ rules: [], allowPages: [], denyPages: [] });
