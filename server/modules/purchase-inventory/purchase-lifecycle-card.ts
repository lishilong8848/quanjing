import type { PurchaseWorkflowStage } from '../../../shared/purchase-workflow.interface';
import type { PurchaseLifecycleAction, PurchaseLifecycleOverallProgress, PurchaseLifecycleProjectedItem } from './purchase-lifecycle-projection';
import { isBuildingSelfPurchaseAllowed } from './purchase-procurement-method-policy';
import { paginatePurchaseLifecycleCard, selectPurchaseLifecycleCardPage, type PurchaseLifecycleCardPage } from './purchase-lifecycle-pagination';
import { purchaseLifecycleAttachmentLink, purchaseLifecycleInboundLink } from './purchase-lifecycle-attachment-link';
import { purchaseLifecyclePaymentUploadLink } from './purchase-lifecycle-payment-upload-link';

/** The caller must first establish the recipient, stage grants and message binding. */
export type PurchaseLifecycleCallbackResolver = (
  recordId: string,
  action: PurchaseLifecycleAction,
) => Record<string, unknown> | undefined;
export type PurchaseLifecycleManagerAction =
  | 'open_item_reject'
  | 'approve_item_comprehensive'
  | 'approve_item_building_self'
  | 'approve_pending_comprehensive'
  | 'approve_pending_building_self';
export type PurchaseLifecycleManagerCallbackResolver = (
  action: PurchaseLifecycleManagerAction,
  recordId?: string,
) => Record<string, unknown> | undefined;

/** Construct only on the server from the current complete batch and authorization. */
export interface PurchaseLifecycleBatchApprovalProof {
  pendingRecordIds: readonly string[];
  authorizedPendingRecordIds: readonly string[];
  building: string;
}

const STAGES: Record<PurchaseWorkflowStage, string> = {
  application: '申请', approval: '审批', ordering: '下单', receipt: '签收',
  inbound: '入库', completed: '已完成', terminated: '已终止', unknown: '状态待核对',
};
const PROGRESS_LABEL: Record<PurchaseLifecycleOverallProgress, string> = {
  pending_approval: '待审批', pending_warehouse: '待库房确认', pending_order: '待下单',
  ordered: '已下单 · 待签收', received: '已签收 · 待入库', inbounded: '已入库',
  terminated: '已结束', unknown: '状态待核对',
};
const PRIVATE_FIELD = /令牌|(?:token|image.?key|file.?key|url)/iu;
const LINK_OR_TOKEN = /(?:\b(?:https?|ftp|javascript):|(?:^|\s)www\.|\b(?:img_|file_|boxcn)[a-z0-9_-]+)/iu;
const ID = /^[A-Za-z0-9_-]{1,100}$/u;
const BATCH_ID = /^[A-Za-z0-9_-]{8,160}$/u;
const IMAGE_KEY = /^img_[A-Za-z0-9_-]{1,200}$/u;
const VALUE_KEYS = ['version', 'workflowType', 'role', 'action', 'approvalBatchId', 'executionRecordId'];

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000) throw new Error('采购卡片文本无效');
  return value;
}

function safeCallback(value: Record<string, unknown> | undefined, batchId: string, recordId: string, action: PurchaseLifecycleAction): Record<string, unknown> | undefined {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== VALUE_KEYS.length || VALUE_KEYS.some(key => !Object.hasOwn(value, key))) return undefined;
  const expected = action === 'order' ? ['purchaser', 'open_order'] : action === 'receive' ? ['requester', 'open_receipt'] : undefined;
  if (!expected || value.version !== 4 || value.workflowType !== 'purchase_batch_fulfillment' || value.role !== expected[0] || value.action !== expected[1] || value.executionRecordId !== recordId || value.approvalBatchId !== batchId) return undefined;
  return { version: 4, workflowType: 'purchase_batch_fulfillment', role: expected[0], action: expected[1], approvalBatchId: batchId, executionRecordId: recordId };
}

function safeManagerCallback(
  value: Record<string, unknown> | undefined,
  batchId: string,
  action: PurchaseLifecycleManagerAction,
  recordId?: string,
): Record<string, unknown> | undefined {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const individual = action === 'open_item_reject' || action === 'approve_item_comprehensive' || action === 'approve_item_building_self';
  const keys = individual ? ['version', 'action', 'approvalBatchId', 'executionRecordId'] : ['version', 'action', 'approvalBatchId'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) ||
    value.version !== 3 || value.action !== action || value.approvalBatchId !== batchId ||
    (individual && (!recordId || value.executionRecordId !== recordId))) return undefined;
  return { version: 3, action, approvalBatchId: batchId, ...(individual ? { executionRecordId: recordId } : {}) };
}

