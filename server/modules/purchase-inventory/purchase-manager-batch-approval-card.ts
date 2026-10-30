import { BadRequestException } from '@nestjs/common';
import { normalizePurchaseComparisonBatchEvidence, normalizePurchaseComparisonCardEvidence, withPurchaseComparisonCardEvidence, type PurchaseComparisonCardEvidence } from './purchase-comparison-card-evidence';
import { isBuildingSelfPurchaseAllowed } from './purchase-procurement-method-policy';

const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/u;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,128}$/u;
const MAX_BATCH_ITEMS = 20;
const BUSINESS_TEXT_LIMIT = 200;
const REJECTION_REASON_LIMIT = 500;
const CONTEXT_MAX_BYTES = 48_000;
const PURCHASE_LINK_LIMIT = 3;
const PURCHASE_LINK_MAX_LENGTH = 600;
const LARK_MD_HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&#38;',
  '*': '&#42;',
  '~': '&#126;',
  '>': '&#62;',
  '<': '&#60;',
  '[': '&#91;',
  ']': '&#93;',
  '(': '&#40;',
  ')': '&#41;',
  '#': '&#35;',
  ':': '&#58;',
  _: '&#95;',
  '\\': '&#92;',
  '`': '&#96;',
  '{': '&#123;',
  '}': '&#125;',
  '!': '&#33;',
  '|': '&#124;',
  '+': '&#43;',
  '-': '&#45;',
};
const LARK_MD_SPECIAL_CHARACTER_PATTERN = /[&*~><[\]()#:_\\`{}!|+-]/gu;
const CONTEXT_KEYS = [
  'approvalBatchId',
  'building',
  'createdAt',
  'expectedDeliveryAt',
  'items',
  'requestCode',
  'requesterName',
  'requesterOpenId',
  'version',
] as const;
const ITEM_CONTEXT_KEYS = [
  'amount',
  'choice',
  'executionRecordId',
  'quantity',
  'rejectionReason',
  'specification',
  'status',
  'title',
  'unit',
] as const;
const ITEM_CONTEXT_KEYS_WITH_PURCHASE_LINKS = [
  ...ITEM_CONTEXT_KEYS,
  'purchaseLinks',
] as const;
const ITEM_CONTEXT_KEYS_WITH_PROCUREMENT = [
  ...ITEM_CONTEXT_KEYS,
  'procurementForm',
  'singleReason',
] as const;
const ITEM_CONTEXT_KEYS_WITH_PURCHASE_LINKS_AND_PROCUREMENT = [
  ...ITEM_CONTEXT_KEYS_WITH_PURCHASE_LINKS,
  'procurementForm',
  'singleReason',
] as const;

export type PurchaseManagerBatchItemStatus =
  | 'pending'
  | 'processing'
  | 'approved'
  | 'rejected'
  | 'manual_reconciliation';

export type PurchaseManagerBatchApprovalChoice =
  | 'comprehensive'
  | 'building_self'
  | 'reject'
  | '';

export interface PurchaseManagerBatchApprovalItemInput {
  executionRecordId: string;
  title: string;
  specification: string;
  quantity: string;
  unit: string;
  amount: string | null;
  purchaseLinks?: string[];
  procurementForm?: '三方比价' | '单一采购' | null;
  singleReason?: string | null;
  status: PurchaseManagerBatchItemStatus;
  choice: PurchaseManagerBatchApprovalChoice;
  rejectionReason: string;
}

export interface PurchaseManagerBatchApprovalCardInput {
  version: 3;
  approvalBatchId: string;
  requesterName: string;
  requesterOpenId: string;
  building: string;
  requestCode: string;
  expectedDeliveryAt: string | null;
  createdAt: string | null;
  items: PurchaseManagerBatchApprovalItemInput[];
  comparisonEvidence?: PurchaseComparisonCardEvidence[];
}

export interface PurchaseManagerBatchApprovalResolution {
  actorName: string;
  processedAt: string | number | Date | null;
}

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const DISPLAY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DISPLAY_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u;

export function buildPurchaseManagerBatchApprovalCard(
  inputValue: PurchaseManagerBatchApprovalCardInput,
  options: { errorMessage?: string } = {},
): Record<string, unknown> {
  const input = canonicalizeCardInput(inputValue);
  const pendingCount = input.items.filter(
    (item) => item.status === 'pending',
  ).length;
  if (pendingCount === 0) {
    throw new BadRequestException('采购审批批次没有待审批物品');
  }
  const decidedCount = input.items.length - pendingCount;

  return cardShell(
    'yellow',
    '采购申请待审批',
    `共 ${input.items.length} 项`,
    'yellow',
    [
      summaryBlock(input),
      ...errorElements(options.errorMessage),
      statusSummary(
        `${pendingCount} 项待审批${
          decidedCount > 0 ? ` · ${decidedCount} 项已处理` : ''
        }`,
      ),
      ...input.items.map((item, index) =>
        itemBlock(input, item, index, 'interactive'),
      ),
      approvalActions(
        input.approvalBatchId,
        input.building,
        pendingCount,
        decidedCount > 0,
      ),
      hintBlock('批量按钮只处理仍待审批的物品，已驳回项不会被覆盖。'),
    ],
    input,
  );
}

export function buildPurchaseManagerBatchRejectEditorCard(
  inputValue: PurchaseManagerBatchApprovalCardInput,
  selectedRecordIdValue: string,
  options: { rejectionReason?: string; errorMessage?: string } = {},
): Record<string, unknown> {
  const input = canonicalizeCardInput(inputValue);
  const selectedRecordId = assertRecordId(selectedRecordIdValue);
  const selectedIndex = input.items.findIndex(
    (item) => item.executionRecordId === selectedRecordId,
  );
  const selectedItem = input.items[selectedIndex];
  if (!selectedItem || selectedItem.status !== 'pending') {
    throw new BadRequestException('采购审批驳回条目不可处理');
  }
  const defaultValue = normalizeRejectionDraft(options.rejectionReason);

  return cardShell('red', `驳回第 ${selectedIndex + 1} 项`, '待填写', 'red', [
    summaryBlock(input),
    itemBlock(input, selectedItem, selectedIndex, 'readonly'),
    ...errorElements(options.errorMessage),
    {
      tag: 'form',
      name: 'purchase_batch_item_reject_form',
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'input',
          name: 'rejection_reason',
          required: true,
          input_type: 'multiline_text',
          max_length: REJECTION_REASON_LIMIT,
          rows: 4,
          width: 'fill',
          label: { tag: 'plain_text', content: '驳回原因' },
          placeholder: {
            tag: 'plain_text',
            content: '请输入驳回原因（必填）',
          },
          ...(defaultValue ? { default_value: defaultValue } : {}),
        },
        {
          tag: 'button',
          name: 'purchase_batch_item_reject_submit',
          type: 'danger_filled',
          width: 'fill',
          form_action_type: 'submit',
          text: { tag: 'plain_text', content: '确认驳回此项' },
        },
      ],
    },
    {
      tag: 'button',
      name: 'purchase_batch_item_reject_cancel',
      type: 'default',
      width: 'fill',
      text: { tag: 'plain_text', content: '返回申请单' },
      behaviors: [
        {
          type: 'callback',
          value: {
            version: 3,
            action: 'cancel_item_reject',
            approvalBatchId: input.approvalBatchId,
          },
        },
      ],
    },
  ], input);
}

