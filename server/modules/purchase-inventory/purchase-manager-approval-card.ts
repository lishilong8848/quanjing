import { BadRequestException } from '@nestjs/common';
import { normalizePurchaseComparisonCardEvidence, withPurchaseComparisonCardEvidence, type PurchaseComparisonCardEvidence } from './purchase-comparison-card-evidence';
import {
  isBuildingSelfPurchaseAllowed,
  procurementMethodOptionsLabel,
} from './purchase-procurement-method-policy';

const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const BUSINESS_TEXT_LIMIT = 200;
const REASON_TEXT_LIMIT = 500;
const CONTEXT_MAX_BYTES = 12_000;
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
  'amount',
  'building',
  'createdAt',
  'executionRecordId',
  'expectedDeliveryAt',
  'procurementForm',
  'quantity',
  'requestCode',
  'requester',
  'singleReason',
  'title',
  'unit',
  'version',
] as const;

export interface PurchaseManagerApprovalCardInput {
  executionRecordId: string;
  requester: string;
  building: string;
  title: string;
  quantity: number | string;
  unit?: string | null;
  amount?: number | string | null;
  procurementForm?: '三方比价' | '单一采购' | null;
  singleReason?: string | null;
  expectedDeliveryAt?: string | number | Date | null;
  requestCode?: string | null;
  createdAt?: string | number | Date | null;
  comparisonEvidence?: PurchaseComparisonCardEvidence;
}

export type PurchaseManagerApprovalChoice =
  | 'comprehensive'
  | 'building_self'
  | 'reject';

export interface PurchaseManagerApprovalResolution {
  choice: PurchaseManagerApprovalChoice;
  actorName: string;
  processedAt: string | number | Date | null;
  rejectionReason?: string | null;
}

interface PurchaseManagerApprovalCardContext {
  version: 1;
  executionRecordId: string;
  requester: string;
  building: string;
  title: string;
  quantity: string;
  unit: string | null;
  amount: string | null;
  procurementForm: '三方比价' | '单一采购' | null;
  singleReason: string | null;
  expectedDeliveryAt: string | null;
  requestCode: string | null;
  createdAt: string | null;
  comparisonEvidence?: PurchaseComparisonCardEvidence;
}

export function buildPurchaseManagerApprovalCard(
  input: PurchaseManagerApprovalCardInput,
  options: { errorMessage?: string } = {},
): Record<string, unknown> {
  const executionRecordId = assertExecutionRecordId(input.executionRecordId);
  const allowsBuildingSelf = isBuildingSelfPurchaseAllowed(input.building);

  return withPurchaseComparisonCardEvidence({
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
    },
    header: {
      template: 'yellow',
      title: { tag: 'plain_text', content: '采购申请待审批' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '待处理' },
          color: 'yellow',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements: [
        detailBlock(input),
        ...errorElements(options.errorMessage),
        {
          tag: 'column_set',
          flex_mode: allowsBuildingSelf ? 'trisect' : 'bisect',
          horizontal_spacing: '8px',
          columns: [
            actionColumn(
              '综合采购',
              'primary_filled',
              'choose_comprehensive',
              executionRecordId,
            ),
            ...(allowsBuildingSelf
              ? [
                  actionColumn(
                    '楼内自采',
                    'default',
                    'choose_building_self',
                    executionRecordId,
                  ),
                ]
              : []),
            actionColumn('驳回', 'danger', 'open_reject', executionRecordId),
          ],
        },
      ],
    },
  }, comparisonEvidence(input));
}

