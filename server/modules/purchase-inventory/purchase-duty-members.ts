import type { AccessConfigurationService } from '../../common/access/access-configuration.service';
import type { AuthorityDutyKind } from '../../../shared/personnel-authority.interface';
import type { ConfigurationPerson } from '../../../shared/access-configuration.interface';

type Access = Pick<AccessConfigurationService, 'currentDutyRoutePeople'> & Partial<Pick<AccessConfigurationService, 'currentDutyMembers'>>;

/** Card membership is a duty source too; an explicit empty or invalid source is never bypassed. */
export function purchaseCurrentDutyMembers(access: Access, kind: AuthorityDutyKind, target: { building?: unknown; specialty?: unknown }): ConfigurationPerson[] | null {
  return typeof access.currentDutyMembers === 'function'
    ? access.currentDutyMembers(kind, target)
    : access.currentDutyRoutePeople(kind, target);
}
