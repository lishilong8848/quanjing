import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export type TodayOperationsAnomalyCardAction =
  | {
      kind: 'view';
      view: 'resolution' | 'anomaly';
      anomalyEventId: string;
      recordId: string;
      actorOpenId: string;
      messageId: string;
      eventId: string;
    }
  | {
      kind: 'terminal';
      action: 'acknowledged' | 'resolved';
      anomalyEventId: string;
      recordId?: string;
      actorOpenId: string;
      messageId: string;
      eventId: string;
      treatmentMeasure?: string;
    };

export function parseTodayOperationsAnomalyCardAction(
  payload: unknown,
): TodayOperationsAnomalyCardAction {
  const event = requireObject(payload, '飞书卡片回调数据无效');
  if (
    event.event_type !== undefined &&
    event.event_type !== 'card.action.trigger'
  ) {
    throw new BadRequestException('飞书卡片回调事件类型无效');
  }
  const action = requireObject(event.action, '飞书卡片动作无效');
  if (action.tag !== 'button') {
    throw new BadRequestException('飞书卡片动作标签无效');
  }

  const form = parseResolutionForm(action);
  if (form) return finish(event, form);

  const value = requireObject(action.value, '非今日航图异常卡片回调');
  if (
    value.workflowType !== 'today_operations_anomaly' ||
    value.version !== 1 ||
    !isEventId(value.anomalyEventId || value.anomalyId) ||
    !isRecordId(value.recordId)
  ) {
    throw new BadRequestException('今日航图异常卡片动作值无效');
  }
  if (
    value.action === 'open_resolution' ||
    value.action === 'return_to_anomaly'
  ) {
    return finish(event, {
      kind: 'view' as const,
      view:
        value.action === 'open_resolution'
          ? ('resolution' as const)
          : ('anomaly' as const),
      anomalyEventId: value.anomalyEventId || value.anomalyId,
      recordId: value.recordId,
    });
  }
  if (value.action !== 'acknowledge') {
    throw new BadRequestException('今日航图异常卡片动作值无效');
  }
  return finish(event, {
    kind: 'terminal' as const,
    action: 'acknowledged' as const,
    anomalyEventId: value.anomalyEventId || value.anomalyId,
    recordId: value.recordId,
  });
}

function parseResolutionForm(
  action: Record<string, any>,
): Omit<
  Extract<TodayOperationsAnomalyCardAction, { kind: 'terminal' }>,
  'actorOpenId' | 'messageId' | 'eventId'
> | null {
  const match =
    /^today_operations_resolve_submit:([a-f0-9]{64})(?::([A-Za-z0-9_-]{1,100}))?$/u.exec(
      String(action.name || ''),
    );
  if (!match) return null;
  const formValue = requireObject(action.form_value, '请填写处理措施');
  const treatmentMeasure = String(
    formValue.today_operations_treatment_measure || '',
  )
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (
    Array.from(treatmentMeasure).length < 2 ||
    Array.from(treatmentMeasure).length > 500
  ) {
    throw new BadRequestException('处理措施需填写 2–500 字');
  }
  return {
    kind: 'terminal',
    action: 'resolved',
    anomalyEventId: match[1],
    ...(match[2] ? { recordId: match[2] } : {}),
    treatmentMeasure,
  };
}

function finish<T extends Record<string, unknown>>(
  event: Record<string, any>,
  result: T,
): T & { actorOpenId: string; messageId: string; eventId: string } {
  const operator = requireObject(event.operator, '飞书卡片操作人无效');
  const context = requireObject(event.context, '飞书卡片消息上下文无效');
  if (!isOpenId(operator.open_id) || !isMessageId(context.open_message_id)) {
    throw new BadRequestException('飞书卡片操作人或消息标识无效');
  }
  const stable = {
    actorOpenId: operator.open_id,
    messageId: context.open_message_id,
    ...result,
  };
  return {
    ...stable,
    eventId: `ws_today_operations_${createHash('sha256')
      .update(String(event.event_id || JSON.stringify(stable)))
      .digest('hex')}`,
  };
}

function requireObject(value: unknown, message: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(message);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BadRequestException(message);
  }
  return value as Record<string, any>;
}

function isEventId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(value);
}

function isOpenId(value: unknown): value is string {
  return typeof value === 'string' && /^ou_[A-Za-z0-9_-]{1,124}$/u.test(value);
}

function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^om_[A-Za-z0-9_-]{1,252}$/u.test(value);
}
