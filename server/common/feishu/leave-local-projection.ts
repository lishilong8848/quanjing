import { resolve } from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ApprovedLeaveRequest } from './leave-approval-source';
import type { LeaveShiftSubstituteAssignment } from '../../modules/leave-workflow/leave-workflow.types';
import { readOriginalPostBackfillMetadata, writeOriginalPostBackfillMetadata } from '../../../shared/leave-original-post-backfill';
import { originalPostSignature } from '../../modules/leave-workflow/leave-two-level-substitution';
import { parseShanghaiLocalDateTime } from '../../../shared/leave-request-impact';

export interface LocalLeaveProjectionState {
  fingerprint: string;
  applications: ReadonlyMap<string, unknown>;
  actions: ReadonlyMap<string, unknown[]>;
  updates: ReadonlyMap<string, unknown[]>;
  error?: string;
}
export type LocalLeaveProjectionResult =
  | { kind: 'none' }
  | { kind: 'ready'; assignments: LeaveShiftSubstituteAssignment[] }
  | { kind: 'unavailable'; reason: string; scheduleRecordIds: string[] };

export function resolveLeaveWorkflowLedgerPath(override?: string): string {
  return resolve(override || process.env.LEAVE_WORKFLOW_LEDGER_PATH?.trim() || 'data/leave-workflow/ledger.json');
}

