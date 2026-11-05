/** Isolated card-link builder; it is not wired into any production renderer. */
export function purchaseLifecyclePaymentUploadLink(base: string, approvalBatchId: string, executionRecordId: string, generation: number): string {
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(approvalBatchId) || !/^[A-Za-z0-9_-]{1,100}$/.test(executionRecordId) ||
    !Number.isSafeInteger(generation) || generation < 1 || generation > 999_999_999) throw new Error('付款附件入口参数无效');
  let url: URL;
  try {
    url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  } catch { throw new Error('付款附件公网地址未配置或无效'); }
  url.pathname = '/purchase-lifecycle-payment-upload';
  url.search = new URLSearchParams({ approvalBatchId, executionRecordId, generation: String(generation) }).toString();
  return url.toString();
}
