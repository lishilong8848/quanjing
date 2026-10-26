import { createHash } from 'node:crypto';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import type {
  InventoryManagerNotificationHandover,
  InventoryOutboundApprovalApprover,
  InventoryOutboundApprovalDecision,
  InventoryOutboundApprovalRecoveredResultDelivery,
  InventoryOutboundApprovalSnapshot,
} from './inventory-outbound-approval.types';
import { normalizeInventoryOutboundRejectionReason } from './inventory-outbound-approval.validation';
import { normalizeInventoryManagerNotificationHandovers } from './inventory-manager-notification-route';

export type { InventoryOutboundApprovalRecoveredResultDelivery } from './inventory-outbound-approval.types';

const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,252}$/u;
const RFC_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PERSISTED_JSON_MAX_BYTES = 30 * 1_024;

const SNAPSHOT_KEYS_V1 = [
  'recordId',
  'outboundNumber',
  'version',
  'policyVersion',
  'applicantOpenId',
  'applicantName',
  'itemName',
  'sku',
  'specification',
  'brand',
  'quantity',
  'unit',
  'availableStock',
  'building',
  'location',
  'reason',
  'appliedAt',
  'approvers',
] as const;
const SNAPSHOT_KEYS_V2 = [
  ...SNAPSHOT_KEYS_V1,
  'managerRecipients',
] as const;

const WORKFLOW_STATUSES = [
  '待路由',
  '待审批',
  '已通过',
  '已驳回',
  '同步异常',
] as const;

type InventoryOutboundApprovalRecoveryWorkflowStatus =
  (typeof WORKFLOW_STATUSES)[number];

export interface InventoryOutboundApprovalRecoveryRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

export interface InventoryOutboundApprovalRecoveredDelivery {
  recipientOpenId: string;
  recipientName: string;
  deliveryUuid: string;
  messageId: string;
}

export type InventoryOutboundApprovalRecoveryResult =
  | {
      kind: 'not_registered';
      recordId: string;
      workflowStatus: '待路由';
    }
  | {
      kind: 'pending';
      snapshot: InventoryOutboundApprovalSnapshot;
      deliveries: InventoryOutboundApprovalRecoveredDelivery[];
    }
  | {
      kind: 'decided';
      snapshot: InventoryOutboundApprovalSnapshot;
      deliveries: InventoryOutboundApprovalRecoveredDelivery[];
      resultDeliveries: InventoryOutboundApprovalRecoveredResultDelivery[];
      managerNotificationHandovers?: InventoryManagerNotificationHandover[];
      decision: InventoryOutboundApprovalDecision;
      requiresBusinessFinalization?: boolean;
    };

export class InventoryOutboundApprovalRecoveryParseError extends Error {
  constructor(message: string) {
    super(`出库审批恢复记录无效：${message}`);
    this.name = 'InventoryOutboundApprovalRecoveryParseError';
  }
}

export interface InventoryOutboundApprovalRecoveryParseOptions {
  allowFinalized?: boolean;
}

