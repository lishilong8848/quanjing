import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FollowUpCardAction } from './today-operations-follow-up-card.types';

export function parseFollowUpCardAction(payload: unknown): FollowUpCardAction {
  const event = object(payload);
  if (event.event_type !== undefined && event.event_type !== 'card.action.trigger') invalid();
  const action = object(event.action);
  if (action.tag !== 'button') invalid();
  let result: Omit<Extract<FollowUpCardAction, { kind: 'submit' }>, 'actorOpenId' | 'messageId' | 'eventId'>
    | { kind: 'view'; action: 'list' | 'summary'; batchId: string; page: number }
    | { kind: 'view'; action: 'edit'; batchId: string; index: number };
  if (action.name !== undefined && typeof action.name !== 'string') invalid();
  if (action.form_value !== undefined || (typeof action.name === 'string' && action.name.startsWith('today_followup_submit:'))) {
    if (typeof action.name !== 'string') invalid();
    if (action.value !== undefined && Object.keys(object(action.value)).length) invalid();
    const match = /^today_followup_submit:([a-f0-9]{32}):(0|[1-9]\d{0,2}):(0|[1-9]\d{0,15})$/u.exec(action.name);
    if (!match) invalid();
    const index = Number(match[2]), revision = Number(match[3]);
    if (!integer(index, 999) || !integer(revision, Number.MAX_SAFE_INTEGER)) invalid();
    const form = object(action.form_value);
    if (Object.keys(form).some(key => !['follow_up_status', 'follow_up_measure'].includes(key))) invalid();
    if (!['pending', 'acknowledged', 'completed'].includes(form.follow_up_status as string)
      || typeof form.follow_up_status !== 'string' || (form.follow_up_measure !== undefined && typeof form.follow_up_measure !== 'string')) invalid();
    const treatmentMeasure = (typeof form.follow_up_measure === 'string' ? form.follow_up_measure : '').normalize('NFC').replace(/\r\n?/gu, '\n').trim();
    const length = Array.from(treatmentMeasure).length;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(treatmentMeasure)
      || length > 500 || (form.follow_up_status === 'completed' && length < 2)) {
      throw new BadRequestException('处理措施最多 500 字，标记完成时需填写 2–500 字');
    }
    result = { kind: 'submit', batchId: match[1], index, revision,
      acknowledged: form.follow_up_status !== 'pending', completed: form.follow_up_status === 'completed', treatmentMeasure };
  } else {
    const value = object(action.value);
    if (value.workflowType !== 'today_operations_followup' || value.version !== 1
      || typeof value.batchId !== 'string' || !/^[a-f0-9]{32}$/u.test(value.batchId)) invalid();
    const allowed = ['workflowType', 'version', 'batchId', 'action', ...(value.action === 'list' ? ['page'] : value.action === 'edit' ? ['index'] : [])];
    if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
    if (value.action === 'list' && integer(value.page, 1_000)) result = { kind: 'view', action: 'list', batchId: value.batchId, page: value.page };
    else if (value.action === 'edit' && integer(value.index, 999)) result = { kind: 'view', action: 'edit', batchId: value.batchId, index: value.index };
    else if (value.action === 'summary') result = { kind: 'view', action: 'summary', batchId: value.batchId, page: 0 };
    else invalid();
  }
  const operator = object(event.operator), context = object(event.context);
  if (typeof operator.open_id !== 'string' || !/^ou_[A-Za-z0-9_-]{1,124}$/u.test(operator.open_id)
    || typeof context.open_message_id !== 'string' || !/^om_[A-Za-z0-9_-]{1,252}$/u.test(context.open_message_id)) invalid();
  if (event.event_id !== undefined && (typeof event.event_id !== 'string' || !event.event_id.trim()
    || event.event_id.length > 256 || /[\u0000-\u001f\u007f]/u.test(event.event_id))) invalid();
  const stable = { ...result, actorOpenId: operator.open_id, messageId: context.open_message_id };
  const eventId = `ws_today_followup_${createHash('sha256').update(event.event_id as string || JSON.stringify(stable)).digest('hex')}`;
  return { ...stable, eventId };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum: number): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum; }
function invalid(): never { throw new BadRequestException('异常跟进卡片回调无效'); }
