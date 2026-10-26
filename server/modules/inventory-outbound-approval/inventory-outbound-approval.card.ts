import type {
  InventoryOutboundApprovalDecision,
  InventoryOutboundApprovalSnapshot,
} from './inventory-outbound-approval.types';
import { normalizeInventoryOutboundRejectionReason } from './inventory-outbound-approval.validation';

const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;

type CardTemplate = 'blue' | 'green' | 'red';
type InitialCardAction = 'approve' | 'open_reject' | 'return_to_approval';

export function buildInventoryOutboundApprovalCard(
  snapshot: InventoryOutboundApprovalSnapshot,
): Record<string, unknown> {
  assertSnapshotBinding(snapshot);
  return buildCard('blue', '物品出库待审批', [
    ...snapshotElements(snapshot),
    approvalActionRow(snapshot),
  ]);
}

export function buildInventoryOutboundRejectionPromptCard(
  snapshot: InventoryOutboundApprovalSnapshot,
): Record<string, unknown> {
  assertSnapshotBinding(snapshot);
  return buildCard('red', '物品出库 · 填写驳回原因', [
    ...snapshotElements(snapshot),
    {
      tag: 'markdown',
      content:
        '<font color="grey">尚未提交驳回；填写原因并确认后才会改变审批状态。</font>',
    },
    rejectionForm(snapshot),
    returnToApprovalAction(snapshot),
  ]);
}

export function buildInventoryOutboundAcceptedCard(
  snapshot: InventoryOutboundApprovalSnapshot,
  decision: InventoryOutboundApprovalDecision,
): Record<string, unknown> {
  return buildResultCard(snapshot, decision, true);
}

export function buildInventoryOutboundTerminalCard(
  snapshot: InventoryOutboundApprovalSnapshot,
  decision: InventoryOutboundApprovalDecision,
): Record<string, unknown> {
  return buildResultCard(snapshot, decision, false);
}

export function buildInventoryOutboundSupersededCard(
  snapshot: InventoryOutboundApprovalSnapshot,
  replacementVersion: number,
): Record<string, unknown> {
  assertSnapshotBinding(snapshot);
  if (
    !Number.isSafeInteger(replacementVersion) ||
    replacementVersion <= snapshot.version
  ) {
    throw new Error('出库审批替代版本无效');
  }
  return buildCard('red', '出库审批已失效', [
    ...snapshotElements(snapshot),
    {
      tag: 'markdown',
      content:
        '<font color="red">库房示例人员019员已变更，本卡已失效；申请已重新路由给当前库房示例人员019员。</font>',
    },
    disabledApprovalActionRow(),
  ]);
}

function buildResultCard(
  snapshot: InventoryOutboundApprovalSnapshot,
  decision: InventoryOutboundApprovalDecision,
  syncing: boolean,
): Record<string, unknown> {
  assertSnapshotBinding(snapshot);
  const approved = decision.action === 'approve';
  if (!approved && decision.action !== 'reject') {
    throw new Error('出库审批结果无效');
  }
  const title = approved ? '出库审批通过' : '出库审批驳回';
  const cardTitle = syncing
    ? `${title} · 同步中`
    : approved
      ? '出库完成'
      : title;
  return buildCard(approved ? 'green' : 'red', cardTitle, [
    ...snapshotElements(snapshot),
    markdownField('处理结果', approved ? '审批通过' : '审批驳回', 40),
    markdownField('处理人', decision.actorName, 80),
    markdownField('处理时间', formatDateTime(decision.decidedAt), 80),
    ...(!approved
      ? [
          markdownField(
            '驳回原因',
            requiredRejectionReason(decision.reason),
            500,
          ),
        ]
      : []),
    ...(approved
      ? [
          {
            tag: 'markdown',
            content: syncing
              ? '<font color="blue">审批决定已受理，系统正在复核实时库存并办理正式出库。</font>'
              : '<font color="green">审批已通过，库存已扣减并完成正式出库。</font>',
          },
        ]
      : []),
    disabledApprovalActionRow(),
  ]);
}

function buildCard(
  template: CardTemplate,
  title: string,
  elements: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements,
    },
  };
}

function snapshotElements(
  snapshot: InventoryOutboundApprovalSnapshot,
): Array<Record<string, unknown>> {
  const specificationAndBrand = [
    normalizeBusinessText(snapshot.specification, 120),
    normalizeBusinessText(snapshot.brand, 80),
  ].join(' / ');
  return [
    markdownField('出库编号', snapshot.outboundNumber, 160),
    markdownField(
      '物品 / 类别号',
      `${normalizeBusinessText(snapshot.itemName, 100)} / ${normalizeBusinessText(snapshot.sku, 80)}`,
      200,
    ),
    markdownField('规格 / 品牌', specificationAndBrand, 220),
    markdownField(
      '申请数量 / 当前库存',
      `${formatQuantity(snapshot.quantity, snapshot.unit)} / ${formatQuantity(
        snapshot.availableStock,
        snapshot.unit,
      )}`,
      100,
    ),
    markdownField(
      '来源楼栋 / 库位',
      `${normalizeBusinessText(snapshot.building, 40)} / ${normalizeBusinessText(
        snapshot.location,
        160,
      )}`,
      220,
    ),
    markdownField('物品申请人', snapshot.applicantName, 80),
    markdownField('出库原因 / 使用地点', snapshot.reason, 300),
    markdownField('申请时间', formatDateTime(snapshot.appliedAt), 80),
  ];
}