export function parseInventoryOutboundApprovalRecoveryRecord(
  recordValue: InventoryOutboundApprovalRecoveryRecord,
  options: InventoryOutboundApprovalRecoveryParseOptions = {},
): InventoryOutboundApprovalRecoveryResult {
  if (!isPlainObject(recordValue)) fail('记录结构无效');
  const recordId = requireRecordId(recordValue.recordId);
  if (!isPlainObject(recordValue.fields)) fail('字段结构无效');
  const fields = recordValue.fields;
  const workflowStatus = requireWorkflowStatus(
    semanticText(fields['出库工作流状态'], '出库工作流状态'),
  );
  const finalizationStatus = requireFinalizationStatus(
    semanticText(fields['出库审批收尾状态'], '出库审批收尾状态'),
  );
  const snapshotText = semanticText(fields['出库审批快照'], '出库审批快照');

  if (workflowStatus === '待路由' && !snapshotText) {
    assertNoUnregisteredEvidence(fields);
    return { kind: 'not_registered', recordId, workflowStatus };
  }
  if (!snapshotText) fail(`${workflowStatus}记录缺少出库审批快照`);

  const snapshot = parseSnapshotEnvelope(snapshotText, recordId);
  const persistedPolicyVersion = requireText(
    semanticText(fields['出库审批策略版本'], '出库审批策略版本'),
    '出库审批策略版本',
    128,
  );
  if (persistedPolicyVersion !== snapshot.policyVersion) {
    fail('出库审批策略版本与快照不一致');
  }
  const deliveries = parseDeliveryLedger(
    semanticText(fields['出库审批投递台账'], '出库审批投递台账'),
    snapshot,
  );
  const programStatus = requireText(
    semanticText(fields['程序出库状态'], '程序出库状态'),
    '程序出库状态',
    64,
  );

  if (workflowStatus === '待路由' || workflowStatus === '待审批') {
    assertPendingState(fields, snapshot, programStatus);
    return { kind: 'pending', snapshot, deliveries };
  }

  if (workflowStatus === '同步异常' && programStatus === '待审批') {
    assertPendingState(fields, snapshot, programStatus);
    return { kind: 'pending', snapshot, deliveries };
  }

  const action = decisionAction(workflowStatus, programStatus);
  if (deliveries.length === 0) fail('已形成决议但缺少审批卡投递台账');
  if (finalizationStatus === '已完成' && options.allowFinalized !== true) {
    fail('出库审批收尾已完成，不属于可恢复记录');
  }
  const decision = parseDecision(fields, snapshot, deliveries, action);
  const resultLedger = parseResultDeliveryLedger(
    semanticText(fields['出库审批结果投递台账'], '出库审批结果投递台账'),
    snapshot,
    decision,
  );
  return {
    kind: 'decided',
    snapshot,
    deliveries,
    resultDeliveries: resultLedger.deliveries,
    ...(resultLedger.managerNotificationHandovers.length ? {
      managerNotificationHandovers: resultLedger.managerNotificationHandovers,
    } : {}),
    decision,
    requiresBusinessFinalization:
      action === 'approve' && programStatus === '待库房确认',
  };
}

function parseSnapshotEnvelope(
  serialized: string,
  recordId: string,
): InventoryOutboundApprovalSnapshot {
  const envelope = parsePersistedJson(serialized, '出库审批快照');
  assertExactKeys(envelope, ['schemaVersion', 'snapshot'], '出库审批快照');
  if (envelope.schemaVersion !== 1 && envelope.schemaVersion !== 2) {
    fail('出库审批快照 schemaVersion 无效');
  }
  if (!isPlainObject(envelope.snapshot)) fail('出库审批快照内容无效');
  assertExactKeys(
    envelope.snapshot,
    envelope.schemaVersion === 2 ? SNAPSHOT_KEYS_V2 : SNAPSHOT_KEYS_V1,
    '出库审批快照内容',
  );
  const snapshot = normalizeSnapshot(envelope.snapshot);
  if (snapshot.recordId !== recordId)
    fail('出库审批快照 recordId 与记录不一致');
  return snapshot;
}

