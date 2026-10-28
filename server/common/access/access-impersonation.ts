import { normalizeAccessDisplayName } from './access-display-name';

export const IMPERSONATION_TTL_MS = 15 * 60 * 1000;
export const IMPERSONATION_ACTOR_COOKIE = 'vnet_impersonation_actor';
export const IMPERSONATION_ACTOR_HOST_COOKIE = '__Host-vnet_impersonation_actor';
export interface ImpersonationPayload {
  version: 11;
  accountId: string;
  authorizationVersion: number;
  actorAccountId: string;
  actorAuthorizationVersion: number;
  actorSessionFamilyId: string;
  actorExpiresAt: number;
  sessionFamilyId: string;
  issuedAt: number;
  expiresAt: number;
  actorName: string;
  targetName: string;
  clientMutationId: string;
}
export function validImpersonationPayload(value: unknown, now: number): value is ImpersonationPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).sort().join(',') !== 'accountId,actorAccountId,actorAuthorizationVersion,actorExpiresAt,actorName,actorSessionFamilyId,authorizationVersion,clientMutationId,expiresAt,issuedAt,sessionFamilyId,targetName,version' || payload.version !== 11) return false;
  for (const key of ['accountId', 'actorAccountId']) if (typeof payload[key] !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(payload[key] as string)) return false;
  for (const key of ['sessionFamilyId', 'actorSessionFamilyId']) if (typeof payload[key] !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(payload[key] as string)) return false;
  for (const key of ['authorizationVersion', 'actorAuthorizationVersion']) if (!Number.isSafeInteger(payload[key]) || Number(payload[key]) < 1) return false;
  for (const key of ['actorName', 'targetName']) if (typeof payload[key] !== 'string' || !(payload[key] as string).trim() || normalizeAccessDisplayName(payload[key] as string) !== payload[key]) return false;
  if (typeof payload.clientMutationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(payload.clientMutationId)) return false;
  for (const key of ['issuedAt', 'expiresAt', 'actorExpiresAt']) if (!Number.isSafeInteger(payload[key])) return false;
  const issued = Number(payload.issuedAt), expires = Number(payload.expiresAt), actorExpires = Number(payload.actorExpiresAt);
  // The actor's original deadline also bounds recovery after the target expires.
  return issued >= 0 && issued <= now && expires > issued && expires - issued <= IMPERSONATION_TTL_MS &&
    actorExpires >= expires && actorExpires > now && actorExpires - issued <= 60 * 60 * 1000 &&
    payload.sessionFamilyId !== payload.actorSessionFamilyId;
}