export function canApproveWholeBatch(items: ReadonlyArray<PurchaseLifecycleProjectedItem>, proof?: PurchaseLifecycleBatchApprovalProof): boolean {
  if (!proof || !Array.isArray(proof.pendingRecordIds) || !Array.isArray(proof.authorizedPendingRecordIds) ||
    typeof proof.building !== 'string' || !proof.building.trim() || proof.building.length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(proof.building) || !proof.pendingRecordIds.length || proof.pendingRecordIds.length > 20) return false;
  const pending = new Set(proof.pendingRecordIds), authorized = new Set(proof.authorizedPendingRecordIds);
  if (pending.size !== proof.pendingRecordIds.length || authorized.size !== proof.authorizedPendingRecordIds.length ||
    pending.size !== authorized.size || [...pending].some(id => typeof id !== 'string' || !ID.test(id) || !authorized.has(id))) return false;
  const allowed = new Set(items.filter(item => item.currentStage === 'application' && item.actions.includes('approve')).map(item => item.recordId));
  return [...pending].every(id => allowed.has(id)) && [...allowed].every(id => pending.has(id));
}

export interface PurchaseLifecycleCardInput {
  approvalBatchId: string;
  cardRevision: number;
  continued?: boolean;
  attachmentBaseUrl?: string;
  generation?: number;
  /** Trusted synchronous capability from the actual upload runtime, never an env flag. */
  paymentUploadReady?: () => boolean;
  items: ReadonlyArray<PurchaseLifecycleProjectedItem>;
  observer: boolean;
  resolveCallback?: PurchaseLifecycleCallbackResolver;
  /** Pending ids must be the complete authoritative set, not the filtered card view. */
  batchApprovalProof?: PurchaseLifecycleBatchApprovalProof;
  resolveManagerCallback?: PurchaseLifecycleManagerCallbackResolver;
}

function splitText(value: string): string[] {
  const chunks: string[] = []; let current = '', bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > 6000 && current) { chunks.push(current); current = ''; bytes = 0; }
    current += character; bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Internal elements are always derived from a projection, never a raw record. */
