import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from 'node:zlib';
import { receiptMaterialRequirement } from './purchase-receipt-material-policy';

const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,128}$/u;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{8,160}$/u;
const TEXT_LIMIT = 200;
const CARD_ELEMENT_LIMIT = 200;
const CARD_BYTE_LIMIT = 30 * 1024;
const FORM_NAME_LIMIT = 100;
const PURCHASE_APPLICATION_BATCH_PREFIX = 'purchase-application-';
const COMPRESSED_SUBMIT_CONTEXT_LIMIT = 1024;

export type PurchaseBatchOrderState =
  | 'waiting'
  | 'processing'
  | 'completed'
  | 'manual_reconciliation';

export interface PurchaseBatchPurchaserCardItem {
  executionRecordId: string;
  title: string;
  specification: string;
  quantity: string;
  unit: string;
  amount: string | null;
  purchaseLinks?: string[];
  orderState: PurchaseBatchOrderState;
  actualQuantity: number | null;
  actualAmount: number | null;
  orderNote: string;
  orderedAt: string | null;
}

export interface PurchaseBatchPurchaserCardInput {
  approvalBatchId: string;
  purchaserOpenId: string;
  purchaserName: string;
  requesterName: string;
  building: string;
  requestCode: string;
  expectedDeliveryAt: string | null;
  items: PurchaseBatchPurchaserCardItem[];
}

