import { BadRequestException } from '@nestjs/common';
import type { PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';

const BUSINESS_TEXT_LIMIT = 200;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export function buildWarehouseInboundHandoverCard(itemName: string, targetName: string): Record<string, unknown> {
  return {
    schema: '2.0',
    header: { template: 'grey', title: { tag: 'plain_text', content: '待入库提醒已交接' } },
    body: { elements: [{ tag: 'markdown', content: `**${escapeMarkdown(normalizeBusinessText(itemName))}**\n当前负责人：${escapeMarkdown(normalizeBusinessText(targetName))}` }] },
  };
}

export interface PurchaseApprovalCardInput {
  executionRecordId: string;
  requester: string;
  building: string;
  title: string;
  quantity: number | string;
  unit: string;
  amount?: number | string | null;
  purchaseMethod?: string | null;
  expectedDeliveryAt?: string | number | Date | null;
  requestCode?: string | null;
  createdAt: string | number | Date | null;
  statusLabel: string;
}

export function buildTransferredPurchaseApprovalCard(input: PurchaseApprovalCardInput): Record<string, unknown> {
  return { schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: { template: 'grey', title: { tag: 'plain_text', content: '采购审批已转交' } },
    body: { elements: [['物品', input.title], ['楼栋', input.building], ['单号', input.requestCode]].map(([label, value]) => ({ tag: 'markdown', content: `**${label}**\n${escapeMarkdown(normalizeBusinessText(value))}` })) } };
}

export interface ManualInventoryInboundCompletedCardInput {
  name: string;
  sku: string;
  specification: string;
  quantity: number | string;
  unit: string;
  building: string;
  location: string;
  occurredAt: string | number | Date | null;
}

export type PurchaseApprovalCardAction = 'approve' | 'reject';

export interface ResolvedPurchaseApprovalCardResolution {
  decision: PurchaseApprovalCardAction;
  actorName: string;
  processedAt: string | number | Date | null;
}

export function buildResolvedPurchaseApprovalCard(
  input: PurchaseApprovalCardInput,
  resolution: ResolvedPurchaseApprovalCardResolution,
): Record<string, unknown> {
  const decisionLabel = resolution.decision === 'approve' ? '已确认' : '已驳回';
  const fields = [
    ['申请人', input.requester],
    ['楼栋', input.building],
    ['物品', input.title],
    ['数量', quantityWithUnit(input.quantity, input.unit)],
    ['金额', input.amount],
    ['采购方式', input.purchaseMethod],
    ['计划到货', input.expectedDeliveryAt],
    ['单号', input.requestCode],
    ['申请时间', input.createdAt],
    ['状态', input.statusLabel],
    ['处理结果', decisionLabel],
    ['处理人', resolution.actorName],
    ['处理时间', resolution.processedAt],
  ] as const;

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: resolution.decision === 'approve' ? 'green' : 'red',
      title: { tag: 'plain_text', content: '采购申请审批结果' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: fields.map(([label, value]) => ({
        tag: 'markdown',
        content: `**${label}**\n${escapeMarkdown(normalizeBusinessText(value))}`,
      })),
    },
  };
}

export function buildPurchaseApprovalCard(
  input: PurchaseApprovalCardInput,
): Record<string, unknown> {
  const executionRecordId = assertExecutionRecordId(input.executionRecordId);
  const fields = [
    ['申请人', input.requester],
    ['楼栋', input.building],
    ['物品', input.title],
    ['数量', quantityWithUnit(input.quantity, input.unit)],
    ['金额', input.amount],
    ['采购方式', input.purchaseMethod],
    ['计划到货', input.expectedDeliveryAt],
    ['单号', input.requestCode],
    ['申请时间', input.createdAt],
    ['状态', input.statusLabel],
  ] as const;

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
    },
    header: {
      template: 'purple',
      icon: { tag: 'standard_icon', token: 'approve_colorful' },
      title: { tag: 'plain_text', content: '采购管理---经理审批' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '待审批' },
          color: 'yellow',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements: [
        ...fields.map(([label, value]) => ({
          tag: 'markdown',
          content: `**${label}**\n${escapeMarkdown(normalizeBusinessText(value))}`,
        })),
        {
          tag: 'column_set',
          horizontal_spacing: '8px',
          columns: [
            actionColumn(
              '确认',
              'primary_filled',
              'approve',
              executionRecordId,
            ),
            actionColumn('驳回', 'danger', 'reject', executionRecordId),
          ],
        },
      ],
    },
  };
}

