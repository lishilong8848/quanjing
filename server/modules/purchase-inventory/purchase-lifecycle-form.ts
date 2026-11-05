import { BadRequestException } from '@nestjs/common';
import { purchaseBatchReceiptFieldName } from './purchase-batch-fulfillment-card';
import { receiptMaterialRequirement } from './purchase-receipt-material-policy';

const NAME_PREFIX = 'lcf1:';
const BATCH = /^[A-Za-z0-9_-]{8,160}$/u;
const RECORD = /^[A-Za-z0-9_-]{1,100}$/u;
const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,128}$/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export type PurchaseLifecycleFormAction = 'submit_item_reject' | 'submit_order' | 'submit_receipt';
export type PurchaseLifecycleFormRole = 'manager' | 'purchaser' | 'requester';
export interface PurchaseLifecycleFormBinding {
  action: PurchaseLifecycleFormAction;
  approvalBatchId: string;
  executionRecordId: string;
  role: PurchaseLifecycleFormRole;
  flowVersion: 'lifecycle_v1';
  cardRevision: number;
}

const ROLES: Record<PurchaseLifecycleFormAction, PurchaseLifecycleFormRole> = {
  submit_item_reject: 'manager', submit_order: 'purchaser', submit_receipt: 'requester',
};
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

function validBinding(binding: PurchaseLifecycleFormBinding): boolean {
  return !!binding && Object.hasOwn(ROLES, binding.action) && binding.role === ROLES[binding.action] &&
    binding.flowVersion === 'lifecycle_v1' && typeof binding.approvalBatchId === 'string' && BATCH.test(binding.approvalBatchId) &&
    typeof binding.executionRecordId === 'string' && RECORD.test(binding.executionRecordId) &&
    Number.isSafeInteger(binding.cardRevision) && binding.cardRevision > 0;
}

/** The issuer must persist a cryptographically random 32-byte token with its complete trusted binding. */
export function purchaseLifecycleFormSubmitName(token: string): string {
  if (!TOKEN.test(token) || Buffer.from(token, 'base64url').length !== 32 || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new BadRequestException('采购卡片表单凭据无效');
  return NAME_PREFIX + token;
}

export function parsePurchaseLifecycleFormSubmitName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.startsWith(NAME_PREFIX)) return null;
  const token = name.slice(NAME_PREFIX.length);
  if (purchaseLifecycleFormSubmitName(token) !== name) throw new BadRequestException('采购卡片表单凭据无效');
  return token;
}

type FormOptions = { binding: PurchaseLifecycleFormBinding; token: string; rejectionReason?: string; actualQuantity?: number; actualAmount?: number; orderNote?: string; signerOpenId?: string; receiptTime?: string; purchaseMethod?: string; receiptPhotoCount?: number; invoiceCount?: number };

function input(name: string, label: string, multiline = false, required = true, defaultValue?: string): Record<string, unknown> {
  return { tag: 'input', name, required, input_type: multiline ? 'multiline_text' : 'text', ...(multiline ? { rows: name === 'rejection_reason' ? 4 : 3 } : {}), max_length: multiline ? 500 : 80, width: 'fill', label: { tag: 'plain_text', content: label }, ...(defaultValue ? { default_value: defaultValue } : {}) };
}

/** Render only after the server's full image-upload path has proved readiness.
 * These are outside the form so navigation does not submit form values. */
export function buildLifecycleReceiptUploadButtons(binding: PurchaseLifecycleFormBinding, purchaseMethod: string | undefined, ready: boolean): Record<string, unknown>[] {
  if (!validBinding(binding) || binding.action !== 'submit_receipt') throw new BadRequestException('采购签收附件绑定无效');
  if (ready !== true) return [];
  const button = (action: 'prepare_receipt_photo' | 'prepare_invoice', text: string) => ({
    tag: 'button', type: 'default', width: 'fill', text: {tag:'plain_text',content:text},
    behaviors: [{type:'callback',value:{version:4,workflowType:'purchase_batch_fulfillment',role:'requester',action,
      approvalBatchId:binding.approvalBatchId,executionRecordId:binding.executionRecordId,flowVersion:'lifecycle_v1',cardRevision:binding.cardRevision}}],
  });
  return [button('prepare_receipt_photo','添加签收照片'), ...(receiptMaterialRequirement(purchaseMethod).requiresInvoice ? [button('prepare_invoice','添加发票')] : [])];
}

