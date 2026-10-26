import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { normalizeInventoryOutboundRejectionReason } from './inventory-outbound-approval.validation';

const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,252}$/u;
const REJECTION_FORM_NAME_PATTERN =
  /^inventory_outbound_reject_submit:([A-Za-z0-9_-]{1,100}):(\d+)$/u;

type JsonObject = Record<string, unknown>;

interface InventoryOutboundCardActionBinding {
  eventId: string;
  actorOpenId: string;
  messageId: string;
  recordId: string;
  version: number;
}

export interface InventoryOutboundApprovalDecisionCardAction extends InventoryOutboundCardActionBinding {
  kind: 'decision';
  action: 'approve' | 'reject';
  reason?: string;
}

export interface InventoryOutboundOpenRejectionCardAction extends InventoryOutboundCardActionBinding {
  kind: 'open_rejection';
}

export interface InventoryOutboundReturnToApprovalCardAction extends InventoryOutboundCardActionBinding {
  kind: 'return_to_approval';
}

export type InventoryOutboundCardAction =
  | InventoryOutboundApprovalDecisionCardAction
  | InventoryOutboundOpenRejectionCardAction
  | InventoryOutboundReturnToApprovalCardAction;

export function parseInventoryOutboundCardAction(
  payload: unknown,
): InventoryOutboundCardAction {
  const event = requireObject(payload, '飞书出库审批卡片回调数据无效');
  if (
    event.event_type !== undefined &&
    event.event_type !== 'card.action.trigger'
  ) {
    throw new BadRequestException('飞书出库审批卡片回调事件类型无效');
  }
  const action = requireObject(event.action, '飞书出库审批卡片动作无效');
  if (action.tag !== 'button') {
    throw new BadRequestException('飞书出库审批卡片动作标签无效');
  }

  const rejection = parseRejectionForm(action);
  if (rejection) return finishParsedAction(event, rejection);

  assertExactKeys(action, ['tag', 'value'], '出库审批卡片动作包含未知字段');
  const value = requireObject(action.value, '出库审批卡片动作值无效');
  assertExactKeys(
    value,
    ['action', 'recordId', 'version', 'workflowType'],
    '出库审批卡片动作值包含未知字段',
  );
  if (
    value.workflowType !== 'inventory_outbound' ||
    (value.action !== 'approve' &&
      value.action !== 'open_reject' &&
      value.action !== 'return_to_approval') ||
    !isRecordId(value.recordId) ||
    !isApprovalVersion(value.version)
  ) {
    throw new BadRequestException('出库审批卡片动作值无效');
  }

  if (value.action === 'open_reject') {
    return finishParsedAction(event, {
      kind: 'open_rejection' as const,
      recordId: value.recordId,
      version: value.version,
    });
  }
  if (value.action === 'return_to_approval') {
    return finishParsedAction(event, {
      kind: 'return_to_approval' as const,
      recordId: value.recordId,
      version: value.version,
    });
  }
  return finishParsedAction(event, {
    kind: 'decision' as const,
    action: 'approve' as const,
    recordId: value.recordId,
    version: value.version,
  });
}

function parseRejectionForm(
  action: JsonObject,
): Omit<
  InventoryOutboundApprovalDecisionCardAction,
  'eventId' | 'actorOpenId' | 'messageId'
> | null {
  if (typeof action.name !== 'string') return null;
  const match = REJECTION_FORM_NAME_PATTERN.exec(action.name);
  if (!match) {
    throw new BadRequestException('出库驳回表单动作值无效');
  }
  assertExactKeys(
    action,
    ['form_value', 'name', 'tag'],
    '出库驳回表单包含未知字段',
  );
  const version = Number(match[2]);
  if (!isApprovalVersion(version) || !isRecordId(match[1])) {
    throw new BadRequestException('出库驳回表单动作值无效');
  }
  const formValue = requireObject(action.form_value, '请填写驳回原因');
  assertExactKeys(
    formValue,
    ['inventory_outbound_rejection_reason'],
    '出库驳回表单包含未知字段',
  );
  const reason = normalizeInventoryOutboundRejectionReason(
    formValue.inventory_outbound_rejection_reason,
  );
  if (!reason) {
    throw new BadRequestException('驳回原因需填写 2–500 字');
  }
  return {
    kind: 'decision',
    action: 'reject',
    recordId: match[1],
    version,
    reason,
  };
}

function isApprovalVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function finishParsedAction<
  T extends Omit<
    InventoryOutboundCardAction,
    'eventId' | 'actorOpenId' | 'messageId'
  >,
>(event: JsonObject, value: T): T & InventoryOutboundCardActionBinding {
  const operator = requireObject(event.operator, '飞书出库审批卡片操作人无效');
  const context = requireObject(
    event.context,
    '飞书出库审批卡片消息上下文无效',
  );
  if (!isOpenId(operator.open_id)) {
    throw new BadRequestException('飞书出库审批卡片操作人无效');
  }
  if (!isMessageId(context.open_message_id)) {
    throw new BadRequestException('飞书出库审批卡片消息标识无效');
  }
  const bound = {
    actorOpenId: operator.open_id,
    messageId: context.open_message_id,
    ...value,
  };
  return {
    ...bound,
    eventId: `ws_inventory_outbound_${createHash('sha256')
      .update(JSON.stringify(bound))
      .digest('hex')}`,
  };
}

function assertExactKeys(
  value: JsonObject,
  expected: string[],
  message: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new BadRequestException(message);
  }
}

function requireObject(value: unknown, message: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(message);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BadRequestException(message);
  }
  return value as JsonObject;
}

function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && RECORD_ID_PATTERN.test(value);
}

function isOpenId(value: unknown): value is string {
  return typeof value === 'string' && OPEN_ID_PATTERN.test(value);
}

function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_ID_PATTERN.test(value);
}