export function buildPurchaseManagerBatchPendingCard(
  inputValue: PurchaseManagerBatchApprovalCardInput,
): Record<string, unknown> {
  const input = canonicalizeCardInput(inputValue);
  return cardShell('yellow', '采购审批同步中', '同步中', 'yellow', [
    summaryBlock(input),
    statusSummary(batchStatusText(input.items)),
    ...input.items.map((item, index) =>
      itemBlock(input, item, index, 'readonly'),
    ),
    lockedApprovalActions(input.building),
  ], input);
}

export function buildPurchaseManagerBatchHandoverCard(inputValue: PurchaseManagerBatchApprovalCardInput): Record<string, unknown> {
  const input = canonicalizeCardInput(inputValue);
  return cardShell('orange', '采购审批已转交', '已转交', 'orange', [
    summaryBlock(input), statusSummary('未办结事项已转交，本卡不再办理'),
    ...input.items.map((item, index) => itemBlock(input, item, index, 'readonly')), lockedApprovalActions(input.building),
  ], input);
}

export function buildResolvedPurchaseManagerBatchApprovalCard(
  inputValue: PurchaseManagerBatchApprovalCardInput,
  resolution: PurchaseManagerBatchApprovalResolution,
): Record<string, unknown> {
  const input = canonicalizeCardInput(inputValue);
  const approved = input.items.filter(
    (item) => item.status === 'approved',
  ).length;
  const rejected = input.items.filter(
    (item) => item.status === 'rejected',
  ).length;
  if (approved + rejected !== input.items.length) {
    throw new BadRequestException('采购审批批次尚未形成完整终态');
  }

  const visual =
    rejected === 0
      ? {
          template: 'green' as const,
          title: '采购申请审批结果',
          tag: '审批完成',
        }
      : approved === 0
        ? {
            template: 'red' as const,
            title: '采购申请已驳回',
            tag: '已驳回',
          }
        : {
            template: 'orange' as const,
            title: '采购申请审批结果',
            tag: '部分驳回',
          };

  return cardShell(visual.template, visual.title, visual.tag, visual.template, [
    summaryBlock(input),
    statusSummary(`${approved} 项通过 · ${rejected} 项驳回`),
    ...input.items.map((item, index) =>
      itemBlock(input, item, index, 'terminal'),
    ),
    resultBlock([
      ['处理人', resolution.actorName, BUSINESS_TEXT_LIMIT],
      [
        '处理时间',
        formatPurchaseBatchCardDateTime(resolution.processedAt),
        BUSINESS_TEXT_LIMIT,
      ],
    ]),
    lockedApprovalActions(input.building),
  ], input);
}