export function buildPurchaseManagerRejectEditorCard(
  input: PurchaseManagerApprovalCardInput,
  options: { rejectionReason?: string; errorMessage?: string } = {},
): Record<string, unknown> {
  assertExecutionRecordId(input.executionRecordId);
  const defaultValue = normalizeRejectionDraft(options.rejectionReason);
  const allowsBuildingSelf = isBuildingSelfPurchaseAllowed(input.building);

  return withPurchaseComparisonCardEvidence({
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
    },
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: '填写采购驳回原因' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '待填写' },
          color: 'red',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements: [
        detailBlock(input),
        ...errorElements(options.errorMessage),
        {
          tag: 'form',
          name: 'purchase_reject_form',
          direction: 'vertical',
          vertical_spacing: '12px',
          elements: [
            {
              tag: 'input',
              name: 'rejection_reason',
              required: true,
              input_type: 'multiline_text',
              max_length: REASON_TEXT_LIMIT,
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
              tag: 'column_set',
              flex_mode: allowsBuildingSelf ? 'trisect' : 'bisect',
              horizontal_spacing: '8px',
              columns: [
                formButtonColumn({
                  label: '综合采购',
                  name: 'purchase_reject_comprehensive_disabled',
                  type: 'default',
                  formActionType: 'reset',
                  disabled: true,
                }),
                ...(allowsBuildingSelf
                  ? [
                      formButtonColumn({
                        label: '楼内自采',
                        name: 'purchase_reject_building_self_disabled',
                        type: 'default',
                        formActionType: 'reset',
                        disabled: true,
                      }),
                    ]
                  : []),
                formButtonColumn({
                  label: '确认驳回',
                  name: 'purchase_reject_submit',
                  type: 'danger_filled',
                  formActionType: 'submit',
                  disabled: false,
                }),
              ],
            },
          ],
        },
      ],
    },
  }, comparisonEvidence(input));
}

export function buildPurchaseManagerPendingCard(
  input: PurchaseManagerApprovalCardInput,
  choice: PurchaseManagerApprovalChoice,
): Record<string, unknown> {
  assertExecutionRecordId(input.executionRecordId);
  assertChoice(choice);

  return withPurchaseComparisonCardEvidence({
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
    },
    header: {
      template: 'yellow',
      title: { tag: 'plain_text', content: '采购审批同步中' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '同步中' },
          color: 'yellow',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements: [
        detailBlock(input),
        resultBlock([['当前选择', choiceLabel(choice), BUSINESS_TEXT_LIMIT]]),
        lockedChoicesBlock(choice, input.building),
      ],
    },
  }, comparisonEvidence(input));
}

export function buildResolvedPurchaseManagerApprovalCard(
  input: PurchaseManagerApprovalCardInput,
  resolution: PurchaseManagerApprovalResolution,
): Record<string, unknown> {
  assertExecutionRecordId(input.executionRecordId);
  assertChoice(resolution.choice);
  const rejected = resolution.choice === 'reject';

  return withPurchaseComparisonCardEvidence({
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
    },
    header: {
      template: rejected ? 'red' : 'green',
      title: { tag: 'plain_text', content: '采购申请审批结果' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: {
            tag: 'plain_text',
            content: rejected ? '已驳回' : '已通过',
          },
          color: rejected ? 'red' : 'green',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements: [
        detailBlock(input),
        resultBlock([
          ['处理结果', choiceLabel(resolution.choice), BUSINESS_TEXT_LIMIT],
          ['处理人', resolution.actorName, BUSINESS_TEXT_LIMIT],
          ['处理时间', resolution.processedAt, BUSINESS_TEXT_LIMIT],
          ...(rejected
            ? ([
                ['驳回原因', resolution.rejectionReason, REASON_TEXT_LIMIT],
              ] as const)
            : []),
        ]),
        lockedChoicesBlock(resolution.choice, input.building),
      ],
    },
  }, comparisonEvidence(input));
}

export function buildPurchaseManagerManualReconciliationCard(
  input: PurchaseManagerApprovalCardInput,
  options: {
    choice?: PurchaseManagerApprovalChoice;
    message?: string;
  } = {},
): Record<string, unknown> {
  assertExecutionRecordId(input.executionRecordId);
  if (options.choice !== undefined) assertChoice(options.choice);

  return withPurchaseComparisonCardEvidence({
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
    },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '采购审批需人工核对' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '需人工核对' },
          color: 'orange',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements: [
        detailBlock(input),
        resultBlock([
          ['处理状态', '需人工核对', BUSINESS_TEXT_LIMIT],
          [
            '核对说明',
            normalizeOptionalText(options.message, BUSINESS_TEXT_LIMIT) ||
              '系统无法自动确认处理结果，请联系管理员核对。',
            BUSINESS_TEXT_LIMIT,
          ],
        ]),
        lockedChoicesBlock(options.choice, input.building),
      ],
    },
  }, comparisonEvidence(input));
}

