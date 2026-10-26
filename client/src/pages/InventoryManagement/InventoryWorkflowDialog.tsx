import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

import { WorkflowAutomationPanel } from './WorkflowAutomationPanel';

interface InventoryWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InventoryWorkflowDialog({
  open,
  onOpenChange,
}: InventoryWorkflowDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-[min(1600px,calc(100vw-2rem))] overflow-y-auto border-blue-100 bg-[#f8fbff] p-0 sm:rounded-xl">
        <DialogTitle className="sr-only">库存自动化工作流</DialogTitle>
        <DialogDescription className="sr-only">
          查看库存自动化状态、手动执行工作流、运行自测并检查最近日志。
        </DialogDescription>
        <WorkflowAutomationPanel embedded />
      </DialogContent>
    </Dialog>
  );
}
