import { ChevronLeft, ChevronRight, ImageOff, X } from 'lucide-react';

import type {
  AliMonthlyQualityEvidence,
  AliMonthlyQualityIssue,
} from '@shared/risk-inspection.interface';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { formatMonthlyQualityImageTitle } from './monthly-quality-image';

export interface MonthlyQualityImagePreviewItem {
  evidence: AliMonthlyQualityEvidence;
  issue: AliMonthlyQualityIssue;
}

export function AliMonthlyQualityImagePreviewDialog({
  items,
  selectedIndex,
  onSelectedIndexChange,
  onClose,
}: {
  items: MonthlyQualityImagePreviewItem[];
  selectedIndex: number | null;
  onSelectedIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const selected = selectedIndex === null ? null : items[selectedIndex] || null;
  const title = selected
    ? formatMonthlyQualityImageTitle(selected.issue)
    : '现场问题影像';

  return (
    <Dialog
      open={Boolean(selected)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="quality-image-preview-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="quality-image-preview-header">
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {selected
                ? `${selected.issue.month} · ${selected.issue.building} · ${selected.issue.item}`
                : '—'}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="quality-dialog-close"
              aria-label="关闭现场影像预览"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <div className="quality-image-preview-stage">
          {selected ? (
            <>
              <img
                key={selected.evidence.url}
                src={selected.evidence.url}
                alt={title}
                width={1600}
                height={900}
                onError={(event) => {
                  event.currentTarget.hidden = true;
                  event.currentTarget.nextElementSibling?.removeAttribute(
                    'hidden',
                  );
                }}
              />
              <span className="quality-image-fallback" hidden>
                <ImageOff aria-hidden="true" />
                影像加载失败
              </span>
            </>
          ) : null}
        </div>

        <div className="quality-image-preview-footer">
          <Button
            type="button"
            variant="outline"
            disabled={selectedIndex === null || selectedIndex <= 0}
            onClick={() =>
              onSelectedIndexChange(Math.max(0, (selectedIndex || 0) - 1))
            }
          >
            <ChevronLeft aria-hidden="true" />
            上一张
          </Button>
          <span>
            {selectedIndex === null ? 0 : selectedIndex + 1} / {items.length}
          </span>
          <Button
            type="button"
            variant="outline"
            disabled={
              selectedIndex === null || selectedIndex >= items.length - 1
            }
            onClick={() =>
              onSelectedIndexChange(
                Math.min(items.length - 1, (selectedIndex || 0) + 1),
              )
            }
          >
            下一张
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