export function buildPurchaseManagerTransferredCard(input:PurchaseManagerApprovalCardInput):Record<string,unknown>{
  assertExecutionRecordId(input.executionRecordId);
  return withPurchaseComparisonCardEvidence({schema:'2.0',config:{update_multi:true,enable_forward:false},header:{template:'orange',title:{tag:'plain_text',content:'采购审批已转交'},text_tag_list:[{tag:'text_tag',text:{tag:'plain_text',content:'已转交'},color:'orange'}]},
    body:{direction:'vertical',padding:'12px 12px 20px 12px',elements:[detailBlock(input),resultBlock([['办理状态','未办结事项已转交，本卡不再办理',BUSINESS_TEXT_LIMIT]]),lockedChoicesBlock(undefined,input.building)]}}, comparisonEvidence(input));
}

export function serializePurchaseManagerApprovalCardContext(
  input: PurchaseManagerApprovalCardInput,
): string {
  const procurementForm =
    input.procurementForm === '三方比价' || input.procurementForm === '单一采购'
      ? input.procurementForm
      : null;
  const context: PurchaseManagerApprovalCardContext = {
    version: 1,
    executionRecordId: assertExecutionRecordId(input.executionRecordId),
    requester: normalizeBusinessText(input.requester),
    building: normalizeBusinessText(input.building),
    title: normalizeBusinessText(input.title),
    quantity: normalizeBusinessText(input.quantity, 40),
    unit: normalizeNullableText(input.unit, 40),
    amount: normalizeNullableText(input.amount, 80),
    procurementForm,
    singleReason:
      procurementForm === '单一采购'
        ? normalizeNullableText(input.singleReason, REASON_TEXT_LIMIT)
        : null,
    expectedDeliveryAt: normalizeNullableText(
      input.expectedDeliveryAt,
      BUSINESS_TEXT_LIMIT,
    ),
    requestCode: normalizeNullableText(input.requestCode, BUSINESS_TEXT_LIMIT),
    createdAt: normalizeNullableText(input.createdAt, BUSINESS_TEXT_LIMIT),
    ...(input.comparisonEvidence !== undefined ? { comparisonEvidence: comparisonEvidence(input)[0] } : {}),
  };
  const serialized = JSON.stringify(context);
  if (Buffer.byteLength(serialized, 'utf8') > CONTEXT_MAX_BYTES) {
    throw invalidContext();
  }
  return serialized;
}

export function parsePurchaseManagerApprovalCardContext(
  value: string,
): PurchaseManagerApprovalCardInput {
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidContext();
  }

  const context = parsed as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(context).sort()) !==
    JSON.stringify([...CONTEXT_KEYS, ...(Object.hasOwn(context, 'comparisonEvidence') ? ['comparisonEvidence'] : [])].sort())
  ) {
    throw invalidContext();
  }
  if (context.version !== 1) throw invalidContext();
  const executionRecordId = readContextRecordId(context.executionRecordId);
  const requester = readCanonicalContextText(
    context.requester,
    BUSINESS_TEXT_LIMIT,
    false,
  );
  const building = readCanonicalContextText(
    context.building,
    BUSINESS_TEXT_LIMIT,
    false,
  );
  const title = readCanonicalContextText(
    context.title,
    BUSINESS_TEXT_LIMIT,
    false,
  );
  const quantity = readCanonicalContextText(context.quantity, 40, false);
  const unit = readCanonicalContextText(context.unit, 40, true);
  const amount = readCanonicalContextText(context.amount, 80, true);
  const procurementForm = readContextProcurementForm(context.procurementForm);
  const singleReason = readCanonicalContextText(
    context.singleReason,
    REASON_TEXT_LIMIT,
    true,
  );
  if (procurementForm !== '单一采购' && singleReason !== null) {
    throw invalidContext();
  }
  if (Object.hasOwn(context, 'comparisonEvidence') && procurementForm !== '三方比价') throw invalidContext();
  const parsedEvidence = Object.hasOwn(context, 'comparisonEvidence')
    ? normalizePurchaseComparisonCardEvidence(context.comparisonEvidence, executionRecordId) : undefined;
  if (parsedEvidence && JSON.stringify(parsedEvidence) !== JSON.stringify(context.comparisonEvidence)) throw invalidContext();

  return {
    executionRecordId,
    requester,
    building,
    title,
    quantity,
    unit,
    amount,
    procurementForm,
    singleReason,
    expectedDeliveryAt: readCanonicalContextText(
      context.expectedDeliveryAt,
      BUSINESS_TEXT_LIMIT,
      true,
    ),
    requestCode: readCanonicalContextText(
      context.requestCode,
      BUSINESS_TEXT_LIMIT,
      true,
    ),
    createdAt: readCanonicalContextText(
      context.createdAt,
      BUSINESS_TEXT_LIMIT,
      true,
    ),
    ...(parsedEvidence ? { comparisonEvidence: parsedEvidence } : {}),
  };
}

