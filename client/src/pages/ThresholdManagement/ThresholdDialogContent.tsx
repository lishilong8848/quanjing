import type { ComponentProps } from 'react';
import { X } from 'lucide-react';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
export function ThresholdDialogContent({
  children,
  ...props
}: ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent {...props} showCloseButton={false}>
      {children}
      <DialogClose className="threshold-dialog-close" aria-label="关闭">
        <span>关闭</span>
        <X size={16} />
      </DialogClose>
    </DialogContent>
  );
}