const cache = new Map<string, { stamp: string; state: LocalLeaveProjectionState }>();
const inFlight = new Map<string, Promise<LocalLeaveProjectionState>>();
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const nameKey = (value: unknown) => String(value || '').replace(/\s+/gu, '');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
const validOpenId = (value: unknown): value is string => typeof value === 'string' && /^ou_[A-Za-z0-9_-]{1,124}$/u.test(value);
const empty = (fingerprint: string, error?: string): LocalLeaveProjectionState => ({ fingerprint, applications: new Map(), actions: new Map(), updates: new Map(), ...(error ? { error } : {}) });
const stampOf = (stat: Awaited<ReturnType<typeof fs.stat>>) => [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');

export async function readLocalLeaveProjection(options: { ledgerPath?: string } = {}): Promise<LocalLeaveProjectionState> {
  const file = resolveLeaveWorkflowLedgerPath(options.ledgerPath);
  let stamp: string;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return empty(`invalid:${digest(file)}`, '替班台账路径不是文件');
    stamp = stampOf(stat);
  } catch (error) {
    return empty(`${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'}:${digest(file)}`, '替班台账暂不可读取');
  }
  const hit = cache.get(file);
  if (hit?.stamp === stamp) return hit.state;
  const key = `${file}:${stamp}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const operation = loadProjection(file, stamp).finally(() => inFlight.delete(key));
  inFlight.set(key, operation);
  return operation;
}

async function loadProjection(file: string, stamp: string): Promise<LocalLeaveProjectionState> {
  let state: LocalLeaveProjectionState;
  try {
    const bytes = await fs.readFile(file);
    if (stampOf(await fs.stat(file)) !== stamp) return empty(`changing:${digest(file + stamp)}`, '替班台账正在更新，请重试');
    const raw = object(JSON.parse(bytes.toString('utf8')));
    if (raw.version !== 4 || !Array.isArray(raw.applications) || !Array.isArray(raw.actions) || !Array.isArray(raw.substituteUpdates)) throw Error('ledger shape');
    const applications = new Map<string, unknown>();
    for (const entry of raw.applications) {
      const id = object(entry).recordId;
      if (!validId(id)) continue;
      applications.set(id, applications.has(id) ? { projectionError: '同一请假记录存在重复台账' } : entry);
    }
    const index = (rows: unknown[]) => {
      const result = new Map<string, unknown[]>();
      for (const entry of rows) {
        const id = object(entry).recordId;
        if (validId(id)) result.set(id, [...(result.get(id) || []), entry]);
      }
      return result;
    };
    state = { fingerprint: digest(bytes), applications, actions: index(raw.actions), updates: index(raw.substituteUpdates) };
  } catch {
    state = empty(`invalid:${digest(file + stamp)}`, '替班台账内容不可核实，请恢复台账后重试');
  }
  cache.set(file, { stamp, state });
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return state;
}

function normalizeAssignments(value: unknown): LeaveShiftSubstituteAssignment[] {
  if (!Array.isArray(value)) throw Error('缺少对应版本的替班安排');
  const seen = new Set<string>();
  return value.map(item => {
    const row = object(item);
    const start = parseShanghaiLocalDateTime(row.startAt)?.epochMs;
    const end = parseShanghaiLocalDateTime(row.endAt)?.epochMs;
    if (start === undefined || end === undefined || end <= start || row.shiftKey !== `${row.startAt}__${row.endAt}` || seen.has(row.shiftKey) || !validId(row.substitutePersonRecordId) || !validOpenId(row.substituteOpenId) || !nameKey(row.substituteName) || !Array.isArray(row.scheduleRecordIds) || !row.scheduleRecordIds.length || !row.scheduleRecordIds.every(validId)) throw Error('替班台账身份或班次无效');
    seen.add(row.shiftKey);
    const metadata = readOriginalPostBackfillMetadata(writeOriginalPostBackfillMetadata(row));
    if (metadata.originalPostBackfills?.length) {
      if (metadata.originalPostSignature !== originalPostSignature(metadata.originalPostBackfills.map(backup => backup.group)) || metadata.originalPostBackfills.some(backup => backup.substituteOpenId === row.substituteOpenId || backup.substitutePersonRecordId === row.substitutePersonRecordId || backup.group.scheduleRecordIds.some(id => row.scheduleRecordIds.includes(id)))) throw Error('原岗补位身份或签名不一致');
    }
    return { ...row, ...metadata } as LeaveShiftSubstituteAssignment;
  });
}

function assignmentKey(rows: LeaveShiftSubstituteAssignment[]): string {
  return JSON.stringify(rows.map(row => ({
    shiftKey: row.shiftKey, ids: [...row.scheduleRecordIds].sort(), personRecordId: row.substitutePersonRecordId, openId: row.substituteOpenId, name: nameKey(row.substituteName),
    original: (row.originalPostBackfills || []).map(backup => ({ shiftKey: backup.group.shiftKey, ids: [...backup.group.scheduleRecordIds].sort(), personRecordId: backup.substitutePersonRecordId, openId: backup.substituteOpenId, name: nameKey(backup.substituteName) })).sort((a,b) => a.shiftKey.localeCompare(b.shiftKey)),
  })).sort((a,b) => a.shiftKey.localeCompare(b.shiftKey)));
}

export function resolveLocalLeaveProjection(state: LocalLeaveProjectionState, request: ApprovedLeaveRequest): LocalLeaveProjectionResult {
  const application = object(state.applications.get(request.recordId));
  const updates = list(state.updates.get(request.recordId)).map(object);
  const actions = list(state.actions.get(request.recordId)).map(object);
  const snapshot = object(application.snapshot);
  const allRows = [...list(snapshot.shiftAssignments), ...updates.flatMap(update => [...list(update.previousShiftAssignments), ...list(update.shiftAssignments)]), ...actions.flatMap(action => [...list(action.previousShiftAssignments), ...list(action.shiftAssignments)])];
  const knownTwoLevel = request.requiresOriginalPostMetadata || request.shiftDetails?.some(detail => detail.originalPostBackfills?.length) || allRows.some(row => list(object(row).originalPostBackfills).length || object(row).backfillPersonRecordId || object(row).originalPostSignature);
  if (!knownTwoLevel) return { kind: 'none' };
  const scope = [...new Set([...request.impactedScheduleRecordIds, ...allRows.flatMap(row => [...list(object(row).scheduleRecordIds), ...list(object(row).originalPostBackfills).flatMap(backup => list(object(object(backup).group).scheduleRecordIds))])].filter(validId))];
  const unavailable = (reason: string): LocalLeaveProjectionResult => ({ kind: 'unavailable', reason, scheduleRecordIds: scope });
  try {
    if (state.error) return unavailable(state.error);
    if (application.projectionError) return unavailable(application.projectionError);
    if (application.recordId !== request.recordId || typeof application.clientMutationId !== 'string' || !application.clientMutationId.trim() || !validId(snapshot.applicantPersonRecordId) || !validOpenId(snapshot.applicantOpenId) || request.leaveStaff.length !== 1 || nameKey(request.leaveStaff[0]) !== nameKey(snapshot.applicantName)) return unavailable('原岗补位台账缺失或申请人身份不一致');
    if (!['approved', 'approved_syncing', 'sync_error'].includes(application.status) || application.resolvedAction !== 'approve') return unavailable('原岗补位台账并非已批准决议');
    const revision = request.assignmentRevision || 0;
    if (request.invalidAssignmentRevision || !Number.isSafeInteger(revision) || revision < 0) return unavailable('原岗补位云端版本无效');
    const candidates: LeaveShiftSubstituteAssignment[][] = [];
    if ((snapshot.assignmentRevision || 0) === revision) candidates.push(normalizeAssignments(snapshot.shiftAssignments));
    for (const update of updates) {
      if (update.revision === revision) candidates.push(normalizeAssignments(update.shiftAssignments));
      if (update.expectedRevision === revision) candidates.push(normalizeAssignments(update.previousShiftAssignments));
    }
    if (!candidates.length && revision === 0) {
      const finalAction = actions.filter(action => action.action === 'approve').at(-1);
      if (finalAction) candidates.push(normalizeAssignments(finalAction.shiftAssignments));
    }
    if (!candidates.length || candidates.some(rows => assignmentKey(rows) !== assignmentKey(candidates[0]))) return unavailable('原岗补位台账版本缺失或决议冲突');
    const assignments = candidates[0];
    if (!assignments.some(row => row.originalPostBackfills?.length)) return request.requiresOriginalPostMetadata ? unavailable('原岗补位台账与云端摘要不一致') : { kind: 'none' };
    for (const assignment of assignments) {
      const detail = request.shiftDetails?.find(row => row.revision === revision && row.shiftKey === assignment.shiftKey);
      const identity = object(detail);
      if (!detail || JSON.stringify([...detail.scheduleRecordIds].sort()) !== JSON.stringify([...assignment.scheduleRecordIds].sort()) || detail.substituteStaff.length !== 1 || nameKey(detail.substituteStaff[0]) !== nameKey(assignment.substituteName) || identity.substitutePersonRecordId !== assignment.substitutePersonRecordId || identity.substituteOpenId !== assignment.substituteOpenId) return unavailable('原岗补位对应的云端班次身份或版本尚未同步');
    }
    return { kind: 'ready', assignments: structuredClone(assignments) };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : '原岗补位台账不可核实');
  }
}