function comparisonEvidence(input: PurchaseManagerApprovalCardInput): PurchaseComparisonCardEvidence[] {
  if (input.comparisonEvidence === undefined) return [];
  if (input.procurementForm !== '三方比价') throw invalidContext();
  return [normalizePurchaseComparisonCardEvidence(input.comparisonEvidence, assertExecutionRecordId(input.executionRecordId))];
}

function detailBlock(
  input: PurchaseManagerApprovalCardInput,
): Record<string, unknown> {
  const fields: ReadonlyArray<readonly [string, unknown, number?]> = [
    ['申请人', input.requester],
    ['楼栋', input.building],
    ['可选采购方式', procurementMethodOptionsLabel(input.building)],
    ['物品', input.title],
    ['数量', quantityWithUnit(input.quantity, input.unit)],
    ['金额', input.amount],
    ['采购形式', input.procurementForm],
    ...(input.procurementForm === '单一采购'
      ? ([['单一原因', input.singleReason, REASON_TEXT_LIMIT]] as const)
      : []),
    ['计划到货', input.expectedDeliveryAt],
    ['采购编码', input.requestCode],
    ['申请时间', input.createdAt],
  ];

  return {
    tag: 'div',
    fields: fields.map(([label, value, limit]) => {
      const isSingleReason = label === '单一原因';
      return {
        is_short: !isSingleReason,
        text: {
          tag: 'lark_md',
          content: `**${label}**\n${escapeMarkdown(
            normalizeBusinessText(value, limit),
          )}`,
          ...(isSingleReason ? { lines: 4 } : {}),
        },
      };
    }),
  };
}

function resultBlock(
  fields: ReadonlyArray<readonly [string, unknown, number]>,
): Record<string, unknown> {
  return {
    tag: 'div',
    fields: fields.map(([label, value, limit]) => ({
      is_short: label !== '驳回原因',
      text: {
        tag: 'lark_md',
        content: `**${label}**\n${escapeMarkdown(
          normalizeBusinessText(value, limit),
        )}`,
      },
    })),
  };
}

function lockedChoicesBlock(
  selectedChoice?: PurchaseManagerApprovalChoice,
  building = '',
): Record<string, unknown> {
  const choices = (
    [
      ['comprehensive', '综合采购'],
      ['building_self', '楼内自采'],
      ['reject', '驳回'],
    ] as const
  ).filter(
    ([choice]) =>
      choice !== 'building_self' || isBuildingSelfPurchaseAllowed(building),
  );
  return {
    tag: 'column_set',
    flex_mode: choices.length === 3 ? 'trisect' : 'bisect',
    horizontal_spacing: '8px',
    columns: choices.map(([choice, label]) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [
        {
          tag: 'button',
          type:
            choice === selectedChoice
              ? choice === 'reject'
                ? 'danger_filled'
                : 'primary_filled'
              : 'default',
          width: 'fill',
          disabled: true,
          disabled_tips: {
            tag: 'plain_text',
            content: choice === selectedChoice ? '已选择' : '其他选项已锁定',
          },
          text: { tag: 'plain_text', content: label },
        },
      ],
    })),
  };
}

