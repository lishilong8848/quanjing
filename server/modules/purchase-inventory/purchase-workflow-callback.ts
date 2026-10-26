import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import {
  parsePurchaseBatchFulfillmentSubmitName,
  purchaseBatchReceiptFieldName,
} from './purchase-batch-fulfillment-card';

const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_OPEN_ID_LENGTH = 128;
const MAX_MESSAGE_ID_LENGTH = 256;
const MAX_CHALLENGE_LENGTH = 1024;
const MAX_REJECTION_REASON_CODE_POINTS = 500;
const MAX_NOTE_CODE_POINTS = 500;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]+$/;
const CARD_UPDATE_TOKEN_PATTERN = /^c-[A-Za-z0-9_-]{1,512}$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const NON_NEWLINE_CONTROL_PATTERN =
  /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

type HeaderValue = string | string[] | undefined;
type Headers = Record<string, HeaderValue>;
type JsonObject = Record<string, unknown>;

export interface PurchaseCardCallbackInput {
  headers: Headers;
  rawBody: string | Buffer;
  now: Date | number;
}

export interface PurchaseCardCallbackConfig {
  verificationToken: string;
  encryptKey: string;
  legacyApproverOpenIds: string[];
  managerApproverOpenId: string;
  managerApproverOpenIds?: string[];
  authorizeFromDeliverySnapshot?: boolean;
}

export type PurchaseManagerCardAction =
  | 'choose_comprehensive'
  | 'choose_building_self'
  | 'open_reject'
  | 'submit_reject';

export type PurchaseCardCallbackResult =
  | { kind: 'challenge'; challenge: string }
  | {
      kind: 'legacy_action';
      messageId?: string;
      eventId: string;
      operatorOpenId: string;
      action: 'approve' | 'reject';
      executionRecordId: string;
    }
  | {
      kind: 'manager_action';
      eventId: string;
      operatorOpenId: string;
      messageId: string;
      action: 'choose_comprehensive' | 'choose_building_self' | 'open_reject';
      executionRecordId: string;
      rejectionReason?: never;
    }
  | {
      kind: 'manager_action';
      eventId: string;
      operatorOpenId: string;
      messageId: string;
      action: 'submit_reject';
      executionRecordId?: never;
      rejectionReason: string;
    }
  | {
      kind: 'manager_batch_action';
      eventId: string;
      operatorOpenId: string;
      messageId: string;
      action:
        | 'approve_pending_comprehensive'
        | 'approve_pending_building_self'
        | 'cancel_item_reject';
      approvalBatchId: string;
      executionRecordId?: never;
      rejectionReason?: never;
    }
  | {
      kind: 'manager_batch_action';
      eventId: string;
      operatorOpenId: string;
      messageId: string;
      action: 'open_item_reject';
      approvalBatchId: string;
      executionRecordId: string;
      rejectionReason?: never;
    }
  | {
      kind: 'manager_batch_action';
      eventId: string;
      operatorOpenId: string;
      messageId: string;
      action: 'submit_item_reject';
      approvalBatchId?: never;
      executionRecordId?: never;
      rejectionReason: string;
    }
  | {
      kind: 'purchase_batch_fulfillment_action';
      eventId: string;
      operatorOpenId: string;
      messageId: string;
      action:
        | 'open_order'
        | 'return_purchase_list'
        | 'open_receipt'
        | 'return_receipt_list'
        | 'prepare_receipt_photo'
        | 'prepare_invoice';
      approvalBatchId: string;
      executionRecordId: string;
      updateToken?: string;
    }
  | {
      kind: 'purchase_batch_fulfillment_action';
      eventId: string;
      operatorOpenId: string;
      messageId: string;
      action: 'submit_order';
      approvalBatchId: string;
      executionRecordId: string;
      actualQuantity: number;
      actualAmount: number;
      note: string;
    }
  | {
      kind: 'purchase_batch_fulfillment_action';
      eventId: string;
      operatorOpenId: string;
      messageId: string;
      action: 'submit_receipt';
      approvalBatchId: string;
      executionRecordId: string;
      signerOpenId: string;
      receiptTime: number;
      note: string;
    };

