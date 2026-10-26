import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { LeaveShiftAssignmentSelection } from './leave-workflow.types';
import { LEAVE_BACKFILL_V2_FIELD_PREFIX, leaveBackfillFieldName } from './leave-workflow.form-fields';

export const LEAVE_SHIFT_MAPPING_MAX_FIELDS = 64;
export const LEAVE_SHIFT_MAPPING_MAX_DECODED_BYTES = 16 * 1024;
const LEAVE_SHIFT_FIELD_PREFIX = 'leave_shift_substitute_';
const LEAVE_BACKFILL_FIELD_PREFIX = 'leave_shift_backfill_';

export interface LeaveApprovalCardAction {
  kind: 'approval';
  eventId: string;
  actorOpenId: string;
  messageId: string;
  action: 'approve' | 'reject';
  recordId: string;
  applicationKey: string;
  stageKey: 'supervisor' | 'manager';
  stageVersion: number;
  substitutePersonRecordId?: string;
  substituteRequired?: boolean;
  shiftSelections?: LeaveShiftAssignmentSelection[];
  rejectionReason?: string;
}

export interface LeaveSubstituteUpdateCardAction {
  kind: 'substitute_update';
  eventId: string;
  actorOpenId: string;
  messageId: string;
  recordId: string;
  expectedRevision: number;
  substitutePersonRecordId?: string;
  shiftSelections?: LeaveShiftAssignmentSelection[];
}

export interface LeaveAdjustmentNoChangeAction {
  kind: 'adjustment_no_change';
  eventId: string;
  actorOpenId: string;
  messageId: string;
  recordId: string;
  expectedRevision: number;
}

export interface LeaveCardViewAction {
  kind: 'view';
  eventId: string;
  actorOpenId: string;
  messageId: string;
  view:
    | 'rejection'
    | 'approval'
    | 'substitute_review'
    | 'substitute_required'
    | 'substitute_not_required';
  recordId: string;
  applicationKey: string;
  stageKey: 'supervisor' | 'manager';
  stageVersion: number;
  shiftSelections?: LeaveShiftAssignmentSelection[];
  substituteRequired?: boolean;
}

export interface LeaveAdjustmentViewAction {
  kind: 'adjustment_view';
  eventId: string;
  actorOpenId: string;
  messageId: string;
  recordId: string;
  expectedRevision: number;
  view: 'review' | 'selection';
  shiftSelections?: LeaveShiftAssignmentSelection[];
}

export type LeaveCardAction =
  | LeaveApprovalCardAction
  | LeaveSubstituteUpdateCardAction
  | LeaveAdjustmentNoChangeAction
  | LeaveAdjustmentViewAction
  | LeaveCardViewAction;