export function buildWarehouseInboundCard(
  record: PurchaseWorkflowRecord,
  publicBaseUrl: string,
): Record<string, unknown> {
  const inventoryUrl = buildInventoryInboundUrl(publicBaseUrl, record.recordId);
  const fields = [
    ['物品', record.itemName],
    [
      '实际到货数量',
      quantityWithUnit(
        record.actualQuantity ?? record.requestedQuantity,
        record.unit || '',
      ),
    ],
    ['申请人', record.requesterName],
    ['采购人', record.purchaserName],
    ['楼栋', record.building],
    ['签收人', record.signer],
    ['签收时间', record.receiptTime],
    ['单号', record.requestCode],
  ] as const;

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: '采购到货待入库' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: [
        ...fields.map(([label, value]) => ({
          tag: 'markdown',
          content: `**${label}**\n${escapeMarkdown(normalizeBusinessText(value))}`,
        })),
        {
          tag: 'button',
          type: 'primary',
          width: 'fill',
          text: { tag: 'plain_text', content: '打开库存管理并入库' },
          behaviors: [
            {
              type: 'open_url',
              default_url: inventoryUrl,
            },
          ],
        },
      ],
    },
  };
}

export function buildInventoryInboundCompletedCard(
  record: PurchaseWorkflowRecord,
  details?: { sku?: string; specification?: string; location?: string },
): Record<string, unknown> {
  const fields = [
    ['物品', record.itemName],
    ['类别号', details?.sku || record.sku],
    ['规格型号', details?.specification || record.specification],
    [
      '数量',
      quantityWithUnit(
        record.actualQuantity ?? record.requestedQuantity,
        record.unit || '',
      ),
    ],
    ['楼栋', record.building],
    ['存放位置', details?.location || record.location],
    ['采购单号', record.requestCode],
  ].filter(([, value]) => Boolean(value));

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '采购入库成功' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: fields.map(([label, value]) => ({
        tag: 'markdown',
        content: `**${label}**\n${escapeMarkdown(normalizeBusinessText(value))}`,
      })),
    },
  };
}

export function buildManualInventoryInboundCompletedCard(
  input: ManualInventoryInboundCompletedCardInput,
): Record<string, unknown> {
  const fields = [
    ['物品', input.name],
    ['类别号', input.sku],
    ['规格', input.specification],
    ['数量', quantityWithUnit(input.quantity, input.unit)],
    ['楼栋', input.building],
    ['存放位置', input.location],
    ['入库时间', input.occurredAt],
  ] as const;

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '手工入库成功' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements: fields.map(([label, value]) => ({
        tag: 'markdown',
        content: `**${label}**\n${escapeMarkdown(normalizeBusinessText(value))}`,
      })),
    },
  };
}

function actionColumn(
  label: string,
  type: 'primary_filled' | 'danger',
  action: PurchaseApprovalCardAction,
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
            value: { version: 1, action, executionRecordId },
          },
        ],
      },
    ],
  };
}

function quantityWithUnit(quantity: number | string, unit: string): string {
  const safeQuantity = normalizeBusinessText(quantity, 40);
  const safeUnit = normalizeBusinessText(unit, 40);
  if (safeQuantity === '未提供') return safeUnit;
  if (safeUnit === '未提供') return safeQuantity;
  return `${safeQuantity} ${safeUnit}`;
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
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
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
    .replace(/[\\`*_{}\[\]<>!|~]/g, '\\$&')
    .replace(/^[#>+\-]/, '\\$&');
}

function assertExecutionRecordId(value: unknown): string {
  if (typeof value !== 'string' || !RECORD_ID_PATTERN.test(value)) {
    throw new BadRequestException('采购执行记录标识无效');
  }
  return value;
}

function buildInventoryInboundUrl(
  publicBaseUrl: string,
  recordId: string,
): string {
  const base =
    typeof publicBaseUrl === 'string'
      ? publicBaseUrl.trim().replace(/\/+$/u, '')
      : '';
  if (!base) {
    throw new BadRequestException('PUBLIC_BASE_URL 未配置');
  }
  try {
    const parsed = new URL(base);
    const hostname = parsed.hostname.toLowerCase();
    const isLoopbackHttp =
      parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
    if (
      !(parsed.protocol === 'https:' || isLoopbackHttp) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      base.length > 2_000
    ) {
      throw new Error('invalid');
    }
  } catch {
    throw new BadRequestException('PUBLIC_BASE_URL 配置无效');
  }
  return `${base}/inventory-management?view=inbound&purchase=${encodeURIComponent(
    recordId,
  )}`;
}
