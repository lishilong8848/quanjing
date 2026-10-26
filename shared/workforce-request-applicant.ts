import type { AccessPrincipal } from './access-control.interface';
import { resolveSelfServiceApplicant, type SelfServiceApplicant } from './self-service-applicant';

// This label selects the form mode only. The server also verifies the account's
// stable identity against the station personnel source before any submission.
export function isStation110DutyApplicant(principal: AccessPrincipal | undefined): boolean {
  return /^feishu-[a-f0-9]{64}$/.test(principal?.accountId || '') &&
    principal?.displayName?.replace(/\s/g, '').toLowerCase() === '南通基地-110kv变电站值班';
}

export function resolveWorkforceRequestApplicant(
  principal: AccessPrincipal | undefined,
  authenticated: boolean,
  action: string,
): SelfServiceApplicant {
  if (authenticated && isStation110DutyApplicant(principal)) return { mode: 'manual' };
  return resolveSelfServiceApplicant(principal, authenticated, action);
}

export function canSelectWorkforcePerson(
  principal: AccessPrincipal | undefined,
  buildings: readonly string[],
): boolean {
  return !isStation110DutyApplicant(principal) || buildings.some(building =>
    /^(?:110站|station_110|110kv变电站|110kv站)$/.test(building.replace(/\s/g, '').toLowerCase()),
  );
}