function normalizeSnapshot(
  value: Record<string, unknown>,
): InventoryOutboundApprovalSnapshot {
  const recordId = requireRecordId(value.recordId);
  const outboundNumber = requireText(value.outboundNumber, '出库编号', 128);
  const version = requirePositiveVersion(value.version, '审批版本');
  const policyVersion = requireText(value.policyVersion, '审批策略版本', 128);
  const applicantOpenId = requireOpenId(
    value.applicantOpenId,
    '申请人 Open ID',
  );
  const applicantName = optionalText(value.applicantName, '申请人姓名', 128);
  const itemName = requireText(value.itemName, '物品名称', 256);
  const sku = requireText(value.sku, '物品类别号', 128);
  const specification = optionalText(value.specification, '规格型号', 512);
  const brand = optionalText(value.brand, '品牌', 256);
  const quantity = requireFiniteNumber(value.quantity, '出库数量', 0);
  const unit = requireText(value.unit, '计数单位', 64);
  const availableStock = requireFiniteNumber(
    value.availableStock,
    '可用库存',
    -1,
  );
  const building = requireText(value.building, '楼栋', 32);
  if (!WAREHOUSE_BUILDINGS.includes(building as never)) fail('楼栋无效');
  const location = requireText(value.location, '存放位置', 512);
  const reason = requireText(value.reason, '出库原因', 2_000);
  const appliedAt = requireText(value.appliedAt, '申请时间', 128);
  if (!Number.isFinite(Date.parse(appliedAt))) fail('申请时间无效');
  if (!Array.isArray(value.approvers) || value.approvers.length === 0) {
    fail('审批人快照不能为空');
  }
  const approvers = normalizeApprovers(value.approvers);
  const managerRecipients =
    value.managerRecipients === undefined
      ? undefined
      : normalizeManagerRecipients(value.managerRecipients);
  return {
    recordId,
    outboundNumber,
    version,
    policyVersion,
    applicantOpenId,
    applicantName,
    itemName,
    sku,
    specification,
    brand,
    quantity,
    unit,
    availableStock,
    building: building as InventoryOutboundApprovalSnapshot['building'],
    location,
    reason,
    appliedAt,
    approvers,
    ...(managerRecipients ? { managerRecipients } : {}),
  };
}

function normalizeApprovers(
  value: unknown[],
): InventoryOutboundApprovalApprover[] {
  const result = new Map<string, InventoryOutboundApprovalApprover>();
  for (const candidate of value) {
    if (!isPlainObject(candidate)) fail('审批人快照结构无效');
    assertExactKeys(candidate, ['openId', 'name'], '审批人快照');
    const openId = requireOpenId(candidate.openId, '审批人 Open ID');
    const name = optionalText(candidate.name, '审批人姓名', 128);
    if (result.has(openId)) fail('审批人 Open ID 重复');
    result.set(openId, { openId, name });
  }
  return [...result.values()].sort((left, right) =>
    left.openId.localeCompare(right.openId),
  );
}

function normalizeManagerRecipients(
  value: unknown,
): InventoryOutboundApprovalApprover[] {
  if (!Array.isArray(value)) fail('库房管理人知会快照无效');
  const result = new Map<string, InventoryOutboundApprovalApprover>();
  for (const candidate of value) {
    if (!isPlainObject(candidate)) fail('库房管理人知会快照结构无效');
    assertExactKeys(candidate, ['openId', 'name'], '库房管理人知会快照');
    const openId = requireOpenId(candidate.openId, '库房管理人 Open ID');
    const name = optionalText(candidate.name, '库房管理人姓名', 128);
    if (result.has(openId)) fail('库房管理人 Open ID 重复');
    result.set(openId, { openId, name });
  }
  return [...result.values()].sort((left, right) =>
    left.openId.localeCompare(right.openId),
  );
}