function formButtonColumn(input: {
  label: string;
  name: string;
  type: 'default' | 'danger_filled';
  formActionType: 'reset' | 'submit';
  disabled: boolean;
}): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [
      {
        tag: 'button',
        name: input.name,
        type: input.type,
        width: 'fill',
        disabled: input.disabled,
        form_action_type: input.formActionType,
        text: { tag: 'plain_text', content: input.label },
      },
    ],
  };
}

function actionColumn(
  label: string,
  type: 'primary_filled' | 'default' | 'danger',
  action: 'choose_comprehensive' | 'choose_building_self' | 'open_reject',
  executionRecordId: string,
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
        behaviors: [
          {
            type: 'callback',
            value: { version: 2, action, executionRecordId },
          },
        ],
      },
    ],
  };
}

function quantityWithUnit(
  quantity: number | string,
  unit?: string | null,
): string {
  const safeQuantity = normalizeBusinessText(quantity, 40);
  const safeUnit = normalizeBusinessText(unit, 40);
  if (safeQuantity === '未提供') return safeUnit;
  if (safeUnit === '未提供') return safeQuantity;
  return `${safeQuantity} ${safeUnit}`;
}

function errorElements(errorMessage: unknown): Record<string, unknown>[] {
  const message = normalizeOptionalText(errorMessage, BUSINESS_TEXT_LIMIT);
  return message
    ? [
        {
          tag: 'markdown',
          content: `**同步提示**\n${escapeMarkdown(message)}`,
        },
      ]
    : [];
}

function normalizeOptionalText(value: unknown, limit: number): string {
  const normalized = normalizeBusinessText(value, limit);
  return normalized === '未提供' ? '' : normalized;
}

function normalizeNullableText(value: unknown, limit: number): string | null {
  return normalizeOptionalText(value, limit) || null;
}

function normalizeRejectionDraft(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, '')
    .trim();
  const characters = Array.from(normalized);
  return characters.length <= REASON_TEXT_LIMIT
    ? normalized
    : `${characters.slice(0, REASON_TEXT_LIMIT - 1).join('')}…`;
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

function escapeMarkdown(value: string): string {
  return value.replace(
    LARK_MD_SPECIAL_CHARACTER_PATTERN,
    (character) => LARK_MD_HTML_ENTITIES[character] ?? character,
  );
}

function assertExecutionRecordId(value: unknown): string {
  if (typeof value !== 'string' || !RECORD_ID_PATTERN.test(value)) {
    throw new BadRequestException('采购执行记录标识无效');
  }
  return value;
}

function assertChoice(
  value: unknown,
): asserts value is PurchaseManagerApprovalChoice {
  if (
    value !== 'comprehensive' &&
    value !== 'building_self' &&
    value !== 'reject'
  ) {
    throw new BadRequestException('采购审批选择无效');
  }
}

function choiceLabel(choice: PurchaseManagerApprovalChoice): string {
  if (choice === 'comprehensive') return '综合采购';
  if (choice === 'building_self') return '楼内自采';
  return '驳回';
}

function readContextRecordId(value: unknown): string {
  try {
    return assertExecutionRecordId(value);
  } catch {
    throw invalidContext();
  }
}

function readCanonicalContextText(
  value: unknown,
  limit: number,
  nullable: false,
): string;
function readCanonicalContextText(
  value: unknown,
  limit: number,
  nullable: true,
): string | null;
function readCanonicalContextText(
  value: unknown,
  limit: number,
  nullable: boolean,
): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== 'string' ||
    Array.from(value).length > limit ||
    normalizeBusinessText(value, limit) !== value
  ) {
    throw invalidContext();
  }
  return value;
}

function readContextProcurementForm(
  value: unknown,
): PurchaseManagerApprovalCardInput['procurementForm'] {
  if (value === null) return null;
  if (value === '三方比价' || value === '单一采购') {
    return value;
  }
  throw invalidContext();
}

function invalidContext(): BadRequestException {
  return new BadRequestException('采购审批卡上下文无效');
}
