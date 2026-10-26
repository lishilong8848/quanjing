import { BadRequestException } from '@nestjs/common';
import type { PurchaseBatchAttachmentTicketPayload } from './purchase-batch-attachment-ticket';
import type {
  PurchaseWorkflowGateway,
  PurchaseWorkflowUploadFile,
} from './purchase-workflow.gateway';
import type { PurchaseWorkflowStore } from './purchase-workflow.store';
import { receiptMaterialRequirement } from './purchase-receipt-material-policy';

export interface PurchaseBatchAttachmentUploadFiles {
  paymentAttachments?: PurchaseWorkflowUploadFile[];
  receiptPhotos?: PurchaseWorkflowUploadFile[];
  invoices?: PurchaseWorkflowUploadFile[];
}

export async function processPurchaseBatchAttachmentUpload(
  payload: PurchaseBatchAttachmentTicketPayload,
  files: PurchaseBatchAttachmentUploadFiles = {},
  dependencies: {
    gateway: Pick<
      PurchaseWorkflowGateway,
      'getTenantAccessTokenAsApp' | 'uploadAttachment'
    >;
    store: Pick<
      PurchaseWorkflowStore,
      | 'findManagerApprovalBatch'
      | 'stagePurchaseBatchAttachments'
      | 'enqueueNotification'
    >;
  },
): Promise<{ success: true; receiptPhotoCount: number; invoiceCount: number }> {
  const paymentAttachments = files.paymentAttachments || [];
  const receiptPhotos = files.receiptPhotos || [];
  const invoices = files.invoices || [];
  if (
    payload.purpose === 'payment' &&
    (receiptPhotos.length > 0 || invoices.length > 0)
  ) {
    throw new BadRequestException('付款附件入口不接受签收材料');
  }
  if (payload.purpose === 'receipt' && paymentAttachments.length > 0) {
    throw new BadRequestException('签收附件入口不接受付款材料');
  }
  if (payload.purpose === 'payment' && paymentAttachments.length === 0) {
    throw new BadRequestException('请选择付款附件');
  }
  if (
    receiptPhotos.some((file) => !clean(file.mimetype).startsWith('image/'))
  ) {
    throw new BadRequestException('签收照片必须是图片文件');
  }
  const existing = await dependencies.store.findManagerApprovalBatch(
    payload.approvalBatchId,
  );
  const existingItem = existing?.items.find(
    (item) => item.executionRecordId === payload.executionRecordId,
  );
  const requirement = receiptMaterialRequirement(
    existingItem?.choice === 'building_self'
      ? '需求自采'
      : existingItem?.choice === 'comprehensive'
        ? '综合采购'
        : '',
  );
  if (
    payload.purpose === 'receipt' &&
    !existingItem?.receiptPhotoTokens.length &&
    receiptPhotos.length === 0
  ) {
    throw new BadRequestException('请至少上传 1 张签收照片');
  }
  if (
    payload.purpose === 'receipt' &&
    requirement.requiresInvoice &&
    !existingItem?.invoiceTokens.length &&
    invoices.length === 0
  ) {
    throw new BadRequestException('自采签收必须上传发票');
  }

  const accessToken = await dependencies.gateway.getTenantAccessTokenAsApp();
  const uploadAll = async (
    source: PurchaseWorkflowUploadFile[],
  ): Promise<string[]> => {
    const tokens: string[] = [];
    for (const file of source) {
      tokens.push(
        await dependencies.gateway.uploadAttachment(file, accessToken),
      );
    }
    return tokens;
  };
  const paymentAttachmentTokens = await uploadAll(paymentAttachments);
  const receiptPhotoTokens = await uploadAll(receiptPhotos);
  const invoiceTokens = await uploadAll(invoices);
  const batch = await dependencies.store.stagePurchaseBatchAttachments({
    approvalBatchId: payload.approvalBatchId,
    executionRecordId: payload.executionRecordId,
    actorOpenId: payload.actorOpenId,
    purpose: payload.purpose,
    paymentAttachmentTokens,
    receiptPhotoTokens,
    invoiceTokens,
  });
  const updatedItem = batch.items.find(
    (item) => item.executionRecordId === payload.executionRecordId,
  );
  if (!updatedItem) throw new BadRequestException('采购附件明细不存在');
  await dependencies.store.enqueueNotification({
    businessEventId: `${
      payload.purpose === 'payment'
        ? 'manager_batch_purchase_refresh'
        : 'manager_batch_receipt_refresh'
    }:${payload.approvalBatchId}:${payload.executionRecordId}:attachment:${batch.revision}`,
    recordId: payload.executionRecordId,
    recipientOpenId: payload.actorOpenId,
    kind:
      payload.purpose === 'payment'
        ? 'manager_batch_purchase_refresh'
        : 'manager_batch_receipt_refresh',
    cardContext: batch.cardContext,
  });
  return {
    success: true,
    receiptPhotoCount: updatedItem.receiptPhotoTokens.length,
    invoiceCount: updatedItem.invoiceTokens.length,
  };
}