export function formatPurchaseBatchCardDate(
  value: string | number | Date | null | undefined,
): string | null {
  if (typeof value === 'string' && DISPLAY_DATE_PATTERN.test(value.trim())) {
    return value.trim();
  }
  const date = parseCardDate(value);
  if (!date) return null;
  const parts = shanghaiDateParts(date, false);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatPurchaseBatchCardDateTime(
  value: string | number | Date | null | undefined,
): string | null {
  if (
    typeof value === 'string' &&
    DISPLAY_DATE_TIME_PATTERN.test(value.trim())
  ) {
    return value.trim();
  }
  const date = parseCardDate(value);
  if (!date) return null;
  const parts = shanghaiDateParts(date, true);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function parseCardDate(
  value: string | number | Date | null | undefined,
): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function shanghaiDateParts(
  date: Date,
  includeTime: boolean,
): Record<'year' | 'month' | 'day' | 'hour' | 'minute', string> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(includeTime
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const }
      : {}),
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    year: values.year || '',
    month: values.month || '',
    day: values.day || '',
    hour: values.hour || '',
    minute: values.minute || '',
  };
}

export function buildPurchaseManagerBatchManualReconciliationCard(
  inputValue: PurchaseManagerBatchApprovalCardInput,
  message = '部分物品状态无法自动确认，请联系管理员核对。',
): Record<string, unknown> {
  const input = canonicalizeCardInput(inputValue);
  return cardShell('orange', '采购审批需人工核对', '需核对', 'orange', [
    summaryBlock(input),
    statusSummary(normalizeBusinessText(message)),
    ...input.items.map((item, index) =>
      itemBlock(input, item, index, 'terminal'),
    ),
    lockedApprovalActions(input.building),
  ], input);
}