export function parseLeaveLongConnectionCardAction(
  payload: unknown,
): LeaveCardAction {
  const event = requireObject(payload, '飞书卡片回调数据无效');
  if (
    event.event_type !== undefined &&
    event.event_type !== 'card.action.trigger'
  ) {
    throw new BadRequestException('飞书卡片回调事件类型无效');
  }
  const action = requireObject(event.action, '飞书卡片动作无效');
  const substituteDecisionView = parseSubstituteDecisionViewAction(action);
  if (substituteDecisionView) {
    return finishParsedAction(event, substituteDecisionView);
  }
  if (action.tag !== 'button')
    throw new BadRequestException('飞书卡片动作标签无效');
  if (String(action.name || '').startsWith('leave_substitute_review_update_submit:')) {
    const parsed = parseSubstituteUpdateFormAction({ ...action, name: String(action.name).replace(/^leave_substitute_review_update_submit:/, 'leave_substitute_update_submit:') });
    if (parsed?.kind === 'adjustment_no_change') return finishParsedAction(event, parsed);
    if (!parsed?.shiftSelections) throw new BadRequestException('替班调整核对表单无效');
    return finishParsedAction(event, { kind: 'adjustment_view' as const, view: 'review' as const, recordId: parsed.recordId, expectedRevision: parsed.expectedRevision, shiftSelections: parsed.shiftSelections });
  }
  if (String(action.name || '').startsWith('leave_substitute_review_submit:')) {
    const parsed = parseSubstituteApprovalFormAction({ ...action, name: String(action.name).replace(/^leave_substitute_review_submit:/, 'leave_approve_submit:') });
    if (!parsed?.shiftSelections?.length) throw new BadRequestException('请为每个班次选择替班人员');
    return finishParsedAction(event, {
      kind: 'view' as const,
      view: 'substitute_review' as const,
      recordId: parsed.recordId,
      applicationKey: parsed.applicationKey,
      stageKey: parsed.stageKey,
      stageVersion: parsed.stageVersion,
      shiftSelections: parsed.shiftSelections,
      ...(parsed.substituteRequired !== undefined ? { substituteRequired: parsed.substituteRequired } : {}),
    });
  }
  const substituteDecisionSubmit = parseSubstituteDecisionFormAction(action);
  if (substituteDecisionSubmit) {
    return finishParsedAction(event, substituteDecisionSubmit);
  }
  const substituteUpdate = parseSubstituteUpdateFormAction(action);
  if (substituteUpdate) return finishParsedAction(event, substituteUpdate);
  const formAction =
    parseSubstituteApprovalFormAction(action) ||
    parseRejectionFormAction(action);
  if (formAction) {
    return finishParsedAction(event, formAction);
  }
  const value = requireObject(action.value, '非请休假审批卡片回调');
  if (value.workflowType !== 'leave') {
    throw new BadRequestException('非请休假审批卡片回调');
  }
  if (value.action === 'return_to_substitute_adjustment') {
    if (value.version !== 1 || !isRecordId(value.recordId) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) throw new BadRequestException('替班调整导航无效');
    return finishParsedAction(event, { kind: 'adjustment_view' as const, view: 'selection' as const, recordId: value.recordId, expectedRevision: value.expectedRevision });
  }
  const isApprovalAction =
    value.action === 'approve' || value.action === 'reject';
  const isViewAction =
    value.action === 'open_rejection' || value.action === 'return_to_approval';
  const hasSubstituteRequired = Object.prototype.hasOwnProperty.call(
    value,
    'substituteRequired',
  );
  if (
    value.version !== 1 ||
    (!isApprovalAction && !isViewAction) ||
    (value.stageKey !== 'supervisor' && value.stageKey !== 'manager') ||
    !isIdentifier(value.recordId) ||
    !isIdentifier(value.applicationKey) ||
    !Number.isSafeInteger(value.stageVersion) ||
    Number(value.stageVersion) < 1 ||
    (hasSubstituteRequired &&
      (value.action !== 'approve' ||
        typeof value.substituteRequired !== 'boolean'))
  ) {
    throw new BadRequestException('请休假审批卡片动作值无效');
  }
  if (isViewAction) {
    return finishParsedAction(event, {
      kind: 'view' as const,
      view:
        value.action === 'open_rejection'
          ? ('rejection' as const)
          : ('approval' as const),
      recordId: value.recordId,
      applicationKey: value.applicationKey,
      stageKey: value.stageKey,
      stageVersion: value.stageVersion,
    });
  }
  return finishParsedAction(event, {
    kind: 'approval' as const,
    action: value.action as 'approve' | 'reject',
    recordId: value.recordId,
    applicationKey: value.applicationKey,
    stageKey: value.stageKey,
    stageVersion: value.stageVersion,
    ...(hasSubstituteRequired
      ? { substituteRequired: value.substituteRequired }
      : {}),
  });
}

function parseSubstituteDecisionFormAction(
  action: Record<string, any>,
):
  | Omit<LeaveCardViewAction, 'eventId' | 'actorOpenId' | 'messageId'>
  | Omit<LeaveApprovalCardAction, 'eventId' | 'actorOpenId' | 'messageId'>
  | null {
  const match =
    /^leave_substitute_decision_submit:([A-Za-z0-9_-]{1,100}):(supervisor|manager):(\d+)$/u.exec(
      String(action.name || ''),
    );
  if (!match) return null;
  const recordId = match[1];
  const stageKey = match[2] as 'supervisor' | 'manager';
  const stageVersion = Number(match[3]);
  if (!Number.isSafeInteger(stageVersion) || stageVersion < 1) {
    throw new BadRequestException('请休假审批卡片动作值无效');
  }
  const formValue = requireObject(action.form_value, '请休假替班选择表单无效');
  const keys = Object.keys(formValue);
  if (keys.length !== 1 || keys[0] !== 'leave_substitute_requirement') {
    throw new BadRequestException('请休假替班选择表单包含未知字段');
  }
  const substituteRequired = parseSubstituteRequirement(
    formValue.leave_substitute_requirement,
  );
  const shared = {
    recordId,
    applicationKey: `leave:${recordId}`,
    stageKey,
    stageVersion,
  };
  return substituteRequired
    ? {
        kind: 'view',
        view: 'substitute_required',
        ...shared,
      }
    : {
        kind: 'approval',
        action: 'approve',
        substituteRequired: false,
        ...shared,
      };
}

