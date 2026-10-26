import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Eye,
  FileArchive,
  FileSpreadsheet,
  Loader2,
} from 'lucide-react';
import type {
  SystemMonthlyReportArchivePreview,
  SystemMonthlyReportHistoryItem,
} from '@shared/system-monthly-report.interface';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  getSystemMonthlyReportArchiveDownloadUrl,
  getSystemMonthlyReportArchivePreview,
} from './api';

export function FinalReportAttachmentViewer({
  item,
  canDownload,
}: {
  item: SystemMonthlyReportHistoryItem | null;
  canDownload: boolean;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] =
    useState<SystemMonthlyReportArchivePreview | null>(null);
  const [previewName, setPreviewName] = useState('');
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const previewRequestIdRef = useRef(0);

  useEffect(() => {
    previewRequestIdRef.current += 1;
    setPreviewOpen(false);
    setPreview(null);
    setPreviewName('');
    setActiveSheetIndex(0);
    setBusyAction('');
    setError('');
  }, [item?.recordId]);

  const activeSheet = useMemo(
    () =>
      preview?.kind === 'spreadsheet'
        ? preview.sheets[activeSheetIndex] || preview.sheets[0]
        : null,
    [activeSheetIndex, preview],
  );

  const openPreview = async (attachmentId: string, name: string) => {
    const requestId = ++previewRequestIdRef.current;
    setPreviewOpen(true);
    setPreview(null);
    setPreviewName(name);
    setActiveSheetIndex(0);
    setError('');
    setBusyAction(`${attachmentId}:preview`);
    try {
      const next = await getSystemMonthlyReportArchivePreview(attachmentId);
      if (requestId === previewRequestIdRef.current) setPreview(next);
    } catch {
      if (requestId === previewRequestIdRef.current) {
        setError('在线预览加载失败，可下载附件后查看。');
      }
    } finally {
      if (requestId === previewRequestIdRef.current) setBusyAction('');
    }
  };

  const download = async (attachmentId: string) => {
    setError('');
    setBusyAction(`${attachmentId}:download`);
    try {
      const result =
        await getSystemMonthlyReportArchiveDownloadUrl(attachmentId);
      window.location.assign(result.url);
    } catch {
      setError('附件下载失败，请稍后重试。');
    } finally {
      setBusyAction('');
    }
  };

  if (!item) return null;

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-slate-950">终版附件</h3>
        <Badge variant="secondary">{item.attachments.length} 个</Badge>
      </div>
      {item.attachments.length ? (
        <div className="mt-3 space-y-2">
          {item.attachments.map((attachment) => {
            const ready = attachment.status === 'archived' && canDownload;
            const previewBusy = busyAction === `${attachment.id}:preview`;
            const downloadBusy = busyAction === `${attachment.id}:download`;
            return (
              <div
                key={attachment.id}
                className="rounded-lg border border-slate-200 bg-white p-3"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <FileArchive className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
                  <div className="min-w-0 flex-1">
                    <p className="break-all text-sm font-medium text-slate-800">
                      {attachment.name}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      {formatFileSize(attachment.size)} · {attachment.message}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!ready || Boolean(busyAction)}
                    onClick={() =>
                      void openPreview(attachment.id, attachment.name)
                    }
                  >
                    {previewBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                    在线预览
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!ready || Boolean(busyAction)}
                    onClick={() => void download(attachment.id)}
                  >
                    {downloadBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    下载附件
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
          终版附件正在准备中
        </p>
      )}
      {error && !previewOpen ? (
        <p role="alert" className="mt-2 text-sm text-rose-600">
          {error}
        </p>
      ) : null}

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[90vh] max-w-[min(96vw,1200px)] overflow-hidden">
          <DialogHeader>
            <DialogTitle className="break-all pr-8">
              {preview?.name || previewName || '终版附件预览'}
            </DialogTitle>
            <DialogDescription className="sr-only">
              在线查看终版月报附件
            </DialogDescription>
          </DialogHeader>
          {busyAction.endsWith(':preview') ? (
            <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
              正在加载预览
            </div>
          ) : error ? (
            <div
              role="alert"
              className="rounded-lg border border-rose-100 bg-rose-50 p-4 text-sm text-rose-700"
            >
              {error}
            </div>
          ) : preview?.kind === 'pdf' ? (
            <iframe
              title={preview.name}
              src={preview.url}
              className="h-[72vh] w-full rounded-lg border border-slate-200 bg-slate-50"
            />
          ) : preview?.kind === 'spreadsheet' ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                  工作表
                  <select
                    value={activeSheetIndex}
                    onChange={(event) =>
                      setActiveSheetIndex(Number(event.target.value))
                    }
                    className="h-9 rounded-lg border border-slate-200 bg-white px-3 outline-none focus:border-blue-400"
                  >
                    {preview.sheets.map((sheet, index) => (
                      <option key={`${sheet.name}-${index}`} value={index}>
                        {sheet.name}
                      </option>
                    ))}
                  </select>
                </label>
                {preview.truncated ? (
                  <span className="text-xs text-amber-700">
                    页面仅展示前 {200} 行、{40} 列，完整内容请下载附件
                  </span>
                ) : null}
              </div>
              <div className="max-h-[68vh] overflow-auto rounded-lg border border-slate-200">
                {activeSheet?.rows.length ? (
                  <table className="min-w-full border-collapse text-xs">
                    <tbody>
                      {activeSheet.rows.map((row, rowIndex) => (
                        <tr key={rowIndex} className="odd:bg-slate-50/60">
                          <th className="sticky left-0 border-b border-r border-slate-200 bg-slate-100 px-2 py-1.5 text-right font-normal text-slate-400">
                            {rowIndex + 1}
                          </th>
                          {row.map((cell, columnIndex) => (
                            <td
                              key={columnIndex}
                              className="min-w-24 max-w-80 whitespace-pre-wrap break-words border-b border-r border-slate-100 px-2 py-1.5 align-top text-slate-700"
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="py-16 text-center text-sm text-slate-400">
                    当前工作表没有可展示内容
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function formatFileSize(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '大小未知';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
