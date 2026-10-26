import type { AccessPrincipal } from './access-control.interface';
import type { SelfServiceApplicant } from './self-service-applicant';
import { resolveWorkforceRequestApplicant } from './workforce-request-applicant';

export type LeaveRequestApplicant = SelfServiceApplicant;

export function resolveLeaveRequestApplicant(
  principal: AccessPrincipal | undefined,
  authenticated: boolean,
): LeaveRequestApplicant {
  return resolveWorkforceRequestApplicant(principal, authenticated, '提交请休假或差旅申请');
}
