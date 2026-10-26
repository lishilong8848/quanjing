import { createHash } from 'node:crypto';
import type { ChangeRequestPerson } from '@shared/change-request';
import {
  type BitableRecordItem,
  extractDisplayText,
  pickField,
} from '@server/common/feishu/bitable-direct-read';

export type ChangeRequestSubmitterFailureReason =
  | 'not-found'
  | 'duplicate'
  | 'account-count'
  | 'account-name-mismatch'
  | 'user-id-missing'
  | 'identity-mismatch';

export type ChangeRequestSubmitterResolution =
  | { ok: true; userId: string }
  | { ok: false; reason: ChangeRequestSubmitterFailureReason };

const USER_FIELD_NAMES: string[] = ['员工姓名', '人员'];
const DISPLAY_NAME_FIELD_NAMES: string[] = [
  '姓名',
  '员工姓名',
  '人员',
  '人员（文本）',
];

export function resolveChangeRequestSubmitterCandidate(
  records: readonly BitableRecordItem[],
  submitterName: string,
  submitterId?: string,
): ChangeRequestSubmitterResolution {
  const normalizedSubmitter = normalizeSubmitterName(submitterName);
  if (submitterId !== undefined) {
    const identified = records.filter((record) => {
      const userId = extractFirstUserId(
        pickField(record.fields || {}, USER_FIELD_NAMES),
      );
      return userId && publicSubmitterId(userId) === submitterId;
    });
    if (identified.length !== 1)
      return { ok: false, reason: 'identity-mismatch' };
    const resolved = resolveChangeRequestSubmitterCandidate(
      identified,
      submitterName,
    );
    return resolved.ok ? resolved : { ok: false, reason: 'identity-mismatch' };
  }
  const matches = records.filter((record) =>
    getRecordCandidateNames(record).some(
      (name) => normalizeSubmitterName(name) === normalizedSubmitter,
    ),
  );
  if (matches.length === 0) return { ok: false, reason: 'not-found' };
  if (matches.length > 1) return { ok: false, reason: 'duplicate' };

  const userField = pickField(matches[0].fields || {}, USER_FIELD_NAMES);
  if (!Array.isArray(userField) || userField.length !== 1) {
    return { ok: false, reason: 'account-count' };
  }
  const userName = extractFirstUserName(userField);
  if (userName && normalizeSubmitterName(userName) !== normalizedSubmitter) {
    return { ok: false, reason: 'account-name-mismatch' };
  }
  const userId = extractFirstUserId(userField);
  if (!userId) return { ok: false, reason: 'user-id-missing' };
  return { ok: true, userId };
}

export function publicSubmitterId(userId: string): string {
  return `cr-person-${createHash('sha256').update(`change-request-person\0${userId}`).digest('hex')}`;
}

export function listChangeRequestSubmitters(
  records: readonly BitableRecordItem[],
  activeUserIds?: ReadonlySet<string>,
): ChangeRequestPerson[] {
  const people = new Map<string, ChangeRequestPerson>();
  const accountCounts = new Map<string, number>();
  for (const record of records) {
    const userId = extractFirstUserId(
      pickField(record.fields || {}, USER_FIELD_NAMES),
    );
    if (userId) accountCounts.set(userId, (accountCounts.get(userId) || 0) + 1);
  }
  for (const record of records) {
    const name = extractDisplayText(
      pickField(record.fields || {}, DISPLAY_NAME_FIELD_NAMES),
      ' ',
    ).trim();
    const resolved = resolveChangeRequestSubmitterCandidate([record], name);
    if (!name || !resolved.ok) continue;
    if (activeUserIds && !activeUserIds.has(resolved.userId)) continue;
    const id = publicSubmitterId(resolved.userId);
    // Duplicate account rows are not eligible for an unambiguous ID lookup.
    if (accountCounts.get(resolved.userId) !== 1) continue;
    const description = ['机楼/专业', '岗位']
      .map((field) => extractDisplayText(record.fields?.[field], ' ').trim())
      .filter(Boolean)
      .join(' · ');
    people.set(id, { id, name, ...(description ? { description } : {}) });
  }
  return [...people.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-CN'),
  );
}

export function listEligibleChangeRequestSubmitterNames(
  records: readonly BitableRecordItem[],
): string[] {
  const candidates = new Map<string, string>();
  records.forEach((record) => {
    const displayName = extractDisplayText(
      pickField(record.fields || {}, DISPLAY_NAME_FIELD_NAMES),
      ' ',
    ).trim();
    const normalized = normalizeSubmitterName(displayName);
    if (normalized && !candidates.has(normalized)) {
      candidates.set(normalized, displayName);
    }
  });
  return [...candidates.values()]
    .filter((name) => resolveChangeRequestSubmitterCandidate(records, name).ok)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function getRecordCandidateNames(record: BitableRecordItem): string[] {
  const fields = record.fields || {};
  const userField = pickField(fields, USER_FIELD_NAMES);
  return [
    extractDisplayText(pickField(fields, DISPLAY_NAME_FIELD_NAMES), ' '),
    extractFirstUserName(userField) || '',
  ].filter((name) => normalizeSubmitterName(name).length > 0);
}

function extractFirstUserId(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  const first = field[0];
  if (typeof first === 'object' && first !== null && 'id' in first) {
    return String((first as { id: unknown }).id || '').trim() || null;
  }
  if (typeof first === 'string') return first.trim() || null;
  return null;
}

function extractFirstUserName(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  const first = field[0];
  if (typeof first === 'object' && first !== null && 'name' in first) {
    return String((first as { name: unknown }).name || '').trim() || null;
  }
  return null;
}

function normalizeSubmitterName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '');
}
