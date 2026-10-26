import { useEffect, useMemo, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Loader2,
  PackageSearch,
  ShoppingCart,
  ShieldCheck,
  UserRound,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import { useAccess } from '@/access/AccessProvider';
import {
  getPurchaseOnlineApprovalTaskStatus,
  submitPurchaseOnlineApproval,
} from '@/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  PurchaseInventoryRequestItem,
  PurchaseOnlineApprovalDecision,
} from '@shared/purchase-inventory.interface';
import {
  canApprovePurchaseOnline,
  createPurchaseOnlineApprovalSubmissionGate,
} from './purchase-online-approval.logic';
import { PurchasePrincipalRequestGate } from './purchase-principal-request-gate';

interface PurchaseOnlineApprovalDialogProps {
  item: PurchaseInventoryRequestItem | null;
  onOpenChange: (open: boolean) => void;
  onOptimisticDecision: (
    item: PurchaseInventoryRequestItem,
    decision: PurchaseOnlineApprovalDecision,
  ) => void;
  onTaskSettled: (
    recordId: string,
    outcome: 'completed' | 'failed',
  ) => Promise<boolean>;
}

export function PurchaseOnlineApprovalDialog({
  item,
  onOpenChange,
  onOptimisticDecision,
  onTaskSettled,
}: PurchaseOnlineApprovalDialogProps) {
  const { role, purchaseBuilding, buildings } = useAccess();
  const principal = useMemo(
    () => ({ role, purchaseBuilding, buildings }),
    [purchaseBuilding, buildings, role],
  );
  const principalIdentityKey = `${role}:${purchaseBuilding || ''}:${(buildings || []).join(',')}`;
  const [principalRequestGate] = useState(
    () => new PurchasePrincipalRequestGate(principalIdentityKey),
  );
  const [submissionGate] = useState(createPurchaseOnlineApprovalSubmissionGate);
  principalRequestGate.syncPrincipal(principalIdentityKey);
  const canApprove = Boolean(item && canApprovePurchaseOnline(principal, item));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSubmitting(false);
    setError('');
  }, [item?.recordId]);

  useEffect(
    () => () => {
      principalRequestGate.invalidate();
    },
    [principalRequestGate],
  );

  if (!item || !canApprove) return null;

  async function decide(decision: PurchaseOnlineApprovalDecision) {
    if (!item.executionRecordId || !submissionGate.tryStart()) return;
    const requestToken = principalRequestGate.capture();
    setSubmitting(true);
    setError('');
    try {
      const response = await submitPurchaseOnlineApproval(
        item.executionRecordId,
        { decision },
      );
      if (!principalRequestGate.isCurrent(requestToken)) return;
      onOptimisticDecision(item, decision);
      toast.success(response.message);
      onOpenChange(false);
      void monitorPurchaseOnlineApprovalTask(
        response.taskId,
        async (completedText) => {
          if (!principalRequestGate.isCurrent(requestToken)) return;
          const refreshed = await refreshAfterApproval(() =>
            onTaskSettled(item.recordId, 'completed'),
          );
          if (!principalRequestGate.isCurrent(requestToken)) return;
          if (refreshed) toast.success(completedText);
          else toast.warning(`${completedText}，但清单刷新失败，请手动刷新`);
        },
        async (message) => {
          if (!principalRequestGate.isCurrent(requestToken)) return;
          await onTaskSettled(item.recordId, 'failed');
          if (principalRequestGate.isCurrent(requestToken)) {
            toast.error(`${message}，页面状态已自动恢复`);
          }
        },
      );
    } catch (approvalError) {
      if (!principalRequestGate.isCurrent(requestToken)) return;
      const message = readApprovalError(approvalError);
      setError(message);
      toast.error(message);
    } finally {
      submissionGate.finish();
      if (principalRequestGate.isCurrent(requestToken)) {
        setSubmitting(false);
      }
    }
  }

  return (
    <Dialog
      open={Boolean(item)}
      onOpenChange={(nextOpen) => {
        if (!submitting) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-lg gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-blue-100 bg-blue-50 px-5 py-4 text-left">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-200">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base text-slate-900">
                采购申请审批
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-5 text-slate-500">
                审批结果会同步到飞书多维表，并由表内工作流更新采购流程。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 px-5 py-5">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium text-slate-400">采购单号</p>
            <p className="mt-1 truncate text-sm font-semibold text-slate-700">
              {item.requestCode || '待生成单号'}
            </p>
            <p className="mt-2 truncate text-base font-semibold text-slate-900">
              {item.title}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <ApprovalMeta
              icon={UserRound}
              label="申请人"
              value={item.requester || '未填写'}
            />
            <ApprovalMeta
              icon={Building2}
              label="楼栋"
              value={item.building || '未匹配'}
            />
            <ApprovalMeta
              icon={PackageSearch}
              label="数量"
              value={`${item.quantity} ${item.unit || '件'}`}
            />
            <ApprovalMeta
              icon={ShoppingCart}
              label="采购方式"
              value={item.purchaseMethod || '未填写'}
            />
            <ApprovalMeta
              icon={ShieldCheck}
              label="当前审批节点"
              value={item.approvalTarget || '运维经理'}
            />
            <ApprovalMeta
              icon={ShieldCheck}
              label="当前状态"
              value={item.statusLabel}
            />
          </dl>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800">
            确认通过后进入采购执行；驳回后该申请终止。提交后不可在本页面反向修改。
          </div>
          {error ? (
            <p className="text-xs text-rose-600" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="border-t border-slate-100 bg-slate-50 px-5 py-4 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={submitting}
              onClick={() => void decide('rejected')}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <XCircle className="h-4 w-4" />
              )}
              驳回申请
            </Button>
            <Button
              type="button"
              disabled={submitting}
              onClick={() => void decide('approved')}
              className="bg-blue-600 text-white hover:bg-blue-700"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              确认通过
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const APPROVAL_TASK_POLL_INTERVAL_MS = 500;
const APPROVAL_TASK_POLL_TIMEOUT_MS = 120_000;

async function monitorPurchaseOnlineApprovalTask(
  taskId: string,
  onCompleted: (message: string) => void | Promise<void>,
  onFailed: (message: string) => void | Promise<void>,
): Promise<void> {
  const deadline = Date.now() + APPROVAL_TASK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await getPurchaseOnlineApprovalTaskStatus(taskId);
      const task = response.task;
      if (!response.success || !task) {
        await onFailed(
          response.message || '审批后台任务不存在，请刷新页面确认',
        );
        return;
      }
      if (task.status === 'completed') {
        await onCompleted(task.message || '采购审批已同步');
        return;
      }
      if (task.status === 'failed') {
        await onFailed(task.message || '审批同步飞书多维表失败');
        return;
      }
    } catch {
      // 单次查询失败不影响后台同步，继续轮询最终结果。
    }
    await waitForApprovalTask(APPROVAL_TASK_POLL_INTERVAL_MS);
  }
  toast.warning('审批仍在后台同步，请稍后刷新页面确认结果');
}

async function refreshAfterApproval(
  refresh: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await refresh();
  } catch {
    return false;
  }
}

function waitForApprovalTask(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function ApprovalMeta({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof UserRound;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-100 px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-xs text-slate-400">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </dt>
      <dd className="mt-1 truncate font-medium text-slate-700">{value}</dd>
    </div>
  );
}

function readApprovalError(error: unknown): string {
  const candidate = error as {
    message?: unknown;
    response?: { data?: { message?: unknown } };
  };
  const responseMessage = candidate?.response?.data?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim()) {
    return responseMessage;
  }
  if (typeof candidate?.message === 'string' && candidate.message.trim()) {
    return candidate.message;
  }
  return '审批提交失败，请稍后重试';
}