export function serializePurchaseManagerBatchApprovalCardContext(
  input: PurchaseManagerBatchApprovalCardInput,
): string {
  const canonical = canonicalizeInput(input);
  const snapshot = (evidence = canonical.comparisonEvidence) => JSON.stringify({ ...canonical, ...(evidence !== undefined
    ? { comparisonEvidence: compactComparisonEvidence(evidence) } : {}) });
  const complete = snapshot();
  if (Buffer.byteLength(complete, 'utf8') <= CONTEXT_MAX_BYTES) return complete;
  if (canonical.comparisonEvidence) {
    // Preserve complete names whenever they fit. Only the display names shrink;
    // each actual record link, attachment position and verified image key stays.
    for (const limit of [120, 80, 48, 24, 12, 8]) {
      const shortened = canonical.comparisonEvidence.map(entry => ({ ...entry,
        attachments: entry.attachments.map(attachment => {
          const characters = Array.from(attachment.name);
          return { ...attachment, name: characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : attachment.name };
        }),
      }));
      const serialized = snapshot(shortened);
      if (Buffer.byteLength(serialized, 'utf8') <= CONTEXT_MAX_BYTES) return serialized;
    }
  }
  throw invalidContext();
}

export function parsePurchaseManagerBatchApprovalCardContext(
  value: string,
): PurchaseManagerBatchApprovalCardInput {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > CONTEXT_MAX_BYTES
  ) {
    throw invalidContext();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidContext();
  }
  if (!isPlainObject(parsed)) throw invalidContext();
  if (!hasExactKeys(parsed, [...CONTEXT_KEYS, ...(Object.hasOwn(parsed, 'comparisonEvidence') ? ['comparisonEvidence'] : [])])) throw invalidContext();
  if (!Array.isArray(parsed.items)) throw invalidContext();
  for (const item of parsed.items) {
    if (
      !isPlainObject(item) ||
      (!hasExactKeys(item, ITEM_CONTEXT_KEYS) &&
        !hasExactKeys(item, ITEM_CONTEXT_KEYS_WITH_PURCHASE_LINKS) &&
        !hasExactKeys(item, ITEM_CONTEXT_KEYS_WITH_PROCUREMENT) &&
        !hasExactKeys(
          item,
          ITEM_CONTEXT_KEYS_WITH_PURCHASE_LINKS_AND_PROCUREMENT,
        ))
    ) {
      throw invalidContext();
    }
  }
  try {
    const expanded = Object.hasOwn(parsed, 'comparisonEvidence')
      ? { ...parsed, comparisonEvidence: expandComparisonEvidence(parsed.comparisonEvidence) } : parsed;
    const canonical = canonicalizeInput(
      expanded as unknown as PurchaseManagerBatchApprovalCardInput,
    );
    if (serializePurchaseManagerBatchApprovalCardContext(canonical) !== value) throw invalidContext();
    return canonical;
  } catch {
    throw invalidContext();
  }
}

function compactComparisonEvidence(entries: PurchaseComparisonCardEvidence[]): unknown[] {
  const firstByAttachments = new Map<string, string>();
  return entries.map(entry => {
    const fingerprint = JSON.stringify(entry.attachments), earlier = firstByAttachments.get(fingerprint);
    if (earlier) return { recordId: entry.recordId, recordUrl: entry.recordUrl, sameAttachmentsAs: earlier };
    firstByAttachments.set(fingerprint, entry.recordId);
    return entry;
  });
}

function expandComparisonEvidence(value: unknown): PurchaseComparisonCardEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_BATCH_ITEMS) throw invalidContext();
  const earlier = new Map<string, PurchaseComparisonCardEvidence>();
  return value.map(raw => {
    if (!isPlainObject(raw)) throw invalidContext();
    let expanded: unknown = raw;
    if (Object.hasOwn(raw, 'sameAttachmentsAs')) {
      if (!hasExactKeys(raw, ['recordId', 'recordUrl', 'sameAttachmentsAs']) || typeof raw.sameAttachmentsAs !== 'string') throw invalidContext();
      const source = earlier.get(raw.sameAttachmentsAs);
      if (!source || raw.recordId === raw.sameAttachmentsAs) throw invalidContext();
      expanded = { recordId: raw.recordId, recordUrl: raw.recordUrl, attachments: source.attachments };
    }
    const entry = normalizePurchaseComparisonCardEvidence(expanded);
    if (earlier.has(entry.recordId)) throw invalidContext();
    earlier.set(entry.recordId, entry);
    return entry;
  });
}

