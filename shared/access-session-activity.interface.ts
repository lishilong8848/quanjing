/** Explicit user activity may extend only the currently confirmed session family. */
export const ACCESS_SESSION_ACTIVITY_PATH = '/api/access/session/renew';

export interface AccessSessionActivityRequest {
  principalFingerprint: string;
}