function parseSubstituteDecisionViewAction(
  action: Record<string, any>,
): Omit<LeaveCardViewAction, 'eventId' | 'actorOpenId' | 'messageId'> | null {
  if (action.tag !== 'select_static') return null;
  const value = requireObject(action.value, '非请休假审批卡片回调');
  if (
    value.version !== 1 ||
    value.workflowType !== 'leave' ||
    value.action !== 'select_substitute_requirement' ||
    (value.stageKey !== 'supervisor' && value.stageKey !== 'manager') ||
    !isIdentifier(value.recordId) ||
    !isIdentifier(value.applicationKey) ||
    !Number.isSafeInteger(value.stageVersion) ||
    Number(value.stageVersion) < 1
  ) {
    throw new BadRequestException('请休假替班选择卡片动作值无效');
  }
  const formValue = isPlainObject(action.form_value)
    ? action.form_value
    : undefined;
  const substituteRequired = parseSubstituteRequirement(
    action.option ?? formValue?.leave_substitute_requirement,
  );
  return {
    kind: 'view',
    view: substituteRequired
      ? 'substitute_required'
      : 'substitute_not_required',
    recordId: value.recordId,
    applicationKey: value.applicationKey,
    stageKey: value.stageKey,
    stageVersion: value.stageVersion,
  };
}

function parseSubstituteApprovalFormAction(
  action: Record<string, any>,
): Omit<
  LeaveApprovalCardAction,
  'eventId' | 'actorOpenId' | 'messageId'
> | null {
  const name = String(action.name || '');
  const multiMatch =
    /^leave_approve_submit:([A-Za-z0-9_-]{1,100}):(supervisor|manager):(\d+):g(\d+):r([01])(?::(o1|d1))?$/u.exec(
      name,
    );
  const optionalSingleMatch =
    /^leave_approve_submit:([A-Za-z0-9_-]{1,100}):(supervisor|manager):(\d+):(o1|d1)$/u.exec(
      name,
    );
  const currentMatch =
    /^leave_approve_submit:([A-Za-z0-9_-]{1,100}):(supervisor|manager):(\d+)$/u.exec(
      name,
    );
  const legacyMatch =
    /^leave_approve_submit:([A-Za-z0-9_-]{1,100}):(\d+)$/u.exec(name);
  if (!multiMatch && !optionalSingleMatch && !currentMatch && !legacyMatch)
    return null;
  const recordId =
    multiMatch?.[1] ||
    optionalSingleMatch?.[1] ||
    currentMatch?.[1] ||
    legacyMatch?.[1] ||
    '';
  const stageKey = (multiMatch?.[2] ||
    optionalSingleMatch?.[2] ||
    currentMatch?.[2] ||
    'supervisor') as 'supervisor' | 'manager';
  const stageVersion = Number(
    multiMatch?.[3] ||
      optionalSingleMatch?.[3] ||
      currentMatch?.[3] ||
      legacyMatch?.[2],
  );
  const formValue = requireObject(action.form_value, '请休假审批表单无效');
  const decisionMarker = multiMatch?.[6] || optionalSingleMatch?.[4] || '';
  const optionalDecision = decisionMarker === 'o1';
  const resolvedRequiredDecision = decisionMarker === 'd1';
  const {
    leave_substitute_requirement: rawSubstituteRequirement,
    ...selectionValues
  } = formValue;
  const substituteRequired = optionalDecision
    ? parseSubstituteRequirement(rawSubstituteRequirement)
    : resolvedRequiredDecision
      ? true
      : undefined;
  if (!optionalDecision && rawSubstituteRequirement !== undefined) {
    throw new BadRequestException('请休假审批表单包含未知字段');
  }
  if (!Number.isSafeInteger(stageVersion) || stageVersion < 1) {
    throw new BadRequestException('请休假审批卡片动作值无效');
  }
  const shiftSelections = multiMatch
    ? parseShiftSelections(selectionValues, {
        expectedCount: Number(multiMatch[4]),
        required: multiMatch[5] === '1',
      })
    : [];
  const substitutePersonRecordId = multiMatch
    ? ''
    : String(selectionValues.leave_substitute_person_record_id || '').trim();
  if (substitutePersonRecordId && !isRecordId(substitutePersonRecordId)) {
    throw new BadRequestException('请先选择替班人员');
  }
  return {
    kind: 'approval',
    action: 'approve',
    recordId,
    applicationKey: `leave:${recordId}`,
    stageKey,
    stageVersion,
    ...(multiMatch ? { shiftSelections } : {}),
    ...(optionalDecision || resolvedRequiredDecision
      ? { substituteRequired }
      : {}),
    ...(substitutePersonRecordId ? { substitutePersonRecordId } : {}),
  };
}