function parseDeliveryLedger(
  serialized: string,
  snapshot: InventoryOutboundApprovalSnapshot,
): InventoryOutboundApprovalRecoveredDelivery[] {
  if (!serialized) return [];
  const ledger = parsePersistedJson(serialized, '出库审批投递台账');
  assertExactKeys(
    ledger,
    ['schemaVersion', 'recordId', 'version', 'deliveries'],
    '出库审批投递台账',
  );
  if (ledger.schemaVersion !== 1) fail('出库审批投递台账 schemaVersion 无效');
  if (requireRecordId(ledger.recordId) !== snapshot.recordId) {
    fail('出库审批投递台账 recordId 与快照不一致');
  }
  if (
    requirePositiveVersion(ledger.version, '投递台账审批版本') !==
    snapshot.version
  ) {
    fail('出库审批投递台账版本与快照不一致');
  }
  if (!Array.isArray(ledger.deliveries)) fail('出库审批投递台账明细无效');

  const approvers = new Map(
    snapshot.approvers.map((approver) => [approver.openId, approver.name]),
  );
  const recipients = new Set<string>();
  const deliveryUuids = new Set<string>();
  const messageIds = new Set<string>();
  const deliveries = ledger.deliveries.map((candidate) => {
    if (!isPlainObject(candidate)) fail('出库审批投递台账明细结构无效');
    assertExactKeys(
      candidate,
      ['recipientOpenId', 'recipientName', 'deliveryUuid', 'messageId'],
      '出库审批投递台账明细',
    );
    const recipientOpenId = requireOpenId(
      candidate.recipientOpenId,
      '审批卡接收人 Open ID',
    );
    const recipientName = requireText(
      candidate.recipientName,
      '审批卡接收人姓名',
      128,
    );
    const deliveryUuid = requireRfcUuid(candidate.deliveryUuid);
    const messageId = requireMessageId(candidate.messageId);
    if (approvers.get(recipientOpenId) !== recipientName) {
      fail('审批卡接收人与审批人快照不一致');
    }
    const expectedUuid = stableUuid(
      `inventory-outbound-approval-card:${snapshot.recordId}:${snapshot.version}:${recipientOpenId}`,
    );
    if (deliveryUuid !== expectedUuid) fail('审批卡投递 UUID 与接收人不一致');
    if (recipients.has(recipientOpenId)) fail('审批卡接收人重复');
    if (deliveryUuids.has(deliveryUuid)) fail('审批卡投递 UUID 重复');
    if (messageIds.has(messageId)) fail('审批卡消息编号重复');
    recipients.add(recipientOpenId);
    deliveryUuids.add(deliveryUuid);
    messageIds.add(messageId);
    return { recipientOpenId, recipientName, deliveryUuid, messageId };
  });
  return deliveries.sort((left, right) =>
    left.recipientOpenId.localeCompare(right.recipientOpenId),
  );
}

function parseResultDeliveryLedger(
  serialized: string,
  snapshot: InventoryOutboundApprovalSnapshot,
  decision: InventoryOutboundApprovalDecision,
): { deliveries: InventoryOutboundApprovalRecoveredResultDelivery[]; managerNotificationHandovers: InventoryManagerNotificationHandover[] } {
  if (!serialized) return { deliveries: [], managerNotificationHandovers: [] };
  const ledger = parsePersistedJson(serialized, '出库审批结果投递台账');
  assertExactKeys(
    ledger,
    [
      'schemaVersion',
      'recordId',
      'version',
      'decisionEventId',
      'decisionAction',
      'deliveries',
      ...(ledger.schemaVersion === 2 ? ['managerNotificationHandovers'] : []),
    ],
    '出库审批结果投递台账',
  );
  if (ledger.schemaVersion !== 1 && ledger.schemaVersion !== 2) {
    fail('出库审批结果投递台账 schemaVersion 无效');
  }
  if (requireRecordId(ledger.recordId) !== snapshot.recordId) {
    fail('出库审批结果投递台账 recordId 与快照不一致');
  }
  if (
    requirePositiveVersion(ledger.version, '结果投递台账审批版本') !==
    snapshot.version
  ) {
    fail('出库审批结果投递台账版本与快照不一致');
  }
  if (
    requireText(ledger.decisionEventId, '结果投递台账决议标识', 256) !==
    decision.eventId
  ) {
    fail('出库审批结果投递台账与决议标识不一致');
  }
  if (ledger.decisionAction !== decision.action) {
    fail('出库审批结果投递台账与决议动作不一致');
  }
  if (!Array.isArray(ledger.deliveries) || ledger.deliveries.length === 0) {
    fail('出库审批结果投递台账明细无效');
  }

  const allowedRecipients = new Map<string, string>();
  const registerRecipient = (openId: string, name: string) => {
    if (!allowedRecipients.has(openId)) {
      allowedRecipients.set(openId, name);
    }
  };
  registerRecipient(snapshot.applicantOpenId, snapshot.applicantName);
  snapshot.approvers.forEach(({ openId, name }) =>
    registerRecipient(openId, name),
  );
  (snapshot.managerRecipients || []).forEach(({ openId, name }) =>
    registerRecipient(openId, name),
  );
  let managerNotificationHandovers: InventoryManagerNotificationHandover[];
  try {
    managerNotificationHandovers = normalizeInventoryManagerNotificationHandovers(
      ledger.schemaVersion === 2 ? ledger.managerNotificationHandovers : undefined, snapshot,
    );
  } catch {
    return fail('出库审批岗位知会交接记录无效');
  }
  managerNotificationHandovers.forEach(({ target }) => registerRecipient(target.openId, target.name));

  const recipients = new Set<string>();
  const deliveryUuids = new Set<string>();
  const messageIds = new Set<string>();
  const deliveries = ledger.deliveries.map((candidate) => {
    if (!isPlainObject(candidate)) fail('出库审批结果投递台账明细结构无效');
    assertExactKeys(
      candidate,
      ['recipientOpenId', 'recipientName', 'deliveryUuid', 'messageId'],
      '出库审批结果投递台账明细',
    );
    const recipientOpenId = requireOpenId(
      candidate.recipientOpenId,
      '结果卡接收人 Open ID',
    );
    const recipientName = requireText(
      candidate.recipientName,
      '结果卡接收人姓名',
      128,
    );
    if (allowedRecipients.get(recipientOpenId) !== recipientName) {
      fail('结果卡接收人与申请人或审批人快照、管理人知会快照不一致');
    }
    const deliveryUuid = requireRfcUuid(candidate.deliveryUuid);
    const expectedUuid = stableUuid(
      `inventory-outbound-approval-result:${snapshot.recordId}:${snapshot.version}:${decision.action}:${recipientOpenId}`,
    );
    if (deliveryUuid !== expectedUuid) {
      fail('结果卡投递 UUID 与决议或接收人不一致');
    }
    const messageId = requireMessageId(candidate.messageId);
    if (recipients.has(recipientOpenId)) fail('结果卡接收人重复');
    if (deliveryUuids.has(deliveryUuid)) fail('结果卡投递 UUID 重复');
    if (messageIds.has(messageId)) fail('结果卡消息编号重复');
    recipients.add(recipientOpenId);
    deliveryUuids.add(deliveryUuid);
    messageIds.add(messageId);
    return { recipientOpenId, recipientName, deliveryUuid, messageId };
  });
  return {
    deliveries: deliveries.sort((left, right) => left.recipientOpenId.localeCompare(right.recipientOpenId)),
    managerNotificationHandovers,
  };
}