/** Server-ledger projection, restricted to the recipient and current card copy. */
export interface LifecycleReceiptPreparationFeedback {
  taskId:string; executionRecordId:string; recipientOpenId:string; cardMessageId:string;
  materialType:'receipt_photo'|'invoice'; state:'pending'|'ready'|'failed'; intentId?:string; intentExpiresAtMs?:number;
}
export function buildLifecycleReceiptPreparationFeedback(value:LifecycleReceiptPreparationFeedback | null | undefined,
  expected:{recordId:string;recipientOpenId:string;messageId:string;nowMs:number}):Record<string,unknown>[] {
  if (!value) return [];
  if (value.executionRecordId!==expected.recordId || value.recipientOpenId!==expected.recipientOpenId || value.cardMessageId!==expected.messageId ||
      !['receipt_photo','invoice'].includes(value.materialType) || !['pending','ready','failed'].includes(value.state) || !Number.isSafeInteger(expected.nowMs)) throw new BadRequestException('采购签收附件状态不可核对');
  const label=value.materialType==='invoice'?'发票':'签收照片';
  const usable=value.state==='ready' && Number.isSafeInteger(value.intentExpiresAtMs) && Number(value.intentExpiresAtMs)>expected.nowMs;
  const content=value.state==='pending' ? `正在核验${label}上传权限` : usable ? `已核验，请在当前私聊发送${label}图片` : `${label}上传权限核验失败或已过期，请重新操作`;
  return [{tag:'markdown',content}];
}

/** Returns a Card 2.0 form element for an already-authorized selected record. */
export function buildPurchaseLifecycleForm(options: FormOptions): Record<string, unknown> {
  const { binding } = options;
  if (!validBinding(binding)) throw new BadRequestException('采购卡片表单绑定无效');
  const name = purchaseLifecycleFormSubmitName(options.token);
  const fields: Record<string, unknown>[] = [];
  let label = '';
  let disabled = false;
  if (binding.action === 'submit_item_reject') {
    fields.push(input('rejection_reason', '驳回原因', true, true, options.rejectionReason));
    label = '确认驳回此项';
  } else if (binding.action === 'submit_order') {
    fields.push(input('actual_quantity', '实际采购数量', false, true, options.actualQuantity == null ? undefined : String(options.actualQuantity)));
    fields.push(input('actual_amount', '实际付款金额', false, true, options.actualAmount == null ? undefined : String(options.actualAmount)));
    fields.push(input('order_note', '采购备注', true, false, options.orderNote));
    label = '提交下单结果';
  } else {
    if (!options.signerOpenId || !OPEN_ID.test(options.signerOpenId)) throw new BadRequestException('签收人无效');
    const signer = purchaseBatchReceiptFieldName('signer_open_id', binding.executionRecordId);
    const time = purchaseBatchReceiptFieldName('receipt_time', binding.executionRecordId);
    const note = purchaseBatchReceiptFieldName('receipt_note', binding.executionRecordId);
    fields.push({ tag: 'select_person', name: signer, required: true, type: 'default', width: 'fill', placeholder: { tag: 'plain_text', content: '请选择签收人' }, initial_option: options.signerOpenId, options: [{ value: options.signerOpenId }] });
    fields.push(input(time, '签收时间', false, true, options.receiptTime));
    fields.push(input(note, '签收备注', true, false));
    const invoiceRequired = receiptMaterialRequirement(options.purchaseMethod).requiresInvoice;
    const photos = options.receiptPhotoCount ?? 0, invoices = options.invoiceCount ?? 0;
    if (!Number.isSafeInteger(photos) || photos < 0 || !Number.isSafeInteger(invoices) || invoices < 0) throw new BadRequestException('签收附件数量无效');
    disabled = photos < 1 || (invoiceRequired && invoices < 1);
    fields.push({ tag: 'markdown', content: `签收照片：${photos} 个（必填）\n${invoiceRequired ? `发票：${invoices} 个（必填）` : '发票：无需上传'}` });
    label = disabled ? '请先上传签收所需附件' : '确认签收';
  }
  fields.push({ tag: 'button', name, type: binding.action === 'submit_item_reject' ? 'danger_filled' : 'primary_filled', width: 'fill', disabled, form_action_type: 'submit', text: { tag: 'plain_text', content: label } });
  return { tag: 'form', name: 'purchase_lifecycle_form', direction: 'vertical', vertical_spacing: '12px', elements: fields };
}