function canonicalizeCardInput(value: PurchaseManagerBatchApprovalCardInput): PurchaseManagerBatchApprovalCardInput {
  return value?.comparisonEvidence !== undefined
    ? parsePurchaseManagerBatchApprovalCardContext(serializePurchaseManagerBatchApprovalCardContext(value))
    : canonicalizeInput(value);
}

function canonicalizeInput(
  value: PurchaseManagerBatchApprovalCardInput,
): PurchaseManagerBatchApprovalCardInput {
  if (!value || value.version !== 3) throw invalidContext();
  const approvalBatchId = assertBatchId(value.approvalBatchId);
  const requesterOpenId = assertOpenId(value.requesterOpenId);
  if (
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > MAX_BATCH_ITEMS
  ) {
    throw invalidContext();
  }
  const seenRecordIds = new Set<string>();
  const items = value.items.map((item) => {
    const executionRecordId = assertRecordId(item.executionRecordId);
    if (seenRecordIds.has(executionRecordId)) throw invalidContext();
    seenRecordIds.add(executionRecordId);
    const status = assertItemStatus(item.status);
    const choice = assertChoice(item.choice);
    const rejectionReason = normalizeOptionalText(
      item.rejectionReason,
      REJECTION_REASON_LIMIT,
    );
    const hasProcurementForm = Object.prototype.hasOwnProperty.call(
      item,
      'procurementForm',
    );
    const hasSingleReason = Object.prototype.hasOwnProperty.call(
      item,
      'singleReason',
    );
    if (hasProcurementForm !== hasSingleReason) throw invalidContext();
    const procurementForm = hasProcurementForm
      ? normalizeProcurementForm(item.procurementForm)
      : undefined;
    const singleReason = hasSingleReason
      ? item.singleReason === null
        ? null
        : normalizeOptionalText(item.singleReason, REJECTION_REASON_LIMIT) ||
          null
      : undefined;
    if (
      procurementForm !== '单一采购' &&
      singleReason !== undefined &&
      singleReason !== null
    ) {
      throw invalidContext();
    }
    assertItemDecision(status, choice, rejectionReason);
    return {
      executionRecordId,
      title: normalizeRequiredText(item.title, BUSINESS_TEXT_LIMIT),
      specification: normalizeRequiredText(
        item.specification,
        BUSINESS_TEXT_LIMIT,
      ),
      quantity: normalizeRequiredText(item.quantity, 40),
      unit: normalizeRequiredText(item.unit, 40),
      amount:
        item.amount === null ? null : normalizeRequiredText(item.amount, 80),
      ...(Object.prototype.hasOwnProperty.call(item, 'purchaseLinks')
        ? { purchaseLinks: normalizePurchaseLinks(item.purchaseLinks) }
        : {}),
      ...(hasProcurementForm ? { procurementForm, singleReason } : {}),
      status,
      choice,
      rejectionReason,
    };
  });
  return {
    version: 3,
    approvalBatchId,
    requesterName: normalizeRequiredText(
      value.requesterName,
      BUSINESS_TEXT_LIMIT,
    ),
    requesterOpenId,
    building: normalizeRequiredText(value.building, 40),
    requestCode: normalizeRequiredText(value.requestCode, 80),
    expectedDeliveryAt:
      value.expectedDeliveryAt === null
        ? null
        : normalizeRequiredText(value.expectedDeliveryAt, BUSINESS_TEXT_LIMIT),
    createdAt:
      value.createdAt === null
        ? null
        : normalizeRequiredText(value.createdAt, BUSINESS_TEXT_LIMIT),
    items,
    ...(value.comparisonEvidence !== undefined ? {
      comparisonEvidence: normalizePurchaseComparisonBatchEvidence(value.comparisonEvidence,
        items.filter(item => item.procurementForm === '三方比价').map(item => item.executionRecordId)),
    } : {}),
  };
}