function assertPendingState(
  fields: Record<string, unknown>,
  snapshot: InventoryOutboundApprovalSnapshot,
  programStatus: string,
): void {
  if (programStatus !== '待审批') fail('待审批工作流与程序出库状态冲突');
  const currentApprovers = extractUserOpenIds(
    fields['出库当前审批人'],
    '出库当前审批人',
  );
  if (
    !sameStringSet(
      currentApprovers,
      snapshot.approvers.map(({ openId }) => openId),
    )
  ) {
    fail('出库当前审批人与审批人快照不一致');
  }
  if (hasDecisionEvidence(fields)) fail('待审批记录包含决议证据');
}

function decisionAction(
  workflowStatus: InventoryOutboundApprovalRecoveryWorkflowStatus,
  programStatus: string,
): 'approve' | 'reject' {
  if (workflowStatus === '已通过') {
    if (programStatus !== '待库房确认' && programStatus !== '已出库') {
      fail('已通过工作流与程序出库状态冲突');
    }
    return 'approve';
  }
  if (workflowStatus === '已驳回') {
    if (programStatus !== '已驳回') fail('已驳回工作流与程序出库状态冲突');
    return 'reject';
  }
  if (workflowStatus === '同步异常') {
    if (programStatus === '待库房确认' || programStatus === '已出库') {
      return 'approve';
    }
    if (programStatus === '已驳回') return 'reject';
    fail('同步异常记录无法从程序出库状态判定决议');
  }
  fail('工作流状态不包含可恢复决议');
}

