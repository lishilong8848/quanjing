import { CheckCircle2, Loader2, PackageCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { InventoryOutboundMovementItem } from '@shared/inventory-management.interface';
import { formatInventoryOutboundConfirmationTime } from './inventory-outbound-confirmation';

interface InventoryOutboundConfirmationDialogProps {
  open: boolean;
  item: InventoryOutboundMovementItem | null;
  canConfirm: boolean;
  submitting?: boolean;
  retryLocked?: boolean;
  onOpenChange: (open: boolean) => void;
  onAbandonRetry?: () => void;
  onConfirm: (item: InventoryOutboundMovementItem) => void;
}

export function InventoryOutboundConfirmationDialog({
  open,
  item,
  canConfirm,
  submitting = false,
  retryLocked = false,
  onOpenChange,
  onAbandonRetry,
  onConfirm,
}: InventoryOutboundConfirmationDialogProps) {
  const confirmable =
    canConfirm &&
    item?.status === '待库房确认' &&
    item.pendingSync !== true &&
    !submitting;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
              <PackageCheck className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle>库房确认出库</DialogTitle>
              <DialogDescription className="mt-1">
                请核对来源楼栋、物品和申请数量；确认后将正式扣减库存。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {item ? (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-100 bg-blue-50/60 px-4 py-3">
              <div className="min-w-0">
                <strong className="block truncate text-sm text-slate-900">
                  {item.name}
                </strong>
                <span className="mt-1 block truncate text-xs text-slate-500">
                  {item.sku} · {item.specification || '规格待补充'}
                </span>
              </div>
              <Badge className="shrink-0 border-amber-200 bg-amber-50 text-amber-700">
                {item.status}
              </Badge>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Detail
                label="来源楼栋 / 库位"
                value={`${item.building} · ${item.location || '待补充'}`}
              />
              <Detail
                label="申请数量"
                value={`${item.quantity} ${item.unit}`}
              />
              <Detail label="物品申请人" value={item.applicant || '待补充'} />
              <Detail
                label="出库原因 / 使用地点"
                value={item.reason || '待补充'}
              />
              <Detail
                label="申请办理时间"
                value={formatInventoryOutboundConfirmationTime(item.occurredAt)}
              />
            </dl>
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
              确认出库后单据状态将更新为“已出库”，并同步更新该楼栋库存。
            </p>
          </div>
        ) : null}

        <DialogFooter>
          {retryLocked && onAbandonRetry ? (
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              onClick={onAbandonRetry}
              className="text-amber-700 hover:bg-amber-50 hover:text-amber-800"
            >
              放弃原确认编号并刷新
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={!confirmable || !item}
            onClick={() => item && onConfirm(item)}
            className="bg-blue-600 text-white hover:bg-blue-700"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {submitting ? '正在确认' : '确认出库'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2.5">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="mt-1 break-words font-medium text-slate-700">{value}</dd>
    </div>
  );
}
