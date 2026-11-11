export interface PendingPurchaseReadFailure {
  message: string;
  hidePrevious: boolean;
}
/** Map only public protocol codes/statuses; never surface upstream URLs or credential-bearing text. */
export function describePendingPurchaseReadFailure(error: unknown): PendingPurchaseReadFailure {
  const failure = error as {code?: unknown;response?: {status?: unknown;data?: {code?: unknown;message?: unknown}}} | null;
  const status = failure?.response?.status;
  const code = failure?.response?.data?.code;
  if (status === 401) return {message:'登录状态已失效，请重新登录后读取待采购入库清单。',hidePrevious:true};
  if (status === 403) return {message:'当前账号没有读取待采购入库清单的权限，请联系管理员核对权限后重新加载。',hidePrevious:true};
  const confirmedConflict = code === 'INVENTORY_PENDING_READ_CONFLICT' || (status === 503 && ['待采购入库数据正在更新，本次核对未完成，请稍后重试', '待采购入库数据正在更新，本次核对未完成，请稍后重试。'].includes(String(failure?.response?.data?.message || '')));
  if (confirmedConflict) return {message:'待入库数据正在变更，本次核对未完成，请稍后重新加载。',hidePrevious:false};
  if (status === 408 || status === 504 || ['ECONNABORTED','ETIMEDOUT'].includes(String(failure?.code || ''))) return {message:'读取待采购入库清单超时，请稍后点击重新加载。',hidePrevious:false};
  if (failure?.code === 'ERR_NETWORK') return {message:'网络连接暂时中断，请检查网络后重新加载待采购入库清单。',hidePrevious:false};
  return {message:'待采购入库清单暂时无法核对，请稍后重新加载。',hidePrevious:false};
}
export function pendingPurchaseReadDisplay(loading: boolean, visibleCount: number): 'initial-loading' | 'refreshing' | 'ready' {
  return loading ? visibleCount > 0 ? 'refreshing' : 'initial-loading' : 'ready';
}