export function buildPurchaseBatchPurchaserCard(
  inputValue: PurchaseBatchPurchaserCardInput,
  options: {
    selectedRecordId?: string;
    errorMessage?: string;
    paymentAttachmentUrl?: string;
  } = {},
): Record<string, unknown> {
  const input = canonicalizePurchaserInput(inputValue);
  const selected = options.selectedRecordId
    ? input.items.find(
        (item) => item.executionRecordId === options.selectedRecordId,
      )
    : undefined;
  if (
    options.selectedRecordId &&
    (!selected || selected.orderState !== 'waiting')
  ) {
    throw new BadRequestException('采购下单卡片明细不可编辑');
  }
  const waiting = input.items.filter(
    (item) => item.orderState === 'waiting',
  ).length;
  const processing = input.items.filter(item => item.orderState === 'processing').length;
  const manual = input.items.filter(item => item.orderState === 'manual_reconciliation').length;
  return {
    schema: '2.0',
    config: { update_multi: true, enable_forward: false },
    header: {
      template: processing > 0 ? 'yellow' : manual > 0 ? 'orange' : waiting > 0 ? 'blue' : 'green',
      title: { tag: 'plain_text', content: '采购任务待下单' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: {
            tag: 'plain_text',
            content: processing > 0 ? `${processing} 项同步中` : manual > 0 ? `${manual} 项需核对` : waiting > 0 ? `待处理 ${waiting} 项` : '已处理',
          },
          color: processing > 0 ? 'yellow' : manual > 0 ? 'orange' : waiting > 0 ? 'blue' : 'green',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 16px 12px',
      elements: selected
        ? [
            summary(input),
            ...(options.errorMessage
              ? [
                  markdown(
                    `<font color="red">${escapeMarkdown(options.errorMessage)}</font>`,
                  ),
                ]
              : []),
            ...purchaseLinkButtons(selected.purchaseLinks || []),
            ...(options.paymentAttachmentUrl
              ? [
                  openUrlButton(
                    '补充付款附件（可选）',
                    options.paymentAttachmentUrl,
                  ),
                ]
              : []),
            orderForm(input, selected),
            callbackButton('返回任务列表', {
              version: 4,
              workflowType: 'purchase_batch_fulfillment',
              role: 'purchaser',
              action: 'return_purchase_list',
              approvalBatchId: input.approvalBatchId,
              executionRecordId: selected.executionRecordId,
            }),
          ]
        : [
            summary(input),
            ...input.items.flatMap((item, index) => [
              { tag: 'hr' },
              markdown(
                `**${index + 1}. ${escapeMarkdown(item.title)}**\n规格：${escapeMarkdown(item.specification)}\n申请数量：${escapeMarkdown(item.quantity)} ${escapeMarkdown(item.unit)}${
                  item.amount
                    ? `\n申请金额：¥${escapeMarkdown(item.amount)}`
                    : ''
                }`,
              ),
              ...purchaseLinkButtons(item.purchaseLinks || []),
              item.orderState === 'waiting'
                ? callbackButton('填写下单结果', {
                    version: 4,
                    workflowType: 'purchase_batch_fulfillment',
                    role: 'purchaser',
                    action: 'open_order',
                    approvalBatchId: input.approvalBatchId,
                    executionRecordId: item.executionRecordId,
                  })
                : markdown(orderStateText(item)),
            ]),
          ],
    },
  };
}

export function buildPurchaseBatchTransferredCard(input: { building: string; requestCode: string }): Record<string, unknown> {
  return {
    schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: { template: 'grey', title: { tag: 'plain_text', content: '采购任务已转交' } },
    body: { elements: [markdown(`采购单：${escapeMarkdown(input.requestCode)}\n楼栋：${escapeMarkdown(input.building)}\n待办已转交`)] },
  };
}

export type PurchaseBatchReceiptState =
  | 'waiting'
  | 'processing'
  | 'completed'
  | 'manual_reconciliation';

export interface PurchaseBatchReceiptCardItem {
  executionRecordId: string;
  title: string;
  specification: string;
  requestedQuantity: string;
  actualQuantity: number;
  unit: string;
  requestedAmount: string | null;
  actualAmount: number;
  purchaserName: string;
  purchaseMethod?: string;
  receiptState: PurchaseBatchReceiptState;
  signerName: string;
  receiptTime: string | null;
  receiptPhotoCount: number;
  invoiceCount: number;
}

export interface PurchaseBatchReceiptCardInput {
  approvalBatchId: string;
  requesterOpenId: string;
  requesterName: string;
  building: string;
  requestCode: string;
  items: PurchaseBatchReceiptCardItem[];
}

export interface PurchaseBatchReceiptCompletedCardInput {
  requestCode: string;
  requesterName: string;
  building: string;
  itemTitle: string;
  purchaseMethod: string;
  purchaserName: string;
  signerName: string;
  receiptTime: string;
}

export function buildPurchaseBatchReceiptCompletedCard(
  inputValue: PurchaseBatchReceiptCompletedCardInput,
): Record<string, unknown> {
  const input = {
    requestCode: requiredText(inputValue.requestCode),
    requesterName: requiredText(inputValue.requesterName),
    building: requiredText(inputValue.building),
    itemTitle: requiredText(inputValue.itemTitle),
    purchaseMethod: requiredText(inputValue.purchaseMethod),
    purchaserName: requiredText(inputValue.purchaserName),
    signerName: requiredText(inputValue.signerName),
    receiptTime: requiredText(inputValue.receiptTime),
  };
  return {
    schema: '2.0',
    config: { update_multi: false, enable_forward: false },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '采购签收完成' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: { tag: 'plain_text', content: '已签收' },
          color: 'green',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 16px 12px',
      elements: [
        markdown(
          `**采购单号** ${escapeMarkdown(input.requestCode)}\n**申请楼栋** ${escapeMarkdown(input.building)}\n**申请人** ${escapeMarkdown(input.requesterName)}`,
        ),
        { tag: 'hr' },
        markdown(
          `**${escapeMarkdown(input.itemTitle)}**\n采购方式：${escapeMarkdown(input.purchaseMethod)}\n采购人：${escapeMarkdown(input.purchaserName)}\n签收人：${escapeMarkdown(input.signerName)}\n签收时间：${escapeMarkdown(input.receiptTime)}`,
        ),
      ],
    },
  };
}

export type PurchaseBatchFulfillmentCommandContext =
  | {
      version: 4;
      workflowType: 'purchase_batch_fulfillment';
      action: 'order';
      approvalBatchId: string;
      executionRecordId: string;
      actorOpenId: string;
      actualQuantity: number;
      actualAmount: number;
      note: string;
      paymentAttachmentTokens: string[];
    }
  | {
      version: 4;
      workflowType: 'purchase_batch_fulfillment';
      action: 'receipt';
      approvalBatchId: string;
      executionRecordId: string;
      actorOpenId: string;
      signerOpenId: string;
      receiptTime: number;
      note: string;
      receiptPhotoTokens: string[];
      invoiceTokens: string[];
    };

export type PurchaseBatchFulfillmentSubmitAction =
  | 'submit_order'
  | 'submit_receipt';

export interface PurchaseBatchFulfillmentSubmitContext {
  action: PurchaseBatchFulfillmentSubmitAction;
  approvalBatchId: string;
  executionRecordId: string;
}

