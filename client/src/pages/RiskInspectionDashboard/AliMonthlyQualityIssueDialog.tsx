import { useEffect, useMemo, useState } from 'react';
import { FileImage, FileText, ImageOff, Paperclip, X } from 'lucide-react';
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

import { AliMonthlyQualityImagePreviewDialog } from './AliMonthlyQualityImagePreviewDialog';
import { formatMonthlyQualityImageTitle } from './monthly-quality-image';

function formatEvidenceSize(size: number | null): string {
  if (size === null) return '大小未知';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function EvidenceList({
  title,
  items,
  image = false,
  imageTitle = '',
  onPreviewImage,
}: {
  title: string;
  items: AliMonthlyQualityEvidence[];
  image?: boolean;
  imageTitle?: string;
  onPreviewImage?: (item: AliMonthlyQualityEvidence) => void;
}) {
  const Icon = image ? FileImage : Paperclip;
  return (
    <section className="quality-evidence-section">
      <h3>{title}</h3>
      {items.length > 0 ? (
        <ul>
          {items.map((item, index) => {
            const isImage = item.mimeType.startsWith('image/');
            return (
              <li key={`${item.name}-${index}`}>
                {isImage ? (
                  <button
                    type="button"
                    className="quality-evidence-preview"
                    aria-label={`预览现场影像：${imageTitle}`}
                    onClick={() => onPreviewImage?.(item)}
                  >
                    <img
                      src={item.url}
                      alt={imageTitle || '问题证据'}
                      width={248}
                      height={168}
                      loading="lazy"
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
                  </button>
                ) : (
                  <a
                    className="quality-evidence-file"
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Icon aria-hidden="true" />
                  </a>
                )}
                <span>
                  <strong>{isImage ? imageTitle : item.name}</strong>
                  <small>
                    {item.mimeType || '类型未知'} ·{' '}
                    {formatEvidenceSize(item.size)}
                  </small>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>未上传</p>
      )}
    </section>
  );
}

export function AliMonthlyQualityIssueDialog({
  issue,
  onClose,
}: {
  issue: AliMonthlyQualityIssue | null;
  onClose: () => void;
}) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const imagePreviewItems = useMemo(
    () =>
      issue
        ? [...issue.images, ...issue.attachments]
            .filter(({ mimeType }) => mimeType.startsWith('image/'))
            .map((evidence) => ({ evidence, issue }))
        : [],
    [issue],
  );
  const imageTitle = issue ? formatMonthlyQualityImageTitle(issue) : '';

  useEffect(() => {
    setPreviewIndex(null);
  }, [issue?.id]);

  const openPreview = (evidence: AliMonthlyQualityEvidence) => {
    const index = imagePreviewItems.findIndex(
      (item) => item.evidence === evidence,
    );
    if (index >= 0) setPreviewIndex(index);
  };

  return (
    <>
      <Dialog
        open={Boolean(issue)}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          className="quality-detail-dialog"
          showCloseButton={false}
        >
          <DialogHeader className="quality-dialog-header">
            <span className="quality-dialog-icon" aria-hidden="true">
              <FileText />
            </span>
            <div>
              <DialogTitle>阿里月度质量问题详情</DialogTitle>
              <DialogDescription>
                {issue
                  ? `${issue.month} · ${issue.building} · ${issue.item}`
                  : '—'}
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="quality-dialog-close"
                aria-label="关闭月度质量问题详情"
              >
                <X aria-hidden="true" />
              </Button>
            </DialogClose>
          </DialogHeader>

          <dl className="quality-detail-fields">
            <div>
              <dt>月份</dt>
              <dd>{issue?.month || '未填写'}</dd>
            </div>
            <div>
              <dt>楼栋</dt>
              <dd>{issue?.building || '未填写'}</dd>
            </div>
            <div>
              <dt>检查项目</dt>
              <dd>{issue?.item || '未填写'}</dd>
            </div>
            <div className="quality-detail-wide">
              <dt>问题</dt>
              <dd>{issue?.issue || '未填写'}</dd>
            </div>
            <div className="quality-detail-wide">
              <dt>问题补充描述</dt>
              <dd>{issue?.supplemental || '未填写'}</dd>
            </div>
            <div className="quality-detail-wide">
              <dt>涉及人员</dt>
              <dd>
                {issue?.responsiblePersons.length
                  ? issue.responsiblePersons.map(({ name }) => name).join('、')
                  : issue?.personMatchStatus === 'ambiguous'
                    ? '待人工确认，暂不计入个人档案'
                    : '未识别到在职人员'}
              </dd>
            </div>
          </dl>

          <div className="quality-evidence-grid">
            <EvidenceList
              title="附件"
              items={issue?.attachments || []}
              imageTitle={imageTitle}
              onPreviewImage={openPreview}
            />
            <EvidenceList
              title="问题图片"
              items={issue?.images || []}
              image
              imageTitle={imageTitle}
              onPreviewImage={openPreview}
            />
          </div>
        </DialogContent>
      </Dialog>

      <AliMonthlyQualityImagePreviewDialog
        items={imagePreviewItems}
        selectedIndex={previewIndex}
        onSelectedIndexChange={setPreviewIndex}
        onClose={() => setPreviewIndex(null)}
      />
    </>
  );
}
