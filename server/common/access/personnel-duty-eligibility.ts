import type { ConfigurationPerson } from '../../../shared/access-configuration.interface';
import type { ConfigurationState } from './access-configuration.store';
import { feishuIdentityFingerprint } from './feishu-access-approved-grants';

export type DutyEligibilityState = Partial<Pick<ConfigurationState, 'accounts' | 'personnelEmployment'>>;

export function filterActivePersonnelDutyMembers<T extends ConfigurationPerson>(state: DutyEligibilityState, appId: string, members: readonly T[]): T[] {
  return members.filter(person => {
    const id = `feishu-${feishuIdentityFingerprint(appId, person.openId)}`, account = state.accounts?.[id];
    const employment = state.personnelEmployment?.appId === appId ? state.personnelEmployment.inactive : undefined;
    const blocked = state.personnelEmployment?.appId === appId ? state.personnelEmployment.loginBlocked : undefined;
    const inactive = employment?.[id] === true || employment?.[id] !== false && !!account?.personnelIdentity && employment?.[account.personnelIdentity] === true;
    return !inactive && !blocked?.[id] && !(account?.personnelIdentity && blocked?.[account.personnelIdentity]) && !account?.reactivationRequired &&
      (!account || account.kind === 'feishu' && account.appId === appId && account.enabled && !account.deleted);
  });
}