export function renderPurchaseBatchAttachmentPage(input: {
  ticket: string;
  purpose: 'payment' | 'receipt';
  hasReceiptPhoto: boolean;
  hasInvoice: boolean;
  purchaseMethod: string;
}): string {
  const ticket = JSON.stringify(input.ticket).replace(/</gu, '\\u003c');
  const receipt = input.purpose === 'receipt';
  const title = receipt ? '补充签收材料' : '补充付款附件';
  const requirement = receiptMaterialRequirement(input.purchaseMethod);
  const fields = receipt
    ? `<p class="rule">${requirement.requiresInvoice ? '自采需同时上传签收照片和发票' : '综合采购仅需上传签收照片'}</p>
       <label>签收照片（必填）<input name="receiptPhotos" type="file" accept="image/*" multiple ${input.hasReceiptPhoto ? '' : 'required'}></label>
       ${requirement.requiresInvoice ? `<label>发票（必填）<input name="invoices" type="file" multiple ${input.hasInvoice ? '' : 'required'}></label>` : ''}`
    : '<label>付款附件（必填）<input name="paymentAttachments" type="file" multiple required></label>';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title>
<style>:root{color-scheme:light;font-family:Inter,system-ui,sans-serif;background:hsl(0 0% 98%);color:hsl(222 47% 11%)}*{box-sizing:border-box}body{margin:0;padding:16px}.card{max-width:560px;margin:0 auto;background:hsl(0 0% 100%);border:1px solid hsl(214 20% 90%);border-radius:.5rem;padding:20px;box-shadow:0 1px 3px #0000001a}h1{font-size:22px;margin:0 0 8px}p{color:hsl(220 9% 46%);line-height:1.6;margin:0 0 20px}.rule{padding:12px;border-radius:.5rem;background:hsl(217 91% 96%);color:hsl(222 47% 25%)}label{display:block;font-weight:600;margin:16px 0}input{display:block;width:100%;margin-top:8px;padding:12px;border:1px dashed hsl(214 20% 75%);border-radius:.5rem;background:hsl(220 14% 96%)}button{width:100%;border:0;border-radius:.5rem;padding:13px;background:hsl(217 91% 60%);color:hsl(0 0% 100%);font-weight:700;font-size:16px}button:disabled{opacity:.55}.status{min-height:24px;margin-top:14px;color:hsl(142 76% 30%)}.error{color:hsl(354 70% 46%)}.success{text-align:center;padding:20px 0}.success h2{margin:0 0 8px;color:hsl(142 76% 30%)}[hidden]{display:none!important}@media(min-width:768px){body{padding:40px}.card{padding:28px}}</style></head>
<body><main class="card"><h1>${title}</h1><p>单个文件不超过 20 MB。</p><form id="upload" data-state="idle">${fields}<button id="submit" type="submit">上传材料</button><div id="status" class="status" role="status" aria-live="polite"></div></form><section id="success" class="success" hidden><h2>上传成功</h2><p>卡片会自动更新，无需刷新。</p><button id="close" type="button">关闭页面</button></section></main>
<script>(()=>{const ticket=${ticket};history.replaceState({},document.title,location.pathname);const form=document.getElementById('upload'),button=document.getElementById('submit'),status=document.getElementById('status'),success=document.getElementById('success'),close=document.getElementById('close');form.addEventListener('submit',async(event)=>{event.preventDefault();form.dataset.state='submitting';button.disabled=true;status.className='status';status.textContent='正在上传…';try{const response=await fetch(location.pathname,{method:'POST',headers:{'x-purchase-attachment-ticket':ticket},body:new FormData(form)});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||'上传失败');form.dataset.state='success';form.hidden=true;success.hidden=false;form.reset()}catch(error){form.dataset.state='error';status.className='status error';status.textContent=error instanceof Error?error.message:'上传失败，请重试';button.disabled=false}});close.addEventListener('click',()=>{window.close();setTimeout(()=>{if(history.length>1)history.back()},100)})})();</script></body></html>`;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