function buildContent(input: PurchaseLifecycleCardInput): Record<string, unknown> {
  if (typeof input.approvalBatchId !== 'string' || !BATCH_ID.test(input.approvalBatchId)) throw new Error('采购卡片批次标识无效');
  if (!Number.isSafeInteger(input.cardRevision) || input.cardRevision < 1) throw new Error('采购卡片版本无效');
  const elements: Record<string, unknown>[] = [];
  const seenImages = new Map<string, number>();
  const seenItems = new Set<string>();
  let paymentReady = false;
  if (!input.observer && input.items.some(item => item.currentStage === 'ordering' && item.actions.includes('order'))) {
    try { const ready: unknown = input.paymentUploadReady?.(); if (ready instanceof Promise) void ready.catch(() => undefined); paymentReady = ready === true; } catch { /* unavailable capabilities expose no write entry */ }
  }
  if (input.observer) elements.push({ tag: 'div', text: { tag: 'plain_text', content: '只读抄送 · 不可操作' } });
  for (const [index, item] of input.items.entries()) {
    if (!ID.test(item.recordId)) throw new Error('采购卡片记录标识无效');
    if (seenItems.has(item.recordId)) throw new Error('采购卡片明细重复');
    seenItems.add(item.recordId);
    if (item.currentStage !== null && !Object.hasOwn(STAGES, item.currentStage)) throw new Error('采购卡片阶段无效');
    const lines = [`${index + 1}. ${item.currentStage === null ? '采购记录' : STAGES[item.currentStage]}`];
    if (item.overallProgress !== undefined) {
      if (!Object.hasOwn(PROGRESS_LABEL, item.overallProgress)) throw new Error('采购卡片进度无效');
      lines.push(`总体进度：${PROGRESS_LABEL[item.overallProgress]}`);
    }
    const images: Record<string, unknown>[] = [];
    const attachmentButtons: Record<string, unknown>[] = [];
    for (const stage of item.stages) {
      if (!Object.hasOwn(STAGES, stage.stage)) throw new Error('采购卡片阶段无效');
      const fields = stage.fields.flatMap(field => {
        const label = text(field.label), value = text(field.value);
        return PRIVATE_FIELD.test(label) || LINK_OR_TOKEN.test(value) ? [] : [`${label}：${value}`];
      });
      const imageDescriptions: string[] = [];
      for (const image of stage.images || []) {
        if (!IMAGE_KEY.test(image.imageKey)) throw new Error('采购卡片图片标识无效');
        const alt = text(image.alt);
        if (LINK_OR_TOKEN.test(alt)) throw new Error('采购卡片图片说明无效');
        let number = seenImages.get(image.imageKey);
        if (number === undefined) {
          number = seenImages.size + 1;
          seenImages.set(image.imageKey, number);
          images.push({ tag: 'img', img_key: image.imageKey, alt: { tag: 'plain_text', content: `图片${number}${alt ? `：${alt}` : ''}` } });
        }
        imageDescriptions.push(String(number));
      }
      if (fields.length || imageDescriptions.length) lines.push(`${STAGES[stage.stage]}\n${[...fields, ...(imageDescriptions.length ? [`相关图片序号：${[...new Set(imageDescriptions)].join('、')}`] : [])].join('\n')}`);
      for (const attachment of stage.attachments || []) {
        const expectedStage = attachment.purpose === 'comparison' ? 'application' : attachment.purpose === 'payment' ? 'ordering' : 'receipt';
        if (stage.stage !== expectedStage || !input.attachmentBaseUrl || !input.generation) throw new Error('采购附件查看入口未就绪');
        const url = purchaseLifecycleAttachmentLink(input.attachmentBaseUrl, input.approvalBatchId, item.recordId, input.generation, attachment.purpose, attachment.index);
        const labels = { comparison: '比价附件', payment: '付款附件', receipt: '签收附件', invoice: '发票附件' };
        attachmentButtons.push({ tag: 'button', type: 'default', width: 'fill', text: { tag: 'plain_text', content: `${labels[attachment.purpose]} ${attachment.index + 1}` }, behaviors: [{ type: 'open_url', default_url: url }] });
      }
    }
    elements.push(...splitText(lines.join('\n')).map(content => ({ tag: 'div', text: { tag: 'plain_text', content } })), ...images, ...attachmentButtons);
    if (paymentReady && !input.observer && item.currentStage === 'ordering' && item.actions.includes('order')) {
      if (!input.attachmentBaseUrl || !input.generation) throw new Error('采购付款上传入口未就绪');
      const url = purchaseLifecyclePaymentUploadLink(input.attachmentBaseUrl, input.approvalBatchId, item.recordId, input.generation);
      elements.push({ tag: 'button', type: 'default', width: 'fill', text: { tag: 'plain_text', content: '上传付款附件' }, behaviors: [{ type: 'open_url', default_url: url }] });
    }
    if (!input.observer && item.currentStage === 'inbound' && item.actions.includes('inbound')) {
      if (!input.attachmentBaseUrl) throw new Error('采购入库入口未就绪');
      const url = purchaseLifecycleInboundLink(input.attachmentBaseUrl, item.recordId);
      elements.push({ tag: 'button', type: 'primary', width: 'fill', text: { tag: 'plain_text', content: '打开库存管理并入库' }, behaviors: [{ type: 'open_url', default_url: url }] });
    }
    if (!input.observer && input.resolveManagerCallback && item.currentStage === 'application' && item.actions.includes('approve')) {
      for (const action of ['approve_item_comprehensive', 'approve_item_building_self'] as const) {
        if (action === 'approve_item_building_self' && (!input.batchApprovalProof || !isBuildingSelfPurchaseAllowed(input.batchApprovalProof.building))) continue;
        const resolved = safeManagerCallback(input.resolveManagerCallback(action, item.recordId), input.approvalBatchId, action, item.recordId);
        const callback = resolved && { ...resolved, flowVersion: 'lifecycle_v1', cardRevision: input.cardRevision };
        if (callback) elements.push({ tag: 'button', type: 'primary', width: 'fill', text: { tag: 'plain_text', content: action === 'approve_item_comprehensive' ? '同意此项综合采购' : '同意此项楼内自采' }, behaviors: [{ type: 'callback', value: callback }] });
      }
      const resolved = safeManagerCallback(input.resolveManagerCallback('open_item_reject', item.recordId), input.approvalBatchId, 'open_item_reject', item.recordId);
      const callback = resolved && { ...resolved, flowVersion: 'lifecycle_v1', cardRevision: input.cardRevision };
      if (callback) elements.push({ tag: 'button', type: 'danger', width: 'fill', text: { tag: 'plain_text', content: '驳回此项' }, behaviors: [{ type: 'callback', value: callback }] });
    }
    if (!input.observer && input.resolveCallback) {
      for (const action of new Set(item.actions)) {
        if ((action !== 'order' || item.currentStage !== 'ordering') && (action !== 'receive' || item.currentStage !== 'receipt')) continue;
        const resolved = safeCallback(input.resolveCallback(item.recordId, action), input.approvalBatchId, item.recordId, action);
        const callback = resolved && { ...resolved, flowVersion: 'lifecycle_v1', cardRevision: input.cardRevision };
        if (!callback) continue;
        elements.push({ tag: 'button', type: 'primary', width: 'fill', text: { tag: 'plain_text', content: action === 'order' ? '填写下单结果' : '填写签收信息' }, behaviors: [{ type: 'callback', value: callback }] });
      }
    }
  }
  if (!input.observer && input.resolveManagerCallback && canApproveWholeBatch(input.items, input.batchApprovalProof)) {
    for (const action of ['approve_pending_comprehensive', 'approve_pending_building_self'] as const) {
      if (action === 'approve_pending_building_self' && !isBuildingSelfPurchaseAllowed(input.batchApprovalProof!.building)) continue;
      const resolved = safeManagerCallback(input.resolveManagerCallback(action), input.approvalBatchId, action);
      const callback = resolved && { ...resolved, flowVersion: 'lifecycle_v1', cardRevision: input.cardRevision };
      if (callback) elements.push({ tag: 'button', type: action === 'approve_pending_comprehensive' ? 'primary_filled' : 'default', width: 'fill', text: { tag: 'plain_text', content: action === 'approve_pending_comprehensive' ? '全部综合采购' : '全部楼内自采' }, behaviors: [{ type: 'callback', value: callback }] });
    }
  }
  if (!elements.length) elements.push({ tag: 'div', text: { tag: 'plain_text', content: '暂无可查看的采购内容' } });
  return { schema: '2.0', config: { update_multi: true, enable_forward: false }, header: { title: { tag: 'plain_text', content: input.continued === true ? '采购全流程 · 延续卡' : '采购全流程' }, template: 'blue' }, body: { elements } };
}

