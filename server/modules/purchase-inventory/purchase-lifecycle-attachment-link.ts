import type { PurchaseLifecycleAttachmentPurpose } from './purchase-lifecycle-attachment-view';

/** The origin comes from server configuration, never from a card callback or record. */
export function purchaseLifecycleAttachmentLink(base: string, batchId: string, recordId: string, generation: number, purpose: PurchaseLifecycleAttachmentPurpose, index: number): string {
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(batchId) || !/^[A-Za-z0-9_-]{1,100}$/.test(recordId) ||
    !Number.isSafeInteger(generation) || generation < 1 || generation > 999_999_999 || !Number.isSafeInteger(index) || index < 0 || index >= 20 ||
    !['comparison', 'payment', 'receipt', 'invoice'].includes(purpose)) throw new Error('采购附件链接参数无效');
  let url: URL;
  try {
    url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  } catch { throw new Error('采购附件公网地址未配置或无效'); }
  url.pathname = '/purchase-lifecycle-attachment';
  url.search = new URLSearchParams({ batchId, recordId, generation: String(generation), purpose, index: String(index) }).toString();
  return url.toString();
}

/** Preserve the existing inventory workflow using only the configured HTTPS site. */
export function purchaseLifecycleInboundLink(base: string, recordId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(recordId)) throw new Error('采购入库记录无效');
  let url: URL;
  try {
    url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  } catch { throw new Error('采购入库公网地址未配置或无效'); }
  url.pathname = '/inventory-management';
  url.search = new URLSearchParams({ view: 'inbound', purchase: recordId }).toString();
  return url.toString();
}