function cardShell(
  template: 'yellow' | 'red' | 'green' | 'orange',
  title: string,
  tagText: string,
  tagColor: 'yellow' | 'red' | 'green' | 'orange',
  elements: Record<string, unknown>[],
  input?: PurchaseManagerBatchApprovalCardInput,
): Record<string, unknown> {
  return withPurchaseComparisonCardEvidence({
    schema: '2.0',
    config: { update_multi: true, enable_forward: false },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: tagText },
          color: tagColor,
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements,
    },
  }, input?.comparisonEvidence || [], Object.fromEntries((input?.items || []).map((item, index) => [item.executionRecordId, `第 ${index + 1} 项`])));
}

function summaryBlock(
  input: PurchaseManagerBatchApprovalCardInput,
): Record<string, unknown> {
  return resultBlock([
    ['申请人', input.requesterName, BUSINESS_TEXT_LIMIT],
    ['楼栋', input.building, 40],
    [
      '申请采购方式',
      [...new Set(input.items.map((item) => item.procurementForm || '未填写'))].join(' / '),
      80,
    ],
    ['采购编码', input.requestCode, 80],
    ['计划到货', input.expectedDeliveryAt, BUSINESS_TEXT_LIMIT],
    ['预计总额', totalAmount(input.items), 80],
    ['申请时间', input.createdAt, BUSINESS_TEXT_LIMIT],
  ]);
}

function itemBlock(
  input: PurchaseManagerBatchApprovalCardInput,
  item: PurchaseManagerBatchApprovalItemInput,
  index: number,
  mode: 'interactive' | 'readonly' | 'terminal',
): Record<string, unknown> {
  const status = itemStatusLabel(item);
  const canReject = mode === 'interactive' && item.status === 'pending';
  const procurementForm = item.procurementForm
    ? `\n**采购方式**\n${escapeMarkdown(item.procurementForm)}`
    : '';
  const singleReason =
    item.procurementForm === '单一采购' && item.singleReason
      ? `\n**单一采购原因**\n${escapeMarkdown(item.singleReason)}`
      : '';
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: `**${index + 1}. ${escapeMarkdown(item.title)}**\n${escapeMarkdown(
        item.specification,
      )} · ${escapeMarkdown(quantityWithUnit(item))} · ${escapeMarkdown(
        amountLabel(item.amount),
      )}${procurementForm}${singleReason}${status ? `\n${escapeMarkdown(status)}` : ''}`,
    },
  ];
  if (canReject) {
    elements.push({
      tag: 'button',
      type: 'danger',
      size: 'small',
      text: { tag: 'plain_text', content: '驳回此项' },
      behaviors: [
        {
          type: 'callback',
          value: {
            version: 3,
            action: 'open_item_reject',
            approvalBatchId: input.approvalBatchId,
            executionRecordId: item.executionRecordId,
          },
        },
      ],
    });
  } else {
    elements.push({
      tag: 'button',
      type: item.status === 'rejected' ? 'danger_filled' : 'default',
      size: 'small',
      disabled: true,
      disabled_tips: {
        tag: 'plain_text',
        content: status || '当前不可操作',
      },
      text: { tag: 'plain_text', content: status || '不可操作' },
    });
  }
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 4,
        elements: [elements[0]],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [elements[1]],
      },
    ],
  };
}

function approvalActions(
  approvalBatchId: string,
  building: string,
  pendingCount: number,
  hasDecidedItems: boolean,
): Record<string, unknown> {
  const prefix = hasDecidedItems ? `通过剩余 ${pendingCount} 项` : '全部';
  const columns = [
    actionColumn(
      hasDecidedItems ? `${prefix}（综合采购）` : '全部综合采购',
      'primary_filled',
      {
        version: 3,
        action: 'approve_pending_comprehensive',
        approvalBatchId,
      },
    ),
  ];
  if (isBuildingSelfPurchaseAllowed(building)) {
    columns.push(
      actionColumn(
        hasDecidedItems ? `${prefix}（楼内自采）` : '全部楼内自采',
        'default',
        {
          version: 3,
          action: 'approve_pending_building_self',
          approvalBatchId,
        },
      ),
    );
  }
  return {
    tag: 'column_set',
    flex_mode: 'bisect',
    horizontal_spacing: '8px',
    columns,
  };
}