export function purchaseBatchFulfillmentSubmitName(
  action: PurchaseBatchFulfillmentSubmitAction,
  approvalBatchId: string,
  executionRecordId: string,
): string {
  const legacyName =
    action === 'submit_order'
      ? `purchase_batch_order_submit:${approvalBatchId}:${executionRecordId}`
      : `purchase_batch_receipt_submit:${approvalBatchId}:${executionRecordId}`;
  if (legacyName.length <= FORM_NAME_LIMIT) return legacyName;

  const actionCode = action === 'submit_order' ? 'o' : 'r';
  if (approvalBatchId.startsWith(PURCHASE_APPLICATION_BATCH_PREFIX)) {
    const compactName = `${actionCode}:p:${approvalBatchId.slice(PURCHASE_APPLICATION_BATCH_PREFIX.length)}:${executionRecordId}`;
    if (compactName.length <= FORM_NAME_LIMIT) return compactName;
  }

  const compressed = brotliCompressSync(
    Buffer.from(JSON.stringify([approvalBatchId, executionRecordId]), 'utf8'),
    {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      },
    },
  ).toString('base64url');
  const compressedName = `${actionCode}:z:${compressed}`;
  if (compressedName.length > FORM_NAME_LIMIT) {
    throw new BadRequestException('采购履约卡片提交标识过长');
  }
  return compressedName;
}

export function parsePurchaseBatchFulfillmentSubmitName(
  value: string,
): PurchaseBatchFulfillmentSubmitContext | null {
  const legacy =
    /^purchase_batch_(order|receipt)_submit:([A-Za-z0-9_-]{8,160}):([A-Za-z0-9_-]{1,100})$/u.exec(
      value,
    );
  if (legacy) {
    return {
      action: legacy[1] === 'order' ? 'submit_order' : 'submit_receipt',
      approvalBatchId: legacy[2]!,
      executionRecordId: legacy[3]!,
    };
  }

  const compact =
    /^([or]):p:([A-Za-z0-9_-]{1,160}):([A-Za-z0-9_-]{1,100})$/u.exec(value);
  if (compact) {
    return validPurchaseBatchFulfillmentSubmitContext({
      action: compact[1] === 'o' ? 'submit_order' : 'submit_receipt',
      approvalBatchId: `${PURCHASE_APPLICATION_BATCH_PREFIX}${compact[2]}`,
      executionRecordId: compact[3]!,
    });
  }

  const encoded = /^([or]):z:([A-Za-z0-9_-]{1,96})$/u.exec(value);
  if (!encoded || value.length > FORM_NAME_LIMIT) return null;
  try {
    const decoded = JSON.parse(
      brotliDecompressSync(Buffer.from(encoded[2]!, 'base64url'), {
        maxOutputLength: COMPRESSED_SUBMIT_CONTEXT_LIMIT,
      }).toString('utf8'),
    ) as unknown;
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== 'string' ||
      typeof decoded[1] !== 'string'
    ) {
      return null;
    }
    return validPurchaseBatchFulfillmentSubmitContext({
      action: encoded[1] === 'o' ? 'submit_order' : 'submit_receipt',
      approvalBatchId: decoded[0],
      executionRecordId: decoded[1],
    });
  } catch {
    return null;
  }
}

export function serializePurchaseBatchFulfillmentCommandContext(
  value: PurchaseBatchFulfillmentCommandContext,
): string {
  return JSON.stringify(canonicalizeCommandContext(value));
}

export function parsePurchaseBatchFulfillmentCommandContext(
  value: string,
): PurchaseBatchFulfillmentCommandContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BadRequestException('采购卡片后台命令无效');
  }
  const canonical = canonicalizeCommandContext(
    parsed as PurchaseBatchFulfillmentCommandContext,
  );
  if (JSON.stringify(canonical) !== value) {
    throw new BadRequestException('采购卡片后台命令无效');
  }
  return canonical;
}