/** Original single-card API continues to reject over-limit payloads. */
export function buildPurchaseLifecycleCard(input: PurchaseLifecycleCardInput): Record<string, unknown> {
  const card = buildContent(input);
  const elements = (card.body as { elements: Record<string, unknown>[] }).elements;
  if (elements.length > 200) throw new Error('采购卡片组件数量超限，需要分页处理');
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > 30 * 1024) throw new Error('采购卡片超过飞书 30KB 限制，需要分页处理');
  return card;
}

/** Offline page construction only; dispatch requires separately authenticated navigation. */
export function buildPurchaseLifecycleCardPage(input: PurchaseLifecycleCardInput, requested: unknown): PurchaseLifecycleCardPage<Record<string, unknown>> {
  if (input.items.length > 20) throw new Error('采购卡片明细数量超限');
  const card = buildContent(input);
  const body = card.body as { elements: Record<string, unknown>[] };
  if (body.elements.length > 2000) throw new Error('采购卡片内容数量超限');
  const shell = { ...card, body: { elements: [] } };
  const pages = paginatePurchaseLifecycleCard({ elements: body.elements, shell, reservedBytes: 4096, reservedComponents: 12 });
  const selected = selectPurchaseLifecycleCardPage(pages, requested);
  if (selected.pageInfo.totalPages > 1) {
    const elements = (selected.card.body as { elements: Record<string, unknown>[] }).elements;
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: `第 ${selected.pageInfo.page}/${selected.pageInfo.totalPages} 页` } });
    for (const [label, page] of [['上一页', selected.pageInfo.page - 1], ['下一页', selected.pageInfo.page + 1]] as const) {
      if (page < 1 || page > selected.pageInfo.totalPages) continue;
      elements.push({ tag: 'button', type: 'default', width: 'fill', text: { tag: 'plain_text', content: label }, behaviors: [{ type: 'callback', value: {
        version: 5, workflowType: 'purchase_lifecycle_page', action: 'page', approvalBatchId: input.approvalBatchId,
        flowVersion: 'lifecycle_v1', cardRevision: input.cardRevision, page,
      } }] });
    }
    if (paginatePurchaseLifecycleCard({ elements, shell }).length !== 1) throw new Error('采购卡片分页超限');
  }
  return selected;
}