function lockedApprovalActions(building: string): Record<string, unknown> {
  const labels = isBuildingSelfPurchaseAllowed(building)
    ? ['综合采购', '楼内自采']
    : ['综合采购'];
  return {
    tag: 'column_set',
    flex_mode: 'bisect',
    horizontal_spacing: '8px',
    columns: labels.map((label) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        {
          tag: 'button',
          type: 'default',
          width: 'fill',
          disabled: true,
          disabled_tips: { tag: 'plain_text', content: '审批操作已锁定' },
          text: { tag: 'plain_text', content: label },
        },
      ],
    })),
  };
}

function actionColumn(
  label: string,
  type: 'primary_filled' | 'default',
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [
      {
        tag: 'button',
        type,
        width: 'fill',
        text: { tag: 'plain_text', content: label },
        behaviors: [{ type: 'callback', value }],
      },
    ],
  };
}

function statusSummary(content: string): Record<string, unknown> {
  return {
    tag: 'markdown',
    content: `**申请明细**\n${escapeMarkdown(content)}`,
  };
}

function hintBlock(content: string): Record<string, unknown> {
  return { tag: 'markdown', content: escapeMarkdown(content) };
}

function resultBlock(
  fields: ReadonlyArray<readonly [string, unknown, number]>,
): Record<string, unknown> {
  return {
    tag: 'div',
    fields: fields.map(([label, value, limit]) => ({
      is_short: true,
      text: {
        tag: 'lark_md',
        content: `**${label}**\n${escapeMarkdown(
          normalizeBusinessText(value, limit),
        )}`,
      },
    })),
  };
}

function errorElements(errorMessage: unknown): Record<string, unknown>[] {
  const normalized = normalizeOptionalText(errorMessage, BUSINESS_TEXT_LIMIT);
  return normalized
    ? [
        {
          tag: 'markdown',
          content: `**同步提示**\n${escapeMarkdown(normalized)}`,
        },
      ]
    : [];
}

function quantityWithUnit(item: PurchaseManagerBatchApprovalItemInput): string {
  return `${item.quantity} ${item.unit}`.trim();
}

function amountLabel(value: string | null): string {
  return value ? `¥${value}` : '金额未提供';
}

function totalAmount(items: PurchaseManagerBatchApprovalItemInput[]): string {
  let total = 0;
  for (const item of items) {
    if (item.amount === null) return '部分金额未提供';
    const amount = Number(item.amount);
    if (!Number.isFinite(amount)) return '部分金额未提供';
    total += amount;
  }
  return `¥${total.toFixed(2)}`;
}

function batchStatusText(
  items: PurchaseManagerBatchApprovalItemInput[],
): string {
  const processing = items.filter(
    (item) => item.status === 'processing',
  ).length;
  const approved = items.filter((item) => item.status === 'approved').length;
  const rejected = items.filter((item) => item.status === 'rejected').length;
  const pending = items.filter((item) => item.status === 'pending').length;
  return `${processing} 项同步中 · ${approved} 项通过 · ${rejected} 项驳回 · ${pending} 项待审批`;
}

function itemStatusLabel(item: PurchaseManagerBatchApprovalItemInput): string {
  if (item.status === 'approved') {
    return item.choice === 'building_self'
      ? '已通过 · 楼内自采'
      : '已通过 · 综合采购';
  }
  if (item.status === 'rejected') {
    return `已驳回${item.rejectionReason ? ` · ${item.rejectionReason}` : ''}`;
  }
  if (item.status === 'processing') return '审批同步中';
  if (item.status === 'manual_reconciliation') return '需人工核对';
  return '';
}

