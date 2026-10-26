import { FileText, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import type { RiskDetailPayload } from './detail-model';

export function RiskDetailDialog({
  detail,
  onClose,
}: {
  detail: RiskDetailPayload | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={Boolean(detail)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="risk-detail-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="risk-detail-dialog-header">
          <span className="risk-detail-dialog-icon" aria-hidden="true">
            <FileText />
          </span>
          <div>
            <DialogTitle>{detail?.title}</DialogTitle>
            <DialogDescription>{detail?.description}</DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="关闭详情"
              className="risk-detail-dialog-close"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>
        <dl className="risk-detail-fields">
          {detail?.fields.map((field) => (
            <div
              className={
                field.wide
                  ? 'risk-detail-field risk-detail-field-wide'
                  : 'risk-detail-field'
              }
              key={field.label}
            >
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