function parseSubstituteRequirement(value: unknown): boolean {
  if (value === 'required') return true;
  if (value === 'not_required') return false;
  throw new BadRequestException('请选择是否需要替班');
}

function parseRejectionFormAction(
  action: Record<string, any>,
): Omit<
  LeaveApprovalCardAction,
  'eventId' | 'actorOpenId' | 'messageId'
> | null {
  const match =
    /^leave_reject_submit:([A-Za-z0-9_-]{1,100}):(supervisor|manager):(\d+)$/u.exec(
      String(action.name || ''),
    );
  if (!match) return null;
  const stageVersion = Number(match[3]);
  if (!Number.isSafeInteger(stageVersion) || stageVersion < 1) {
    throw new BadRequestException('请休假审批卡片动作值无效');
  }
  const formValue = requireObject(action.form_value, '请填写驳回原因');
  const rejectionReason = String(formValue.leave_rejection_reason || '').trim();
  if (rejectionReason.length < 2 || rejectionReason.length > 500) {
    throw new BadRequestException('驳回原因需填写 2–500 字');
  }
  return {
    kind: 'approval',
    action: 'reject',
    recordId: match[1],
    applicationKey: `leave:${match[1]}`,
    stageKey: match[2] as 'supervisor' | 'manager',
    stageVersion,
    rejectionReason,
  };
}

function parseSubstituteUpdateFormAction(
  action: Record<string, any>,
): Omit<LeaveSubstituteUpdateCardAction, 'eventId' | 'actorOpenId' | 'messageId'>
  | Omit<LeaveAdjustmentNoChangeAction, 'eventId' | 'actorOpenId' | 'messageId'>
  | null {
  const match =
    /^leave_substitute_update_submit:([A-Za-z0-9_-]{1,100}):(\d+)(?::g(\d+):r([01]))?$/u.exec(
      String(action.name || ''),
    );
  if (!match) return null;
  const expectedRevision = Number(match[2]);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new BadRequestException('替班调整版本无效');
  }
  const optionalMapping = Boolean(match[3]) && match[4] === '0';
  const formValue = requireObject(optionalMapping && action.form_value === undefined ? {} : action.form_value, '替班调整表单无效');
  const shiftSelections = match[3]
    ? parseShiftSelections(formValue, {
        expectedCount: Number(match[3]),
        required: match[4] === '1',
      })
    : [];
  if (optionalMapping && shiftSelections.length === 0) {
    return { kind: 'adjustment_no_change', recordId: match[1], expectedRevision };
  }
  const substitutePersonRecordId = match[3]
    ? ''
    : String(formValue.leave_substitute_person_record_id || '').trim();
  if (!match[3] && !isRecordId(substitutePersonRecordId)) {
    throw new BadRequestException('请选择新的替班人员');
  }
  return {
    kind: 'substitute_update',
    recordId: match[1],
    expectedRevision,
    ...(match[3] ? { shiftSelections } : { substitutePersonRecordId }),
  };
}