function approvalActionRow(
  snapshot: InventoryOutboundApprovalSnapshot,
): Record<string, unknown> {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: [
      actionColumn('同意', 'primary_filled', 'approve', snapshot),
      actionColumn('驳回', 'danger', 'open_reject', snapshot),
    ],
  };
}

function actionColumn(
  label: string,
  type: 'primary_filled' | 'danger',
  action: InitialCardAction,
  snapshot: InventoryOutboundApprovalSnapshot,
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
            value: {
              workflowType: 'inventory_outbound',
              action,
              recordId: snapshot.recordId,
              version: snapshot.version,
            },
          },
        ],
      },
    ],
  };
}

function rejectionForm(
  snapshot: InventoryOutboundApprovalSnapshot,
): Record<string, unknown> {
  return {
    tag: 'form',
    name: 'inventory_outbound_rejection_form',
    direction: 'vertical',
    vertical_spacing: '8px',
    elements: [
      {
        tag: 'input',
        name: 'inventory_outbound_rejection_reason',
        required: true,
        input_type: 'multiline_text',
        max_length: 500,
        rows: 3,
        width: 'fill',
        label: { tag: 'plain_text', content: '驳回原因' },
        placeholder: {
          tag: 'plain_text',
          content: '驳回时必填，2–500 字',
        },
      },
      {
        tag: 'button',
        name: `inventory_outbound_reject_submit:${snapshot.recordId}:${snapshot.version}`,
        type: 'danger',
        width: 'fill',
        form_action_type: 'submit',
        text: { tag: 'plain_text', content: '确认驳回' },
      },
    ],
  };
}

function returnToApprovalAction(
  snapshot: InventoryOutboundApprovalSnapshot,
): Record<string, unknown> {
  return {
    tag: 'button',
    type: 'default',
    width: 'fill',
    text: { tag: 'plain_text', content: '返回审批' },
    behaviors: [
      {
        type: 'callback',
        value: {
          workflowType: 'inventory_outbound',
          action: 'return_to_approval',
          recordId: snapshot.recordId,
          version: snapshot.version,
        },
      },
    ],
  };
}

function disabledApprovalActionRow(): Record<string, unknown> {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: [disabledActionColumn('同意'), disabledActionColumn('驳回')],
  };
}

function disabledActionColumn(label: string): Record<string, unknown> {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [
      {
        tag: 'button',
        type: 'default',
        width: 'fill',
        disabled: true,
        disabled_tips: { tag: 'plain_text', content: '该申请已处理' },
        text: { tag: 'plain_text', content: label },
      },
    ],
  };
}

function markdownField(
  label: string,
  value: unknown,
  limit: number,
): Record<string, unknown> {
  return {
    tag: 'markdown',
    content: `**${escapeMarkdown(label)}**\n${escapeMarkdown(
      normalizeBusinessText(value, limit),
    )}`,
  };
}

function formatQuantity(value: number, unit: string): string {
  const quantity =
    Number.isFinite(value) && value >= 0
      ? Number(value.toFixed(2)).toString()
      : '未提供';
  return `${quantity} ${normalizeBusinessText(unit, 20)}`;
}

function formatDateTime(value: unknown): string {
  const source = normalizeBusinessText(value, 80);
  if (source === '未提供') return source;
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) return source.replace(/T/u, ' ');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value || '';
  return `${read('year')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}`;
}

function requiredRejectionReason(value: unknown): string {
  const reason = normalizeInventoryOutboundRejectionReason(value);
  if (!reason) {
    throw new Error('驳回原因需填写 2–500 字');
  }
  return reason;
}

function normalizeBusinessText(value: unknown, limit: number): string {
  const source =
    typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const normalized = source
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return '未提供';
  const characters = Array.from(normalized);
  return characters.length <= limit
    ? normalized
    : `${characters.slice(0, Math.max(1, limit - 1)).join('')}…`;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/[\\`*_{}\[\]<>!|~()]/gu, '\\$&')
    .replace(/^[#>+\-]/u, '\\$&');
}

function assertSnapshotBinding(
  snapshot: InventoryOutboundApprovalSnapshot,
): void {
  if (!RECORD_ID_PATTERN.test(String(snapshot.recordId || ''))) {
    throw new Error('出库记录标识无效');
  }
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version <= 0) {
    throw new Error('出库审批卡片版本无效');
  }
}