function normalizeBusinessText(
  value: unknown,
  limit = BUSINESS_TEXT_LIMIT,
): string {
  const source =
    value instanceof Date
      ? Number.isFinite(value.getTime())
        ? value.toISOString()
        : ''
      : typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
  const normalized = source
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return '未提供';
  const characters = Array.from(normalized);
  return characters.length <= limit
    ? normalized
    : `${characters.slice(0, Math.max(1, limit - 1)).join('')}…`;
}

function normalizeRequiredText(value: unknown, limit: number): string {
  const normalized = normalizeBusinessText(value, limit);
  if (normalized === '未提供') throw invalidContext();
  return normalized;
}

function normalizeOptionalText(value: unknown, limit: number): string {
  const normalized = normalizeBusinessText(value, limit);
  return normalized === '未提供' ? '' : normalized;
}

function normalizeProcurementForm(
  value: unknown,
): PurchaseManagerBatchApprovalItemInput['procurementForm'] {
  if (value === null) return null;
  if (value === '三方比价') return '三方比价';
  if (value === '单一采购') return '单一采购';
  throw invalidContext();
}

function normalizePurchaseLinks(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > PURCHASE_LINK_LIMIT) {
    throw invalidContext();
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') throw invalidContext();
    const normalized = candidate.trim();
    if (!normalized || normalized.length > PURCHASE_LINK_MAX_LENGTH) {
      throw invalidContext();
    }
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw invalidContext();
    }
    if (parsed.protocol !== 'https:') throw invalidContext();
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function normalizeRejectionDraft(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, '')
    .trim();
  const characters = Array.from(normalized);
  return characters.length <= REJECTION_REASON_LIMIT
    ? normalized
    : `${characters.slice(0, REJECTION_REASON_LIMIT - 1).join('')}…`;
}

function escapeMarkdown(value: string): string {
  return value.replace(
    LARK_MD_SPECIAL_CHARACTER_PATTERN,
    (character) => LARK_MD_HTML_ENTITIES[character] ?? character,
  );
}

function assertBatchId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!BATCH_ID_PATTERN.test(normalized)) throw invalidContext();
  return normalized;
}

function assertRecordId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!RECORD_ID_PATTERN.test(normalized)) throw invalidContext();
  return normalized;
}

function assertOpenId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!OPEN_ID_PATTERN.test(normalized)) throw invalidContext();
  return normalized;
}

function assertItemStatus(value: unknown): PurchaseManagerBatchItemStatus {
  if (
    value !== 'pending' &&
    value !== 'processing' &&
    value !== 'approved' &&
    value !== 'rejected' &&
    value !== 'manual_reconciliation'
  ) {
    throw invalidContext();
  }
  return value;
}

function assertChoice(value: unknown): PurchaseManagerBatchApprovalChoice {
  if (
    value !== '' &&
    value !== 'comprehensive' &&
    value !== 'building_self' &&
    value !== 'reject'
  ) {
    throw invalidContext();
  }
  return value;
}

function assertItemDecision(
  status: PurchaseManagerBatchItemStatus,
  choice: PurchaseManagerBatchApprovalChoice,
  rejectionReason: string,
): void {
  if (status === 'pending' && (choice !== '' || rejectionReason)) {
    throw invalidContext();
  }
  if (
    status === 'approved' &&
    choice !== 'comprehensive' &&
    choice !== 'building_self'
  ) {
    throw invalidContext();
  }
  if (status === 'approved' && rejectionReason) throw invalidContext();
  if (status === 'rejected' && (choice !== 'reject' || !rejectionReason)) {
    throw invalidContext();
  }
  if (
    status === 'processing' &&
    choice !== 'comprehensive' &&
    choice !== 'building_self' &&
    choice !== 'reject'
  ) {
    throw invalidContext();
  }
  if (choice !== 'reject' && rejectionReason) throw invalidContext();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function invalidContext(): BadRequestException {
  return new BadRequestException('采购批次审批卡上下文无效');
}