function parseDecision(
  fields: Record<string, unknown>,
  snapshot: InventoryOutboundApprovalSnapshot,
  deliveries: InventoryOutboundApprovalRecoveredDelivery[],
  action: 'approve' | 'reject',
): InventoryOutboundApprovalDecision {
  const actorOpenIds = extractUserOpenIds(
    fields['出库实际审批人'],
    '出库实际审批人',
  );
  if (actorOpenIds.length !== 1) fail('出库实际审批人必须且只能有一人');
  const actorOpenId = actorOpenIds[0];
  const approver = snapshot.approvers.find(
    (candidate) => candidate.openId === actorOpenId,
  );
  if (!approver) fail('出库实际审批人不在审批人快照中');
  const delivery = deliveries.find(
    (candidate) => candidate.recipientOpenId === actorOpenId,
  );
  if (!delivery || delivery.recipientName !== approver.name) {
    fail('出库实际审批人缺少对应审批卡投递记录');
  }
  const currentApprovers = extractUserOpenIds(
    fields['出库当前审批人'],
    '出库当前审批人',
  );
  if (currentApprovers.length > 0) fail('已形成决议但仍保留当前审批人');
  const decidedAt = requireDateTime(fields['出库审批时间'], '出库审批时间');
  const eventId = requireText(
    semanticText(fields['出库审批动作标识'], '出库审批动作标识'),
    '出库审批动作标识',
    256,
  );
  const rawReason = semanticText(fields['出库驳回原因'], '出库驳回原因');
  const reason = normalizeInventoryOutboundRejectionReason(rawReason);
  if (action === 'approve' && rawReason) fail('同意决议不能包含驳回原因');
  if (action === 'reject' && !reason) fail('驳回决议缺少有效驳回原因');
  return {
    action,
    actorOpenId,
    actorName: approver.name,
    messageId: delivery.messageId,
    eventId,
    decidedAt,
    reason: action === 'reject' ? reason! : '',
  };
}

function assertNoUnregisteredEvidence(fields: Record<string, unknown>): void {
  if (
    semanticText(fields['出库审批投递台账'], '出库审批投递台账') ||
    hasDecisionEvidence(fields)
  ) {
    fail('待路由未注册记录包含审批恢复证据');
  }
}

function hasDecisionEvidence(fields: Record<string, unknown>): boolean {
  return Boolean(
    extractUserOpenIds(fields['出库实际审批人'], '出库实际审批人').length ||
    semanticText(fields['出库审批时间'], '出库审批时间') ||
    semanticText(fields['出库审批动作标识'], '出库审批动作标识') ||
    semanticText(fields['出库驳回原因'], '出库驳回原因') ||
    semanticText(fields['出库审批收尾状态'], '出库审批收尾状态') ||
    semanticText(fields['出库审批结果投递台账'], '出库审批结果投递台账'),
  );
}

function requireFinalizationStatus(value: string): '' | '待收尾' | '已完成' {
  if (value !== '' && value !== '待收尾' && value !== '已完成') {
    fail('出库审批收尾状态不受支持');
  }
  return value;
}

function requireWorkflowStatus(
  value: string,
): InventoryOutboundApprovalRecoveryWorkflowStatus {
  if (!WORKFLOW_STATUSES.includes(value as never)) {
    fail('出库工作流状态不受支持');
  }
  return value as InventoryOutboundApprovalRecoveryWorkflowStatus;
}

function parsePersistedJson(
  serialized: string,
  label: string,
): Record<string, unknown> {
  if (Buffer.byteLength(serialized, 'utf8') > PERSISTED_JSON_MAX_BYTES) {
    fail(`${label}超过 30 KB`);
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    fail(`${label}不是有效 JSON`);
  }
  if (!isPlainObject(value)) fail(`${label}JSON 结构无效`);
  return value;
}

function semanticText(value: unknown, label: string): string {
  return semanticTextValue(value, label, new Set<object>());
}