export function buildPurchaseBatchReceiptCard(
  inputValue: PurchaseBatchReceiptCardInput,
  options: {
    selectedRecordId?: string;
    signerName?: string;
    receiptTime?: string;
    errorMessage?: string;
  } = {},
): Record<string, unknown> {
  const input = canonicalizeReceiptInput(inputValue);
  const selected = options.selectedRecordId
    ? input.items.find(
        (item) => item.executionRecordId === options.selectedRecordId,
      )
    : undefined;
  if (
    options.selectedRecordId &&
    (!selected || selected.receiptState !== 'waiting')
  ) {
    throw new BadRequestException('采购签收卡片明细不可编辑');
  }
  const waiting = input.items.filter(
    (item) => item.receiptState === 'waiting',
  ).length;
  const processing = input.items.filter(item => item.receiptState === 'processing').length;
  const manual = input.items.filter(item => item.receiptState === 'manual_reconciliation').length;
  const card = {
    schema: '2.0',
    config: { update_multi: true, enable_forward: false },
    header: {
      template: processing > 0 ? 'yellow' : manual > 0 ? 'orange' : waiting > 0 ? 'turquoise' : 'green',
      title: { tag: 'plain_text', content: '采购到货待签收' },
      text_tag_list: [
        {
          tag: 'text_tag',
          text: {
            tag: 'plain_text',
            content: processing > 0 ? `${processing} 项同步中` : manual > 0 ? `${manual} 项需核对` : waiting > 0 ? `待签收 ${waiting} 项` : '签收完成',
          },
          color: processing > 0 ? 'yellow' : manual > 0 ? 'orange' : waiting > 0 ? 'turquoise' : 'green',
        },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 16px 12px',
      elements: selected
        ? [
            receiptSummary(input),
            receiptItemSummary(selected),
            ...(options.errorMessage
              ? [
                  markdown(
                    `<font color="red">${escapeMarkdown(options.errorMessage)}</font>`,
                  ),
                ]
              : []),
            markdown('点击下方按钮后，直接在当前会话发送图片。'),
            callbackButton('添加签收照片', {
              version: 4,
              workflowType: 'purchase_batch_fulfillment',
              role: 'requester',
              action: 'prepare_receipt_photo',
              approvalBatchId: input.approvalBatchId,
              executionRecordId: selected.executionRecordId,
            }),
            ...(receiptMaterialRequirement(selected.purchaseMethod)
              .requiresInvoice
              ? [
                  callbackButton('添加发票', {
                    version: 4,
                    workflowType: 'purchase_batch_fulfillment',
                    role: 'requester',
                    action: 'prepare_invoice',
                    approvalBatchId: input.approvalBatchId,
                    executionRecordId: selected.executionRecordId,
                  }),
                ]
              : []),
            receiptForm(
              input,
              selected,
              options.receiptTime || selected.receiptTime || undefined,
              1,
            ),
            callbackButton('返回签收列表', {
              version: 4,
              workflowType: 'purchase_batch_fulfillment',
              role: 'requester',
              action: 'return_receipt_list',
              approvalBatchId: input.approvalBatchId,
              executionRecordId: selected.executionRecordId,
            }),
          ]
        : [],
    },
  };
  if (selected) {
    if (receiptCardWithinLimits(card)) return card;
    throw new BadRequestException('采购签收卡片内容超出飞书限制');
  }

  const titleLimits = [TEXT_LIMIT, 160, 120, 80, 48, 24, 12, 1, 0];
  for (const titleLimit of titleLimits) {
    const compactCard = buildReceiptIndexCard(card, input, titleLimit);
    if (receiptCardWithinLimits(compactCard)) return compactCard;
  }
  throw new BadRequestException('采购签收卡片内容超出飞书限制');
}

function buildReceiptIndexCard(
  card: Record<string, unknown>,
  input: PurchaseBatchReceiptCardInput,
  titleLimit: number,
): Record<string, unknown> {
  return {
    ...card,
    body: {
      ...(card.body as Record<string, unknown>),
      elements: [
        receiptSummary(input),
        ...input.items.flatMap((item, index) => [
          receiptIndexTitle(item, index + 1, titleLimit),
          ...(item.receiptState === 'waiting'
            ? [
                callbackButton('填写签收信息', {
                  version: 4,
                  workflowType: 'purchase_batch_fulfillment',
                  role: 'requester',
                  action: 'open_receipt',
                  approvalBatchId: input.approvalBatchId,
                  executionRecordId: item.executionRecordId,
                }),
              ]
            : [terminalReceiptButton()]),
        ]),
      ],
    },
  };
}

function receiptCardWithinLimits(card: Record<string, unknown>): boolean {
  const body = card.body as { elements?: unknown } | undefined;
  return (
    countCardElements(body?.elements) <= CARD_ELEMENT_LIMIT &&
    Buffer.byteLength(JSON.stringify(card), 'utf8') <= CARD_BYTE_LIMIT
  );
}

function countCardElements(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce((count, element) => {
    if (!element || typeof element !== 'object' || Array.isArray(element)) {
      return count;
    }
    return (
      count +
      1 +
      countCardElements((element as Record<string, unknown>).elements)
    );
  }, 0);
}

function canonicalizePurchaserInput(
  value: PurchaseBatchPurchaserCardInput,
): PurchaseBatchPurchaserCardInput {
  if (
    !value ||
    !BATCH_ID_PATTERN.test(value.approvalBatchId) ||
    !OPEN_ID_PATTERN.test(value.purchaserOpenId) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 20
  ) {
    throw new BadRequestException('采购下单卡片数据无效');
  }
  const seen = new Set<string>();
  const items = value.items.map((item) => {
    if (
      !RECORD_ID_PATTERN.test(item.executionRecordId) ||
      seen.has(item.executionRecordId)
    ) {
      throw new BadRequestException('采购下单卡片明细无效');
    }
    seen.add(item.executionRecordId);
    return {
      ...item,
      title: requiredText(item.title),
      specification: requiredText(item.specification),
      quantity: requiredText(item.quantity),
      unit: requiredText(item.unit),
      amount: item.amount === null ? null : requiredText(item.amount),
      purchaseLinks: canonicalPurchaseLinks(item.purchaseLinks),
      actualQuantity:
        item.actualQuantity === null
          ? null
          : finiteNonNegative(item.actualQuantity),
      actualAmount:
        item.actualAmount === null
          ? null
          : finiteNonNegative(item.actualAmount),
      orderNote: optionalText(item.orderNote),
      orderedAt: item.orderedAt === null ? null : requiredText(item.orderedAt),
    };
  });
  return {
    ...value,
    purchaserName: requiredText(value.purchaserName || value.purchaserOpenId),
    requesterName: requiredText(value.requesterName),
    building: requiredText(value.building),
    requestCode: requiredText(value.requestCode),
    expectedDeliveryAt:
      value.expectedDeliveryAt === null
        ? null
        : requiredText(value.expectedDeliveryAt),
    items,
  };
}

function canonicalizeReceiptInput(
  value: PurchaseBatchReceiptCardInput,
): PurchaseBatchReceiptCardInput {
  if (
    !value ||
    !BATCH_ID_PATTERN.test(value.approvalBatchId) ||
    !OPEN_ID_PATTERN.test(value.requesterOpenId) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 20
  ) {
    throw new BadRequestException('采购签收卡片数据无效');
  }
  const seen = new Set<string>();
  return {
    ...value,
    requesterName: requiredText(value.requesterName),
    building: requiredText(value.building),
    requestCode: requiredText(value.requestCode),
    items: value.items.map((item) => {
      if (
        !RECORD_ID_PATTERN.test(item.executionRecordId) ||
        seen.has(item.executionRecordId)
      ) {
        throw new BadRequestException('采购签收卡片明细无效');
      }
      seen.add(item.executionRecordId);
      return {
        ...item,
        title: requiredText(item.title),
        specification: requiredText(item.specification),
        requestedQuantity: requiredText(item.requestedQuantity),
        actualQuantity: finitePositive(item.actualQuantity),
        unit: requiredText(item.unit),
        requestedAmount:
          item.requestedAmount === null
            ? null
            : requiredText(item.requestedAmount),
        actualAmount: finiteNonNegative(item.actualAmount),
        purchaserName: requiredText(item.purchaserName),
        purchaseMethod: optionalText(item.purchaseMethod),
        signerName: optionalText(item.signerName),
        receiptTime:
          item.receiptTime === null ? null : requiredText(item.receiptTime),
        receiptPhotoCount: safeCount(item.receiptPhotoCount),
        invoiceCount: safeCount(item.invoiceCount),
      };
    }),
  };
}

function summary(
  input: PurchaseBatchPurchaserCardInput,
): Record<string, unknown> {
  return markdown(
    `**采购单号**  ${escapeMarkdown(input.requestCode)}\n**申请人**  ${escapeMarkdown(input.requesterName)}\n**申请楼栋**  ${escapeMarkdown(input.building)}${
      input.expectedDeliveryAt
        ? `\n**计划到货**  ${escapeMarkdown(input.expectedDeliveryAt)}`
        : ''
    }`,
  );
}

function receiptSummary(
  input: PurchaseBatchReceiptCardInput,
): Record<string, unknown> {
  return markdown(
    `**采购单号**  ${escapeMarkdown(input.requestCode)}\n**申请人**  ${escapeMarkdown(input.requesterName)}\n**申请楼栋**  ${escapeMarkdown(input.building)}`,
  );
}

function receiptItemSummary(
  item: PurchaseBatchReceiptCardItem,
  index?: number,
): Record<string, unknown> {
  const title = index === undefined ? item.title : `${index}. ${item.title}`;
  return markdown(
    `**${escapeMarkdown(title)}**\n规格：${escapeMarkdown(item.specification)}\n实际采购：${item.actualQuantity} ${escapeMarkdown(item.unit)}\n实际付款：¥${item.actualAmount.toFixed(2)}\n采购方式：${escapeMarkdown(item.purchaseMethod || '未注明')}\n采购人：${escapeMarkdown(item.purchaserName)}`,
  );
}

function receiptIndexTitle(
  item: PurchaseBatchReceiptCardItem,
  index: number,
  titleLimit = TEXT_LIMIT,
): Record<string, unknown> {
  return markdown(
    `**${index}. ${escapeMarkdown(compactReceiptIndexTitle(item.title, titleLimit))}**`,
  );
}

function compactReceiptIndexTitle(value: string, limit: number): string {
  if (limit <= 0) return '查看物品详情';
  const codePoints = Array.from(value);
  if (codePoints.length <= limit) return value;
  if (limit === 1) return '…';
  return `${codePoints.slice(0, limit - 1).join('')}…`;
}

function purchaseLinkButtons(links: string[]): Record<string, unknown>[] {
  return links.map((url, index) =>
    openUrlButton(
      links.length === 1 ? '打开采购链接' : `打开采购链接 ${index + 1}`,
      url,
    ),
  );
}

function orderForm(
  input: PurchaseBatchPurchaserCardInput,
  item: PurchaseBatchPurchaserCardItem,
): Record<string, unknown> {
  return {
    tag: 'form',
    name: 'purchase_batch_order_form',
    direction: 'vertical',
    vertical_spacing: '12px',
    elements: [
      markdown(
        `**${escapeMarkdown(item.title)}**\n${escapeMarkdown(item.specification)}`,
      ),
      textInput(
        'actual_quantity',
        '实际采购数量',
        String(item.actualQuantity ?? ''),
      ),
      textInput(
        'actual_amount',
        '实际付款金额',
        String(item.actualAmount ?? ''),
      ),
      textInput('order_note', '采购备注', item.orderNote, true, false),
      formSubmitButton(
        purchaseBatchFulfillmentSubmitName(
          'submit_order',
          input.approvalBatchId,
          item.executionRecordId,
        ),
        '提交下单结果',
      ),
    ],
  };
}

function receiptForm(
  input: PurchaseBatchReceiptCardInput,
  item: PurchaseBatchReceiptCardItem,
  receiptTime: string | undefined,
  index: number,
): Record<string, unknown> {
  const requirement = receiptMaterialRequirement(item.purchaseMethod);
  const photosReady = item.receiptPhotoCount > 0;
  const invoiceReady = !requirement.requiresInvoice || item.invoiceCount > 0;
  const materialsReady = photosReady && invoiceReady;
  const missingMaterials = [
    ...(!photosReady ? ['签收照片'] : []),
    ...(!invoiceReady ? ['发票'] : []),
  ];
  const signerField = purchaseBatchReceiptFieldName(
    'signer_open_id',
    item.executionRecordId,
  );
  const timeField = purchaseBatchReceiptFieldName(
    'receipt_time',
    item.executionRecordId,
  );
  const noteField = purchaseBatchReceiptFieldName(
    'receipt_note',
    item.executionRecordId,
  );
  return {
    tag: 'form',
    name: `purchase_batch_receipt_form_${index}`,
    direction: 'vertical',
    vertical_spacing: '12px',
    elements: [
      markdown('**签收人（必选）**'),
      personSelect(signerField, input.requesterOpenId),
      textInput(
        timeField,
        '签收时间',
        receiptTime || formatChinaDateTime(Date.now()),
      ),
      textInput(noteField, '签收备注', '', true, false),
      markdown(
        requirement.requiresInvoice
          ? `签收照片：${item.receiptPhotoCount} 个（必填）\n发票：${item.invoiceCount} 个（必填）`
          : `签收照片：${item.receiptPhotoCount} 个（必填）\n发票：无需上传`,
      ),
      ...(!materialsReady
        ? [
            markdown(
              `<font color="orange">请先上传${missingMaterials.join('、')}，再提交签收。</font>`,
            ),
          ]
        : []),
      formSubmitButton(
        purchaseBatchFulfillmentSubmitName(
          'submit_receipt',
          input.approvalBatchId,
          item.executionRecordId,
        ),
        materialsReady ? '确认签收' : `${missingMaterials.join('、')}未上传`,
        !materialsReady,
      ),
    ],
  };
}

export function purchaseBatchReceiptFieldName(
  base: 'signer_open_id' | 'receipt_time' | 'receipt_note',
  executionRecordId: string,
): string {
  const suffix = createHash('sha256')
    .update(executionRecordId)
    .digest('hex')
    .slice(0, 16);
  return `${base}_${suffix}`;
}

function validPurchaseBatchFulfillmentSubmitContext(
  value: PurchaseBatchFulfillmentSubmitContext,
): PurchaseBatchFulfillmentSubmitContext | null {
  return BATCH_ID_PATTERN.test(value.approvalBatchId) &&
    RECORD_ID_PATTERN.test(value.executionRecordId)
    ? value
    : null;
}

function textInput(
  name: string,
  label: string,
  defaultValue: string,
  multiline = false,
  required = true,
): Record<string, unknown> {
  return {
    tag: 'input',
    name,
    required,
    input_type: multiline ? 'multiline_text' : 'text',
    ...(multiline ? { rows: 3 } : {}),
    max_length: multiline ? 500 : 80,
    width: 'fill',
    label: { tag: 'plain_text', content: label },
    ...(defaultValue ? { default_value: defaultValue } : {}),
  };
}

function personSelect(
  name: string,
  initialOpenId: string,
): Record<string, unknown> {
  return {
    tag: 'select_person',
    name,
    required: true,
    type: 'default',
    width: 'fill',
    placeholder: { tag: 'plain_text', content: '请选择签收人' },
    initial_option: initialOpenId,
    options: [{ value: initialOpenId }],
  };
}

function formSubmitButton(
  submitName: string,
  submitLabel: string,
  disabled = false,
): Record<string, unknown> {
  return {
    tag: 'button',
    name: submitName,
    type: 'primary_filled',
    width: 'fill',
    disabled,
    form_action_type: 'submit',
    text: { tag: 'plain_text', content: submitLabel },
  };
}

function terminalReceiptElements(
  item: PurchaseBatchReceiptCardItem,
): Record<string, unknown>[] {
  return [markdown(receiptStateText(item)), terminalReceiptButton()];
}

function terminalReceiptButton(): Record<string, unknown> {
  return {
    tag: 'button',
    type: 'primary_filled',
    width: 'fill',
    disabled: true,
    text: { tag: 'plain_text', content: '确认签收' },
  };
}

function openUrlButton(label: string, url: string): Record<string, unknown> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestException('采购附件入口地址无效');
  }
  if (parsed.protocol !== 'https:') {
    throw new BadRequestException('采购附件入口必须使用 HTTPS');
  }
  return {
    tag: 'button',
    type: 'default',
    width: 'fill',
    text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'open_url', default_url: parsed.toString() }],
  };
}