function text(value: unknown, max: number, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new BadRequestException('采购表单内容无效');
  const normalized = value.trim().normalize('NFC');
  if ((required && !normalized) || Array.from(normalized).length > max || CONTROL.test(normalized)) throw new BadRequestException('采购表单内容无效');
  return normalized;
}
function number(value: unknown, positive: boolean): number {
  if (typeof value !== 'string' && typeof value !== 'number') throw new BadRequestException('采购表单数字无效');
  if (typeof value === 'string' && !value.trim()) throw new BadRequestException('采购表单数字无效');
  const result = Number(value);
  if (!Number.isFinite(result) || (positive ? result <= 0 : result < 0)) throw new BadRequestException('采购表单数字无效');
  return result;
}
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new BadRequestException('采购表单包含未知或缺失字段');
}

/** Binding must come from server-side token storage, never from the callback. */
export function parsePurchaseLifecycleFormAction(action: unknown, trusted: { token: string; binding: PurchaseLifecycleFormBinding }): (PurchaseLifecycleFormBinding & Record<string, unknown>) | null {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const object = action as Record<string, unknown>;
  const token = parsePurchaseLifecycleFormSubmitName(object.name);
  if (!token) return null;
  if (!trusted || token !== trusted.token || !validBinding(trusted.binding)) throw new BadRequestException('采购卡片表单绑定无效');
  const binding = trusted.binding;
  if (object.tag !== 'button' || !object.form_value || typeof object.form_value !== 'object' || Array.isArray(object.form_value)) throw new BadRequestException('采购表单无效');
  const values = object.form_value as Record<string, unknown>;
  if (binding.action === 'submit_item_reject') {
    exactKeys(values, ['rejection_reason']);
    return { ...binding, rejectionReason: text(values.rejection_reason, 500, true) };
  }
  if (binding.action === 'submit_order') {
    exactKeys(values, ['actual_quantity', 'actual_amount', 'order_note']);
    return { ...binding, actualQuantity: number(values.actual_quantity, true), actualAmount: number(values.actual_amount, false), note: text(values.order_note, 500) };
  }
  const signer = purchaseBatchReceiptFieldName('signer_open_id', binding.executionRecordId);
  const time = purchaseBatchReceiptFieldName('receipt_time', binding.executionRecordId);
  const note = purchaseBatchReceiptFieldName('receipt_note', binding.executionRecordId);
  exactKeys(values, [signer, time], [note]);
  const signerOpenId = text(values[signer], 131, true);
  if (!OPEN_ID.test(signerOpenId)) throw new BadRequestException('签收人无效');
  const receiptTime = Date.parse(text(values[time], 40, true).replace(' ', 'T'));
  if (!Number.isFinite(receiptTime)) throw new BadRequestException('签收时间无效');
  return { ...binding, signerOpenId, receiptTime, note: text(values[note], 500) };
}
