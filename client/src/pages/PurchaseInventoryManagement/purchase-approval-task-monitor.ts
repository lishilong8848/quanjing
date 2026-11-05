import type { PurchaseOnlineApprovalTaskStatusResponse } from '@shared/purchase-inventory.interface';

/** Polls only the accepted task. Losing the response never resubmits a decision. */
export async function monitorAcceptedPurchaseApproval(options: {
  taskId: string;
  recordId: string;
  current(): boolean;
  read(taskId: string): Promise<PurchaseOnlineApprovalTaskStatusResponse>;
  wait(): Promise<void>;
  attempts?: number;
}): Promise<{ state: 'completed' | 'failed' | 'pending' | 'cancelled'; message: string }> {
  for (let index = 0; index < (options.attempts ?? 60); index++) {
    if (!options.current()) return {state:'cancelled',message:''};
    try {
      const response = await options.read(options.taskId);
      if (!options.current()) return {state:'cancelled',message:''};
      if (response.success && response.task) {
        const task = response.task;
        if (task.id !== options.taskId || task.recordId !== options.recordId) return {state:'failed',message:'审批任务不匹配，请重新核对'};
        if (task.status === 'completed' || task.status === 'failed') return {state:task.status,message:task.message};
      }
    } catch { /* A read failure leaves the accepted write untouched. */ }
    if (index + 1 < (options.attempts ?? 60)) await options.wait();
  }
  return {state:'pending',message:'审批仍在后台处理，请稍后查看结果，勿重复提交'};
}