export function parsePurchaseCardCallback(
  input: PurchaseCardCallbackInput,
  config: PurchaseCardCallbackConfig,
): PurchaseCardCallbackResult {
  assertConfig(config);
  const nowMilliseconds = resolveNow(input.now);
  const encryptKey = config.encryptKey;
  let payload: JsonObject;
  let unsignedEncryptedChallengeOnly = false;

  if (encryptKey) {
    const timestamp = optionalHeader(input.headers, 'x-lark-request-timestamp');
    const nonce = optionalHeader(input.headers, 'x-lark-request-nonce');
    const signature = optionalHeader(input.headers, 'x-lark-signature');
    const signatureHeaderCount = [timestamp, nonce, signature].filter(
      (value) => value !== undefined,
    ).length;
    if (signatureHeaderCount === 3) {
      assertFreshTimestamp(timestamp as string, nowMilliseconds);
      assertSignature({
        timestamp: timestamp as string,
        nonce: nonce as string,
        signature: signature as string,
        encryptKey,
        rawBody: input.rawBody,
      });
    } else if (signatureHeaderCount === 0) {
      unsignedEncryptedChallengeOnly = true;
    } else {
      throw new UnauthorizedException('回调认证请求头不完整');
    }
    payload = decryptPayload(parseRawBody(input.rawBody), encryptKey);
  } else {
    const timestamp = optionalHeader(input.headers, 'x-lark-request-timestamp');
    if (timestamp !== undefined) {
      assertFreshTimestamp(timestamp, nowMilliseconds);
    }
    payload = parseRawBody(input.rawBody);
  }

  assertVerificationToken(payload, config.verificationToken);
  if (payload.type === 'url_verification') {
    return parseChallenge(payload);
  }
  if (unsignedEncryptedChallengeOnly) {
    throw new UnauthorizedException('未签名加密回调仅允许网址验证');
  }
  return parseAction(payload, config);
}

export function parsePurchaseLongConnectionCardAction(
  payload: unknown,
  config: PurchaseCardCallbackConfig,
): Exclude<PurchaseCardCallbackResult, { kind: 'challenge' }> {
  assertConfig(config);
  const flattened = requireObject(payload, '飞书采购卡片长连接回调数据无效');
  if (
    flattened.schema !== '2.0' ||
    flattened.event_type !== 'card.action.trigger'
  ) {
    throw new BadRequestException('飞书采购卡片长连接回调事件类型无效');
  }
  if (Object.prototype.hasOwnProperty.call(flattened, 'eventId')) {
    throw new BadRequestException('飞书采购卡片长连接回调事件标识无效');
  }

  const upstreamEventId = Object.prototype.hasOwnProperty.call(
    flattened,
    'event_id',
  )
    ? protocolIdentifier(
        flattened.event_id,
        MAX_EVENT_ID_LENGTH,
        '飞书采购卡片长连接回调事件标识无效',
      )
    : undefined;
  const parsed = parseAuthorizedAction(flattened, '', config);
  const eventId = deriveLongConnectionEventId(upstreamEventId, parsed);
  return { ...parsed, eventId };
}

function parseRawBody(rawBody: string | Buffer): JsonObject {
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) {
    throw new BadRequestException('回调原始请求体无效');
  }
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    return requireObject(JSON.parse(text), '回调请求格式无效');
  } catch {
    throw new BadRequestException('回调请求格式无效');
  }
}

function parseChallenge(payload: JsonObject): PurchaseCardCallbackResult {
  const challenge = payload.challenge;
  if (
    typeof challenge !== 'string' ||
    challenge.length === 0 ||
    challenge.length > MAX_CHALLENGE_LENGTH
  ) {
    throw new BadRequestException('回调验证请求格式无效');
  }
  return { kind: 'challenge', challenge };
}

function parseAction(
  payload: JsonObject,
  config: PurchaseCardCallbackConfig,
): PurchaseCardCallbackResult {
  if (payload.schema !== '2.0') {
    throw new BadRequestException('回调协议版本无效');
  }
  const header = requireObject(payload.header, '回调事件头无效');
  if (header.event_type !== 'card.action.trigger') {
    throw new BadRequestException('回调事件类型无效');
  }
  const eventId = protocolIdentifier(
    header.event_id,
    MAX_EVENT_ID_LENGTH,
    '回调事件标识无效',
  );
  const event = requireObject(payload.event, '回调事件格式无效');
  return parseAuthorizedAction(event, eventId, config);
}