function canonicalPurchaseLinks(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) {
    throw new BadRequestException('采购链接无效');
  }
  const links: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length > 600) {
      throw new BadRequestException('采购链接无效');
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new BadRequestException('采购链接无效');
    }
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('采购链接必须使用 HTTPS');
    }
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    links.push(url);
  }
  return links;
}

function requiredText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  if (!text || Array.from(text).length > TEXT_LIMIT) {
    throw new BadRequestException('采购下单卡片文本无效');
  }
  return text;
}

function callbackButton(
  label: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tag: 'button',
    type: 'primary',
    width: 'fill',
    text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value }],
  };
}

function markdown(content: string): Record<string, unknown> {
  return { tag: 'markdown', content };
}

function orderStateText(item: PurchaseBatchPurchaserCardItem): string {
  if (item.orderState === 'processing')
    return '<font color="grey">下单结果同步中</font>';
  if (item.orderState === 'completed') {
    return `<font color="green">已下单 · ${item.actualQuantity ?? '-'} ${escapeMarkdown(item.unit)} · ¥${(item.actualAmount ?? 0).toFixed(2)}</font>`;
  }
  return '<font color="orange">同步结果需人工核对</font>';
}

function receiptStateText(item: PurchaseBatchReceiptCardItem): string {
  if (item.receiptState === 'processing')
    return '<font color="grey">签收结果同步中</font>';
  if (item.receiptState === 'completed') {
    return `<font color="green">已签收 · ${escapeMarkdown(item.signerName || '-')} · ${escapeMarkdown(item.receiptTime || '-')}</font>`;
  }
  return '<font color="orange">签收结果需人工核对</font>';
}

