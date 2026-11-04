import type { PurchaseWorkflowStage } from '../../../shared/purchase-workflow.interface';
import type { PurchaseLifecycleAction, PurchaseLifecycleProjectedItem } from './purchase-lifecycle-projection';

/** The caller must first establish the recipient, stage grants and message binding. */
export type PurchaseLifecycleCallbackResolver = (
  recordId: string,
  action: PurchaseLifecycleAction,
) => Record<string, unknown> | undefined;

const STAGES: Record<PurchaseWorkflowStage, string> = {
  application: '申请', approval: '审批', ordering: '下单', receipt: '签收',
  inbound: '入库', completed: '已完成', terminated: '已终止', unknown: '状态待核对',
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

/** Build one recipient's card from an already-authorized projection, never a raw record. */
export function buildPurchaseLifecycleCard(input: {
  approvalBatchId: string;
  items: ReadonlyArray<PurchaseLifecycleProjectedItem>;
  observer: boolean;
  resolveCallback?: PurchaseLifecycleCallbackResolver;
}): Record<string, unknown> {
  if (typeof input.approvalBatchId !== 'string' || !BATCH_ID.test(input.approvalBatchId)) throw new Error('采购卡片批次标识无效');
  const elements: Record<string, unknown>[] = [];
  const seenImages = new Map<string, number>();
  if (input.observer) elements.push({ tag: 'div', text: { tag: 'plain_text', content: '只读抄送 · 不可操作' } });
  for (const [index, item] of input.items.entries()) {
    if (!ID.test(item.recordId)) throw new Error('采购卡片记录标识无效');
    if (item.currentStage !== null && !Object.hasOwn(STAGES, item.currentStage)) throw new Error('采购卡片阶段无效');
    const lines = [`${index + 1}. ${item.currentStage === null ? '采购记录' : STAGES[item.currentStage]}`];
    const images: Record<string, unknown>[] = [];
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
    }
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } }, ...images);
    if (!input.observer && input.resolveCallback) {
      for (const action of new Set(item.actions)) {
        if ((action !== 'order' || item.currentStage !== 'ordering') && (action !== 'receive' || item.currentStage !== 'receipt')) continue;
        const callback = safeCallback(input.resolveCallback(item.recordId, action), input.approvalBatchId, item.recordId, action);
        if (!callback) continue;
        elements.push({ tag: 'button', type: 'primary', width: 'fill', text: { tag: 'plain_text', content: action === 'order' ? '填写下单结果' : '填写签收信息' }, behaviors: [{ type: 'callback', value: callback }] });
      }
    }
  }
  if (!elements.length) elements.push({ tag: 'div', text: { tag: 'plain_text', content: '暂无可查看的采购内容' } });
  const card = { schema: '2.0', config: { update_multi: true, enable_forward: false }, header: { title: { tag: 'plain_text', content: '采购全流程' }, template: 'blue' }, body: { elements } };
  if (elements.length > 200) throw new Error('采购卡片组件数量超限，需要分页处理');
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > 30 * 1024) throw new Error('采购卡片超过飞书 30KB 限制，需要分页处理');
  return card;
}
