import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAccess } from '@/access/AccessProvider';
import { canDeletePurchaseRecord } from '@/access/access-policy';
import { purchaseUiPrincipal, purchaseUiPrincipalKey } from './purchase-ui-principal';
import { deletePurchaseInventoryRecords } from '@/api';
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
  PurchaseRecordBatchDeleteResponse,
} from '@shared/purchase-inventory.interface';
import { PurchasePrincipalRequestGate } from './purchase-principal-request-gate';

interface PurchaseDeleteDialogProps {
  open: boolean;
  items: PurchaseInventoryRequestItem[];
  onOpenChange: (open: boolean) => void;
  onDeleted: (result: PurchaseRecordBatchDeleteResponse) => void;
}

export function PurchaseDeleteDialog({
  open,
  items,
  onOpenChange,
  onDeleted,
}: PurchaseDeleteDialogProps) {
  const access = useAccess();
  const principal = useMemo(
    () => purchaseUiPrincipal(access),
    [access],
  );
  const principalIdentityKey = `${purchaseUiPrincipalKey(principal)}:${items
    .map((item) => item.recordId)
    .join(',')}`;
  const [principalRequestGate] = useState(
    () => new PurchasePrincipalRequestGate(principalIdentityKey),
  );
  principalRequestGate.syncPrincipal(principalIdentityKey);
  const canDeleteBatch =
    items.length > 0 &&
    items.every((item) => canDeletePurchaseRecord(principal, item));
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const counts = useMemo(
    () => ({
      submissions: new Set(
        items.map((item) => item.submissionRecordId).filter(Boolean),
      ).size,
      executions: new Set(
        items.map((item) => item.executionRecordId).filter(Boolean),
      ).size,
    }),
    [items],
  );

  useEffect(() => {
    if (!open) return;
    setError('');
    setDeleting(false);
  }, [open]);

  useEffect(
    () => () => {
      principalRequestGate.invalidate();
    },
    [principalRequestGate],
  );

  async function handleDelete() {
    if (!canDeleteBatch) {
      setError('当前权限不能删除采购记录');
      return;
    }
    const requestToken = principalRequestGate.capture();
    setDeleting(true);
    setError('');
    try {
      const result = await deletePurchaseInventoryRecords({
        records: items.map((item) => ({
          key: item.recordId,
          submissionRecordId: item.submissionRecordId,
          executionRecordId: item.executionRecordId,
        })),
      });
      if (!principalRequestGate.isCurrent(requestToken)) return;
      toast.success(
        `已删除 ${result.deletedItems} 条采购数据，同步用时 ${result.durationMs}ms`,
      );
      onDeleted(result);
      onOpenChange(false);
    } catch (deleteError) {
      if (!principalRequestGate.isCurrent(requestToken)) return;
      const message = readDeleteError(deleteError);
      setError(message);
      toast.error(message);
    } finally {
      if (principalRequestGate.isCurrent(requestToken)) {
        setDeleting(false);
      }
    }
  }

  if (!canDeleteBatch) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!deleting) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleDelete();
          }}
        >
          <DialogHeader className="border-b border-rose-100 bg-rose-50 px-5 py-4 text-left">
            <div className="flex items-start gap-3">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-500 text-white shadow-sm shadow-rose-200">
                <Trash2 className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-base text-slate-900">
                  删除采购记录
                </DialogTitle>
                <DialogDescription className="mt-1 text-xs leading-5 text-slate-500">
                  已选择 {items.length} 条，关联采购提交 {counts.submissions}{' '}
                  条、采购执行 {counts.executions} 条。
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-4 px-5 py-5">
            <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                此操作不可撤销，删除结果会立即同步到对应的飞书多维表。
              </span>
            </div>
            {error ? (
              <p className="mt-1.5 min-h-5 text-xs text-rose-600" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter className="border-t border-slate-100 bg-slate-50 px-5 py-4">
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={deleting || !canDeleteBatch}
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {deleting ? '正在同步删除' : '确认删除'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function readDeleteError(error: unknown): string {
  const candidate = error as {
    message?: string;
    response?: { data?: { message?: string | { message?: string } } };
  };
  const responseMessage = candidate?.response?.data?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim()) {
    return responseMessage;
  }
  if (
    responseMessage &&
    typeof responseMessage === 'object' &&
    typeof responseMessage.message === 'string'
  ) {
    return responseMessage.message;
  }
  return (
    candidate?.message ||
    '删除失败，请稍后重试或联系管理员确认后端权限与多维表配置'
  );
}