function optionalText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  if (Array.from(text).length > 500) {
    throw new BadRequestException('采购卡片备注过长');
  }
  return text;
}

function finitePositive(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new BadRequestException('采购卡片数量无效');
  }
  return number;
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new BadRequestException('采购卡片金额无效');
  }
  return number;
}

function safeCount(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 10) {
    throw new BadRequestException('采购附件数量无效');
  }
  return number;
}

function formatChinaDateTime(value: number): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(
    /[&*~><[\]()#:_\\`{}!|+-]/gu,
    (character) => `&#${character.codePointAt(0)};`,
  );
}

function canonicalizeCommandContext(
  value: PurchaseBatchFulfillmentCommandContext,
): PurchaseBatchFulfillmentCommandContext {
  if (
    !value ||
    value.version !== 4 ||
    value.workflowType !== 'purchase_batch_fulfillment' ||
    !BATCH_ID_PATTERN.test(value.approvalBatchId) ||
    !RECORD_ID_PATTERN.test(value.executionRecordId) ||
    !OPEN_ID_PATTERN.test(value.actorOpenId)
  ) {
    throw new BadRequestException('采购卡片后台命令无效');
  }
  if (value.action === 'order') {
    assertExactKeys(value, [
      'action',
      'actorOpenId',
      'actualAmount',
      'actualQuantity',
      'approvalBatchId',
      'executionRecordId',
      'note',
      'paymentAttachmentTokens',
      'version',
      'workflowType',
    ]);
    return {
      version: 4,
      workflowType: 'purchase_batch_fulfillment',
      action: 'order',
      approvalBatchId: value.approvalBatchId,
      executionRecordId: value.executionRecordId,
      actorOpenId: value.actorOpenId,
      actualQuantity: finitePositive(value.actualQuantity),
      actualAmount: finiteNonNegative(value.actualAmount),
      note: optionalText(value.note),
      paymentAttachmentTokens: attachmentTokens(value.paymentAttachmentTokens),
    };
  }
  if (value.action === 'receipt') {
    assertExactKeys(value, [
      'action',
      'actorOpenId',
      'approvalBatchId',
      'executionRecordId',
      'invoiceTokens',
      'note',
      'receiptPhotoTokens',
      'receiptTime',
      'signerOpenId',
      'version',
      'workflowType',
    ]);
    const receiptTime = Number(value.receiptTime);
    if (!Number.isSafeInteger(receiptTime) || receiptTime <= 0) {
      throw new BadRequestException('签收时间无效');
    }
    const receiptPhotoTokens = attachmentTokens(value.receiptPhotoTokens);
    if (!receiptPhotoTokens.length) {
      throw new BadRequestException('请先上传签收照片');
    }
    return {
      version: 4,
      workflowType: 'purchase_batch_fulfillment',
      action: 'receipt',
      approvalBatchId: value.approvalBatchId,
      executionRecordId: value.executionRecordId,
      actorOpenId: value.actorOpenId,
      signerOpenId: validOpenId(value.signerOpenId),
      receiptTime,
      note: optionalText(value.note),
      receiptPhotoTokens,
      invoiceTokens: attachmentTokens(value.invoiceTokens),
    };
  }
  throw new BadRequestException('采购卡片后台命令无效');
}

function assertExactKeys(value: object, expected: string[]): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new BadRequestException('采购卡片后台命令包含未知字段');
  }
}

function attachmentTokens(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5) {
    throw new BadRequestException('采购附件令牌无效');
  }
  const tokens = value.map((entry) =>
    typeof entry === 'string' ? entry.trim() : '',
  );
  if (tokens.some((token) => !/^[A-Za-z0-9_-]{1,256}$/u.test(token))) {
    throw new BadRequestException('采购附件令牌无效');
  }
  return [...new Set(tokens)];
}

function validOpenId(value: unknown): string {
  const openId = typeof value === 'string' ? value.trim() : '';
  if (!OPEN_ID_PATTERN.test(openId)) {
    throw new BadRequestException('签收人标识无效');
  }
  return openId;
}