function parseAuthorizedAction(
  event: JsonObject,
  eventId: string,
  config: PurchaseCardCallbackConfig,
): Exclude<PurchaseCardCallbackResult, { kind: 'challenge' }> {
  const operator = requireObject(event.operator, '回调操作人无效');
  const operatorOpenId = protocolIdentifier(
    operator.open_id,
    MAX_OPEN_ID_LENGTH,
    '回调操作人无效',
  );
  const action = requireObject(event.action, '回调操作格式无效');
  const parsedAction = parseProtocolAction(action);

  if (parsedAction.kind === 'legacy') {
    if (!config.authorizeFromDeliverySnapshot) assertLegacyApprover(operatorOpenId, config.legacyApproverOpenIds);
    return {
      kind: 'legacy_action',
      eventId,
      operatorOpenId,
      action: parsedAction.action,
      executionRecordId: parsedAction.executionRecordId,
      ...(config.authorizeFromDeliverySnapshot ? { messageId: parseManagerMessageId(event) } : {}),
    };
  }

  const messageId = parseManagerMessageId(event);
  if (parsedAction.kind === 'fulfillment') {
    const updateToken = isFulfillmentNavigation(parsedAction.action.action)
      ? optionalCardUpdateToken(event.token)
      : undefined;
    return {
      kind: 'purchase_batch_fulfillment_action',
      eventId,
      operatorOpenId,
      messageId,
      ...parsedAction.action,
      ...(updateToken ? { updateToken } : {}),
    } as Exclude<PurchaseCardCallbackResult, { kind: 'challenge' }>;
  }
  if (!config.authorizeFromDeliverySnapshot) assertManagerApprover(operatorOpenId, config.managerApproverOpenIds || [config.managerApproverOpenId]);
  if (parsedAction.kind === 'manager_initial') {
    return {
      kind: 'manager_action',
      eventId,
      operatorOpenId,
      messageId,
      action: parsedAction.action,
      executionRecordId: parsedAction.executionRecordId,
    };
  }
  if (parsedAction.kind === 'manager_batch') {
    return {
      kind: 'manager_batch_action',
      eventId,
      operatorOpenId,
      messageId,
      action: parsedAction.action,
      approvalBatchId: parsedAction.approvalBatchId,
      ...(parsedAction.executionRecordId
        ? { executionRecordId: parsedAction.executionRecordId }
        : {}),
    } as Exclude<PurchaseCardCallbackResult, { kind: 'challenge' }>;
  }
  if (parsedAction.kind === 'manager_batch_reject') {
    return {
      kind: 'manager_batch_action',
      eventId,
      operatorOpenId,
      messageId,
      action: 'submit_item_reject',
      rejectionReason: parsedAction.rejectionReason,
    };
  }
  return {
    kind: 'manager_action',
    eventId,
    operatorOpenId,
    messageId,
    action: 'submit_reject',
    rejectionReason: parsedAction.rejectionReason,
  };
}