function parseShiftSelections(
  formValue: Record<string, any>,
  options: { expectedCount: number; required: boolean },
): LeaveShiftAssignmentSelection[] {
  if (
    !Number.isSafeInteger(options.expectedCount) ||
    options.expectedCount < 1 ||
    options.expectedCount > LEAVE_SHIFT_MAPPING_MAX_FIELDS
  ) {
    throw new BadRequestException('逐班次替班字段数量无效');
  }
  const entries = Object.entries(formValue);
  const mappingEntries = entries.filter(([name]) =>
    name.startsWith(LEAVE_SHIFT_FIELD_PREFIX),
  );
  const backupEntries = entries.filter(([name]) => name.startsWith(LEAVE_BACKFILL_FIELD_PREFIX) || name.startsWith(LEAVE_BACKFILL_V2_FIELD_PREFIX));
  if (mappingEntries.length + backupEntries.length !== entries.length) {
    throw new BadRequestException('逐班次替班表单包含未知字段');
  }
  if (
    entries.length > LEAVE_SHIFT_MAPPING_MAX_FIELDS ||
    mappingEntries.length > options.expectedCount ||
    backupEntries.length > options.expectedCount
  ) {
    throw new BadRequestException('逐班次替班字段数量超出限制');
  }

  const decoded: LeaveShiftAssignmentSelection[] = mappingEntries.map(([name, rawValue]) => {
    const token = name.slice(LEAVE_SHIFT_FIELD_PREFIX.length);
    if (!token || !/^[A-Za-z0-9_-]+$/u.test(token) || token.length % 4 === 1) {
      throw new BadRequestException('逐班次替班字段标识无效');
    }
    const shiftKey = Buffer.from(token, 'base64url').toString('utf8');
    if (!shiftKey || shiftKey.includes('\uFFFD')) {
      throw new BadRequestException('逐班次替班字段标识无效');
    }
    return {
      shiftKey,
      substitutePersonRecordId: String(rawValue || '').trim(),
    };
  });
  if (new Set(decoded.map((item) => item.shiftKey)).size !== decoded.length) {
    throw new BadRequestException('逐班次替班字段重复');
  }

  let decodedBytes = 0;
  for (const selection of decoded) {
    decodedBytes +=
      Buffer.byteLength(selection.shiftKey, 'utf8') +
      Buffer.byteLength(selection.substitutePersonRecordId, 'utf8');
    if (decodedBytes > LEAVE_SHIFT_MAPPING_MAX_DECODED_BYTES) {
      throw new BadRequestException('逐班次替班表单内容超出限制');
    }
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}__\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(
        selection.shiftKey,
      ) ||
      !isRecordId(selection.substitutePersonRecordId)
    ) {
      throw new BadRequestException('逐班次替班选择无效');
    }
  }
  const backupShiftKeys = new Set<string>();
  for (const [name, rawValue] of backupEntries) {
    let identity: unknown;
    if (name.startsWith(LEAVE_BACKFILL_V2_FIELD_PREFIX)) {
      const match = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u.exec(name.slice(LEAVE_BACKFILL_V2_FIELD_PREFIX.length));
      if (!match) throw new BadRequestException('原岗补位字段标识无效');
      const signature = Buffer.from(match[2], 'base64url').toString('hex');
      const primary = decoded.find((selection) => leaveBackfillFieldName(selection.shiftKey, selection.substitutePersonRecordId, signature) === name);
      if (!primary) throw new BadRequestException('原岗补位字段标识无效');
      identity = [primary.shiftKey, primary.substitutePersonRecordId, signature];
    } else {
      const token = name.slice(LEAVE_BACKFILL_FIELD_PREFIX.length);
      if (!token || token.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(token) || token.length % 4 === 1) throw new BadRequestException('原岗补位字段标识无效');
      try { identity = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { throw new BadRequestException('原岗补位字段标识无效'); }
    }
    if (!Array.isArray(identity) || identity.length !== 3 || !identity.every((value) => typeof value === 'string')) throw new BadRequestException('原岗补位字段标识无效');
    const [shiftKey, primaryId, signature] = identity as string[];
    const primary = decoded.find((selection) => selection.shiftKey === shiftKey);
    const backupId = String(rawValue || '').trim();
    decodedBytes += Buffer.byteLength(JSON.stringify(identity), 'utf8') + Buffer.byteLength(backupId, 'utf8');
    if (decodedBytes > LEAVE_SHIFT_MAPPING_MAX_DECODED_BYTES || backupShiftKeys.has(shiftKey) || !primary || primary.substitutePersonRecordId !== primaryId || !/^[a-f0-9]{64}$/u.test(signature) || !isRecordId(backupId) || backupId === primaryId) throw new BadRequestException('原岗补位选择无效');
    backupShiftKeys.add(shiftKey);
    primary.backfillPersonRecordId = backupId;
    primary.originalPostSignature = signature;
  }
  if (options.required && decoded.length !== options.expectedCount) {
    throw new BadRequestException('请为每个班次选择替班人员');
  }
  return decoded;
}

function finishParsedAction<T extends Record<string, unknown>>(
  event: Record<string, any>,
  value: T,
): T & { eventId: string; actorOpenId: string; messageId: string } {
  const operator = requireObject(event.operator, '飞书卡片操作人无效');
  const context = requireObject(event.context, '飞书卡片消息上下文无效');
  if (!isOpenId(operator.open_id) || !isMessageId(context.open_message_id)) {
    throw new BadRequestException('飞书卡片操作人或消息标识无效');
  }
  const parsed = {
    actorOpenId: operator.open_id,
    messageId: context.open_message_id,
    ...value,
  } as const;
  return {
    ...parsed,
    eventId: `ws_leave_${createHash('sha256')
      .update(JSON.stringify(parsed))
      .digest('hex')}`,
  };
}

function requireObject(value: unknown, message: string): Record<string, any> {
  if (!isPlainObject(value)) {
    throw new BadRequestException(message);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/u.test(value);
}

function isOpenId(value: unknown): value is string {
  return typeof value === 'string' && /^ou_[A-Za-z0-9_-]{1,124}$/u.test(value);
}

function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
}

function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^om_[A-Za-z0-9_-]{1,252}$/u.test(value);
}
