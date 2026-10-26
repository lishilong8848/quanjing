import { Gauge, Info } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface ThresholdAdjustmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ThresholdAdjustmentDialog({
  open,
  onOpenChange,
}: ThresholdAdjustmentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,520px)] max-w-none gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b bg-muted/40 px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="size-5 text-primary" aria-hidden="true" />
            阈值调整
          </DialogTitle>
          <DialogDescription>
            当前入口仅供说明，不会提交或修改任何数据。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 py-5">
          <Alert>
            <Info aria-hidden="true" />
            <AlertDescription className="space-y-2">
              <p className="font-medium text-foreground">
                阈值数据源和字段协议尚未配置。
              </p>
              <p>
                待明确阈值对象、字段范围、审批规则及后端同步目标后，再开放实际调整操作。
              </p>
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter className="border-t bg-muted/30 px-5 py-3">
          <Button type="button" onClick={() => onOpenChange(false)}>
            我知道了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