function deriveLongConnectionEventId(
  upstreamEventId: string | undefined,
  action: Exclude<PurchaseCardCallbackResult, { kind: 'challenge' }>,
): string {
  const identity =
    action.kind === 'legacy_action'
      ? [
          upstreamEventId ?? null,
          action.kind,
          action.operatorOpenId,
          action.action,
          action.executionRecordId,
        ]
      : action.kind === 'manager_batch_action'
        ? [
            upstreamEventId ?? null,
            action.kind,
            action.operatorOpenId,
            action.messageId,
            action.action,
            action.approvalBatchId ?? null,
            action.executionRecordId ?? null,
            action.rejectionReason ?? null,
          ]
        : action.kind === 'purchase_batch_fulfillment_action'
          ? [
              upstreamEventId ?? null,
              action.kind,
              action.operatorOpenId,
              action.messageId,
              action.action,
              action.approvalBatchId,
              action.executionRecordId,
              'actualQuantity' in action ? action.actualQuantity : null,
              'actualAmount' in action ? action.actualAmount : null,
              'signerOpenId' in action ? action.signerOpenId : null,
              'receiptTime' in action ? action.receiptTime : null,
              'note' in action ? action.note : null,
            ]
          : action.action === 'submit_reject'
            ? [
                upstreamEventId ?? null,
                action.kind,
                action.operatorOpenId,
                action.messageId,
                action.action,
                action.rejectionReason,
              ]
            : [
                upstreamEventId ?? null,
                action.kind,
                action.operatorOpenId,
                action.messageId,
                action.action,
                action.executionRecordId,
              ];
  return `ws_${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

type ParsedProtocolAction =
  | {
      kind: 'legacy';
      action: 'approve' | 'reject';
      executionRecordId: string;
    }
  | {
      kind: 'manager_initial';
      action: 'choose_comprehensive' | 'choose_building_self' | 'open_reject';
      executionRecordId: string;
    }
  | {
      kind: 'manager_reject';
      rejectionReason: string;
    }
  | {
      kind: 'manager_batch';
      action:
        | 'approve_pending_comprehensive'
        | 'approve_pending_building_self'
        | 'open_item_reject'
        | 'cancel_item_reject';
      approvalBatchId: string;
      executionRecordId?: string;
    }
  | {
      kind: 'manager_batch_reject';
      rejectionReason: string;
    }
  | {
      kind: 'fulfillment';
      action:
        | {
            action:
              | 'open_order'
              | 'return_purchase_list'
              | 'open_receipt'
              | 'return_receipt_list'
              | 'prepare_receipt_photo'
              | 'prepare_invoice';
            approvalBatchId: string;
            executionRecordId: string;
          }
        | {
            action: 'submit_order';
            approvalBatchId: string;
            executionRecordId: string;
            actualQuantity: number;
            actualAmount: number;
            note: string;
          }
        | {
            action: 'submit_receipt';
            approvalBatchId: string;
            executionRecordId: string;
            receiptTime: number;
            note: string;
          };
    };

function parseProtocolAction(action: JsonObject): ParsedProtocolAction {
  const hasFormValue = Object.prototype.hasOwnProperty.call(
    action,
    'form_value',
  );
  if (
    hasFormValue ||
    action.name === 'purchase_reject_submit' ||
    action.name === 'purchase_batch_item_reject_submit'
  ) {
    const orderSubmit = parsePurchaseBatchOrderFormAction(action);
    if (orderSubmit) return { kind: 'fulfillment', action: orderSubmit };
    const receiptSubmit = parsePurchaseBatchReceiptFormAction(action);
    if (receiptSubmit) return { kind: 'fulfillment', action: receiptSubmit };
    if (action.name === 'purchase_batch_item_reject_submit') {
      if (Object.prototype.hasOwnProperty.call(action, 'value')) {
        throw new BadRequestException('批次驳回提交动作名称无效');
      }
      return {
        kind: 'manager_batch_reject',
        rejectionReason: parseRejectionReason(action),
      };
    }
    if (
      action.name !== 'purchase_reject_submit' ||
      Object.prototype.hasOwnProperty.call(action, 'value')
    ) {
      throw new BadRequestException('驳回提交动作名称无效');
    }
    return {
      kind: 'manager_reject',
      rejectionReason: parseRejectionReason(action),
    };
  }

  const value = requireObject(action.value, '回调操作值无效');
  if (value.version === 1) {
    return {
      kind: 'legacy',
      ...parseLegacyActionValue(value),
    };
  }
  if (value.version === 2) {
    assertManagerButton(action);
    return {
      kind: 'manager_initial',
      ...parseManagerActionValue(value),
    };
  }
  if (value.version === 3) {
    assertManagerButton(action);
    return {
      kind: 'manager_batch',
      ...parseManagerBatchActionValue(value),
    };
  }
  if (value.version === 4) {
    assertManagerButton(action);
    return {
      kind: 'fulfillment',
      action: parsePurchaseBatchFulfillmentActionValue(value),
    };
  }
  throw new BadRequestException('回调操作值无效');
}

function parsePurchaseBatchFulfillmentActionValue(value: JsonObject): {
  action:
    | 'open_order'
    | 'return_purchase_list'
    | 'open_receipt'
    | 'return_receipt_list'
    | 'prepare_receipt_photo'
    | 'prepare_invoice';
  approvalBatchId: string;
  executionRecordId: string;
} {
  const expectedKeys = [
    'action',
    'approvalBatchId',
    'executionRecordId',
    'role',
    'version',
    'workflowType',
  ].sort();
  const action = value.action;
  const role = value.role;
  const validRoleAction =
    (role === 'purchaser' &&
      (action === 'open_order' || action === 'return_purchase_list')) ||
    (role === 'requester' &&
      (action === 'open_receipt' ||
        action === 'return_receipt_list' ||
        action === 'prepare_receipt_photo' ||
        action === 'prepare_invoice'));
  if (
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(expectedKeys) ||
    value.version !== 4 ||
    value.workflowType !== 'purchase_batch_fulfillment' ||
    !validRoleAction ||
    typeof value.approvalBatchId !== 'string' ||
    !BATCH_ID_PATTERN.test(value.approvalBatchId) ||
    typeof value.executionRecordId !== 'string' ||
    !RECORD_ID_PATTERN.test(value.executionRecordId)
  ) {
    throw new BadRequestException('采购履约卡片操作值无效');
  }
  return {
    action: action as
      | 'open_order'
      | 'return_purchase_list'
      | 'open_receipt'
      | 'return_receipt_list'
      | 'prepare_receipt_photo'
      | 'prepare_invoice',
    approvalBatchId: value.approvalBatchId,
    executionRecordId: value.executionRecordId,
  };
}

function parsePurchaseBatchOrderFormAction(action: JsonObject): {
  action: 'submit_order';
  approvalBatchId: string;
  executionRecordId: string;
  actualQuantity: number;
  actualAmount: number;
  note: string;
} | null {
  const submit = parsePurchaseBatchFulfillmentSubmitName(
    String(action.name || ''),
  );
  if (!submit || submit.action !== 'submit_order') return null;
  assertManagerButton(action);
  const formValue = requireObject(action.form_value, '采购下单表单无效');
  assertExactFormKeys(formValue, [
    'actual_amount',
    'actual_quantity',
    'order_note',
  ]);
  return {
    action: 'submit_order',
    approvalBatchId: submit.approvalBatchId,
    executionRecordId: submit.executionRecordId,
    actualQuantity: positiveNumber(
      formValue.actual_quantity,
      '实际采购数量无效',
    ),
    actualAmount: nonNegativeNumber(
      formValue.actual_amount,
      '实际付款金额无效',
    ),
    note: normalizedOptionalText(formValue.order_note, MAX_NOTE_CODE_POINTS),
  };
}

function parsePurchaseBatchReceiptFormAction(action: JsonObject): {
  action: 'submit_receipt';
  approvalBatchId: string;
  executionRecordId: string;
  signerOpenId: string;
  receiptTime: number;
  note: string;
} | null {
  const submit = parsePurchaseBatchFulfillmentSubmitName(
    String(action.name || ''),
  );
  if (!submit || submit.action !== 'submit_receipt') return null;
  assertManagerButton(action);
  const formValue = requireObject(action.form_value, '采购签收表单无效');
  const legacyFields = Object.prototype.hasOwnProperty.call(
    formValue,
    'signer_open_id',
  );
  const fieldName = (
    base: 'signer_open_id' | 'receipt_time' | 'receipt_note',
  ) =>
    legacyFields
      ? base
      : purchaseBatchReceiptFieldName(base, submit.executionRecordId);
  const signerField = fieldName('signer_open_id');
  const timeField = fieldName('receipt_time');
  const noteField = fieldName('receipt_note');
  assertExactFormKeys(formValue, [
    signerField,
    timeField,
    ...(Object.prototype.hasOwnProperty.call(formValue, noteField)
      ? [noteField]
      : []),
  ]);
  const signerOpenId = normalizedOptionalText(
    formValue[signerField],
    MAX_OPEN_ID_LENGTH,
  );
  if (!OPEN_ID_PATTERN.test(signerOpenId)) {
    throw new BadRequestException('签收人无效');
  }
  const receiptTimeText = normalizedOptionalText(formValue[timeField], 40);
  const receiptTime = Date.parse(receiptTimeText.replace(' ', 'T'));
  if (!Number.isFinite(receiptTime)) {
    throw new BadRequestException('签收时间无效');
  }
  return {
    action: 'submit_receipt',
    approvalBatchId: submit.approvalBatchId,
    executionRecordId: submit.executionRecordId,
    signerOpenId,
    receiptTime,
    note: normalizedOptionalText(formValue[noteField], MAX_NOTE_CODE_POINTS),
  };
}

function assertExactFormKeys(value: JsonObject, expected: string[]): void {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    throw new BadRequestException('采购履约表单包含未知字段');
  }
}

function positiveNumber(value: unknown, message: string): number {
  const number = Number(typeof value === 'string' ? value.trim() : value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new BadRequestException(message);
  }
  return number;
}

function nonNegativeNumber(value: unknown, message: string): number {
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (normalized === '') {
    throw new BadRequestException(message);
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) {
    throw new BadRequestException(message);
  }
  return number;
}

function normalizedOptionalText(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new BadRequestException('采购履约表单文本无效');
  }
  const text = value.trim().normalize('NFC');
  if (
    Array.from(text).length > maxLength ||
    NON_NEWLINE_CONTROL_PATTERN.test(text)
  ) {
    throw new BadRequestException('采购履约表单文本无效');
  }
  return text;
}

function parseLegacyActionValue(value: JsonObject): {
  action: 'approve' | 'reject';
  executionRecordId: string;
} {
  const keys = Object.keys(value).sort();
  const version = value.version;
  const action = value.action;
  const executionRecordId = value.executionRecordId;
  if (
    keys.length !== 3 ||
    keys[0] !== 'action' ||
    keys[1] !== 'executionRecordId' ||
    keys[2] !== 'version' ||
    version !== 1 ||
    (action !== 'approve' && action !== 'reject') ||
    typeof executionRecordId !== 'string' ||
    !RECORD_ID_PATTERN.test(executionRecordId)
  ) {
    throw new BadRequestException('回调操作值无效');
  }
  return { action, executionRecordId };
}

function parseManagerActionValue(value: JsonObject): {
  action: 'choose_comprehensive' | 'choose_building_self' | 'open_reject';
  executionRecordId: string;
} {
  const keys = Object.keys(value).sort();
  const version = value.version;
  const action = value.action;
  const executionRecordId = value.executionRecordId;
  if (
    keys.length !== 3 ||
    keys[0] !== 'action' ||
    keys[1] !== 'executionRecordId' ||
    keys[2] !== 'version' ||
    version !== 2 ||
    (action !== 'choose_comprehensive' &&
      action !== 'choose_building_self' &&
      action !== 'open_reject') ||
    typeof executionRecordId !== 'string' ||
    !RECORD_ID_PATTERN.test(executionRecordId)
  ) {
    throw new BadRequestException('回调操作值无效');
  }
  return { action, executionRecordId };
}

function parseManagerBatchActionValue(value: JsonObject): {
  action:
    | 'approve_pending_comprehensive'
    | 'approve_pending_building_self'
    | 'open_item_reject'
    | 'cancel_item_reject';
  approvalBatchId: string;
  executionRecordId?: string;
} {
  const action = value.action;
  const approvalBatchId = value.approvalBatchId;
  const executionRecordId = value.executionRecordId;
  const expectsRecordId = action === 'open_item_reject';
  const expectedKeys = expectsRecordId
    ? ['action', 'approvalBatchId', 'executionRecordId', 'version']
    : ['action', 'approvalBatchId', 'version'];
  if (
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(expectedKeys.sort()) ||
    value.version !== 3 ||
    (action !== 'approve_pending_comprehensive' &&
      action !== 'approve_pending_building_self' &&
      action !== 'open_item_reject' &&
      action !== 'cancel_item_reject') ||
    typeof approvalBatchId !== 'string' ||
    !BATCH_ID_PATTERN.test(approvalBatchId) ||
    (expectsRecordId &&
      (typeof executionRecordId !== 'string' ||
        !RECORD_ID_PATTERN.test(executionRecordId)))
  ) {
    throw new BadRequestException('采购批次审批回调操作值无效');
  }
  return {
    action,
    approvalBatchId,
    ...(expectsRecordId
      ? { executionRecordId: executionRecordId as string }
      : {}),
  };
}

function parseRejectionReason(action: JsonObject): string {
  assertManagerButton(action);
  const formValue = requireObject(action.form_value, '驳回原因无效');
  const keys = Object.keys(formValue);
  const rawReason = formValue.rejection_reason;
  if (
    keys.length !== 1 ||
    keys[0] !== 'rejection_reason' ||
    typeof rawReason !== 'string'
  ) {
    throw new BadRequestException('驳回原因无效');
  }
  const rejectionReason = rawReason.trim().normalize('NFC');
  const codePointLength = Array.from(rejectionReason).length;
  if (
    codePointLength === 0 ||
    codePointLength > MAX_REJECTION_REASON_CODE_POINTS ||
    NON_NEWLINE_CONTROL_PATTERN.test(rejectionReason)
  ) {
    throw new BadRequestException('驳回原因无效');
  }
  return rejectionReason;
}

function assertManagerButton(action: JsonObject): void {
  if (action.tag !== 'button') {
    throw new BadRequestException('回调操作格式无效');
  }
}

function parseManagerMessageId(event: JsonObject): string {
  const context = requireObject(event.context, '回调消息上下文无效');
  const messageId = protocolIdentifier(
    context.open_message_id,
    MAX_MESSAGE_ID_LENGTH,
    '回调消息标识无效',
  );
  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    throw new BadRequestException('回调消息标识无效');
  }
  return messageId;
}

function isFulfillmentNavigation(action: string): boolean {
  return (
    action === 'open_order' ||
    action === 'return_purchase_list' ||
    action === 'open_receipt' ||
    action === 'return_receipt_list' ||
    action === 'prepare_receipt_photo' ||
    action === 'prepare_invoice'
  );
}

function optionalCardUpdateToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CARD_UPDATE_TOKEN_PATTERN.test(value)) {
    throw new BadRequestException('卡片更新票据格式无效');
  }
  return value;
}

function assertLegacyApprover(
  operatorOpenId: string,
  legacyApproverOpenIds: string[],
): void {
  if (!constantTimeIncludes(operatorOpenId, legacyApproverOpenIds)) {
    throw new ForbiddenException('当前操作人无审批权限');
  }
}

function assertManagerApprover(
  operatorOpenId: string,
  managerApproverOpenIds: string[],
): void {
  if (
    !managerApproverOpenIds.some(openId => openId && constantTimeEqual(operatorOpenId, openId))
  ) {
    throw new ForbiddenException('当前操作人无审批权限');
  }
}

function assertVerificationToken(
  payload: JsonObject,
  expectedToken: string,
): void {
  const header = isObject(payload.header) ? payload.header : undefined;
  const candidates = [payload.token, header?.token].filter(
    (value): value is string => typeof value === 'string',
  );
  if (
    candidates.length === 0 ||
    candidates.some((token) => !constantTimeEqual(token, expectedToken))
  ) {
    throw new UnauthorizedException('回调认证失败');
  }
}

function assertSignature(input: {
  timestamp: string;
  nonce: string;
  signature: string;
  encryptKey: string;
  rawBody: string | Buffer;
}): void {
  if (typeof input.rawBody !== 'string' && !Buffer.isBuffer(input.rawBody)) {
    throw new BadRequestException('回调原始请求体无效');
  }
  const hash = createHash('sha256');
  hash.update(input.timestamp);
  hash.update(input.nonce);
  hash.update(input.encryptKey);
  hash.update(input.rawBody);
  const expectedSignature = hash.digest('hex');
  if (!constantTimeEqual(input.signature.toLowerCase(), expectedSignature)) {
    throw new UnauthorizedException('回调签名验证失败');
  }
}

function decryptPayload(body: unknown, encryptKey: string): JsonObject {
  const envelope = requireObject(body, '加密回调格式无效');
  const encrypted = envelope.encrypt;
  if (typeof encrypted !== 'string') {
    throw new BadRequestException('加密回调格式无效');
  }
  if (
    encrypted.length === 0 ||
    encrypted.length % 4 !== 0 ||
    !BASE64_PATTERN.test(encrypted)
  ) {
    throw new BadRequestException('加密回调内容无效');
  }

  try {
    const bytes = Buffer.from(encrypted, 'base64');
    if (bytes.length <= 16 || (bytes.length - 16) % 16 !== 0) {
      throw new Error('invalid encrypted data length');
    }
    const iv = bytes.subarray(0, 16);
    const ciphertext = bytes.subarray(16);
    const key = createHash('sha256').update(encryptKey).digest();
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    return requireObject(JSON.parse(plaintext), '加密回调内容无效');
  } catch {
    throw new BadRequestException('加密回调内容无效');
  }
}

function assertFreshTimestamp(
  timestamp: string,
  nowMilliseconds: number,
): void {
  if (!/^\d{1,13}$/.test(timestamp)) {
    throw new UnauthorizedException('回调时间戳无效');
  }
  const seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(Math.floor(nowMilliseconds / 1000) - seconds) >
      MAX_CLOCK_SKEW_SECONDS
  ) {
    throw new UnauthorizedException('回调请求已过期');
  }
}

function resolveNow(now: Date | number): number {
  const value = now instanceof Date ? now.getTime() : now;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException('回调解析时间无效');
  }
  return value;
}

function protocolIdentifier(
  value: unknown,
  maxLength: number,
  message: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new BadRequestException(message);
  }
  return value;
}

function optionalHeader(headers: Headers, name: string): string | undefined {
  const entries = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (entries.length === 0) return undefined;
  if (entries.length !== 1) {
    throw new UnauthorizedException('回调请求头无效');
  }
  const value = entries[0]?.[1];
  if (Array.isArray(value)) {
    if (value.length !== 1 || typeof value[0] !== 'string' || !value[0]) {
      throw new UnauthorizedException('回调请求头无效');
    }
    return value[0];
  }
  if (typeof value !== 'string' || !value) {
    throw new UnauthorizedException('回调请求头无效');
  }
  return value;
}

function requireObject(value: unknown, message: string): JsonObject {
  if (!isObject(value)) throw new BadRequestException(message);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function constantTimeIncludes(value: string, allowedValues: string[]): boolean {
  let matched = 0;
  for (const allowedValue of allowedValues) {
    matched |= constantTimeEqual(value, allowedValue) ? 1 : 0;
  }
  return matched === 1;
}

function assertConfig(config: PurchaseCardCallbackConfig): void {
  if (
    !config ||
    typeof config.verificationToken !== 'string' ||
    config.verificationToken.length === 0 ||
    typeof config.encryptKey !== 'string' ||
    (config.authorizeFromDeliverySnapshot !== undefined && typeof config.authorizeFromDeliverySnapshot !== 'boolean') ||
    Object.prototype.hasOwnProperty.call(config, 'approverOpenIds') ||
    !Array.isArray(config.legacyApproverOpenIds) ||
    config.legacyApproverOpenIds.some(
      (openId) =>
        typeof openId !== 'string' ||
        openId.length === 0 ||
        openId.length > MAX_OPEN_ID_LENGTH ||
        !OPEN_ID_PATTERN.test(openId),
    ) ||
    typeof config.managerApproverOpenId !== 'string' ||
    config.managerApproverOpenId.length > MAX_OPEN_ID_LENGTH ||
    (config.managerApproverOpenIds !== undefined && (!Array.isArray(config.managerApproverOpenIds) || config.managerApproverOpenIds.length > 100 ||
      config.managerApproverOpenIds.some(openId => typeof openId !== 'string' || !OPEN_ID_PATTERN.test(openId)))) ||
    (config.managerApproverOpenId.length > 0 &&
      !OPEN_ID_PATTERN.test(config.managerApproverOpenId))
  ) {
    throw new BadRequestException('回调安全配置无效');
  }
}
