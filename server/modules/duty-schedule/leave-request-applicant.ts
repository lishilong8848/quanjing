import type { AccessPrincipal } from '@shared/access-control.interface';
import { bindWorkforceRequestApplicant } from '@server/common/access/workforce-request-applicant';

export { assertSelfServicePersonnelIdentity as assertLeaveRequestPersonnelIdentity } from '@server/common/access/self-service-applicant';

export function bindLeaveRequestApplicant(
  requestedName: string,
  principal: AccessPrincipal | undefined,
  authenticated: boolean,
): string {
  return bindWorkforceRequestApplicant(requestedName, principal, authenticated, '提交请休假或差旅申请');
}