function semanticTextValue(
  value: unknown,
  label: string,
  seen: Set<object>,
): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value !== 'object') fail(`${label} wrapper 无效`);
  if (seen.has(value)) fail(`${label} wrapper 存在循环引用`);
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value
      .map((item) => semanticTextValue(item, label, seen))
      .join('')
      .trim();
    seen.delete(value);
    return result;
  }
  const object = value as Record<string, unknown>;
  const candidates = [
    'select',
    'text',
    'value',
    'name',
    'label',
    'title',
    'timestamp',
    'date',
  ]
    .filter((key) => Object.prototype.hasOwnProperty.call(object, key))
    .map((key) => semanticTextValue(object[key], label, seen))
    .filter(Boolean);
  seen.delete(value);
  const distinct = [...new Set(candidates)];
  if (distinct.length > 1) fail(`${label} wrapper 语义冲突`);
  return distinct[0] || '';
}

function extractUserOpenIds(value: unknown, label: string): string[] {
  const result = new Set<string>();
  const seen = new Set<object>();
  const visit = (candidate: unknown, fromArray: boolean): void => {
    if (candidate === undefined || candidate === null || candidate === '')
      return;
    if (typeof candidate === 'string') {
      if (fromArray && OPEN_ID_PATTERN.test(candidate)) result.add(candidate);
      return;
    }
    if (typeof candidate !== 'object') fail(`${label}人员 wrapper 无效`);
    if (seen.has(candidate)) fail(`${label}人员 wrapper 存在循环引用`);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, true));
      return;
    }
    const object = candidate as Record<string, unknown>;
    const identifierKeys = [
      'id',
      'open_id',
      'openId',
      'user_id',
      'userId',
    ].filter((key) => Object.prototype.hasOwnProperty.call(object, key));
    const identifiers = identifierKeys.map((key) => {
      const identifier = clean(object[key]);
      if (!OPEN_ID_PATTERN.test(identifier)) fail(`${label}包含无效 Open ID`);
      return identifier;
    });
    if (new Set(identifiers).size > 1) fail(`${label}人员标识冲突`);
    identifiers.forEach((identifier) => result.add(identifier));
    Object.entries(object).forEach(([key, nested]) => {
      if (
        !identifierKeys.includes(key) &&
        nested &&
        typeof nested === 'object'
      ) {
        visit(nested, false);
      }
    });
  };
  visit(value, false);
  return [...result].sort();
}

function requireDateTime(value: unknown, label: string): string {
  const semantic = semanticText(value, label);
  if (!semantic) fail(`${label}缺失`);
  let milliseconds: number;
  if (/^-?\d+(?:\.\d+)?$/u.test(semantic)) {
    const numeric = Number(semantic);
    milliseconds =
      Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric;
  } else {
    milliseconds = Date.parse(semantic);
  }
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) fail(`${label}无效`);
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    fail(`${label}无效`);
  }
}

function requireRecordId(value: unknown): string {
  const normalized = clean(value);
  if (!RECORD_ID_PATTERN.test(normalized)) fail('recordId 无效');
  return normalized;
}

function requireOpenId(value: unknown, label: string): string {
  const normalized = clean(value);
  if (!OPEN_ID_PATTERN.test(normalized)) fail(`${label}无效`);
  return normalized;
}

function requireMessageId(value: unknown): string {
  const normalized = clean(value);
  if (!MESSAGE_ID_PATTERN.test(normalized)) fail('审批卡消息编号无效');
  return normalized;
}

function requireRfcUuid(value: unknown): string {
  const normalized = clean(value);
  if (!RFC_UUID_PATTERN.test(normalized)) fail('审批卡投递 UUID 无效');
  return normalized.toLowerCase();
}

function requireText(value: unknown, label: string, maxLength: number): string {
  const normalized = clean(value);
  if (
    !normalized ||
    normalized.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    fail(`${label}无效`);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail(`${label}无效`);
  const normalized = value.trim();
  if (
    normalized.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    fail(`${label}无效`);
  }
  return normalized;
}

function requirePositiveVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail(`${label}无效`);
  return Number(value);
}

function requireFiniteNumber(
  value: unknown,
  label: string,
  exclusiveMinimum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= exclusiveMinimum
  ) {
    fail(`${label}无效`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label}字段集合与 schemaVersion 不一致`);
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  const actual = [...new Set(left)].sort();
  const expected = [...new Set(right)].sort();
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): never {
  throw new InventoryOutboundApprovalRecoveryParseError(message);
}
