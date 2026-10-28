import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import {
  getContractAttachmentDownloadUrl,
  getContractAttachmentInlineUrl,
  getContractAttachmentManifest,
  getContractAttachmentPageUrl,
  type ContractAttachmentManifest,
} from '@/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { ContractManagementItem } from '@shared/contract-management.interface';
import { useAccess } from '@/access/AccessProvider';
import { canUseContractAction } from './contract-permissions';
import {
  DEFAULT_PREVIEW_ZOOM,
  MAX_PREVIEW_ZOOM,
  MIN_PREVIEW_ZOOM,
  getManifestProcessingPollDelay,
  getManifestRetryDelay,
  zoomAfterWheel,
} from './contract-attachment-viewer.logic';

type ContractAttachmentViewerContract = Pick<
  ContractManagementItem,
  'code' | 'name' | 'attachments'
> & Partial<Pick<ContractManagementItem, 'specialty' | 'buildings'>>;

interface ContractAttachmentViewerProps {
  contract: ContractAttachmentViewerContract | null;
  initialAccessId?: string;
  initialPage?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ContractAttachmentViewer({
  contract,
  initialAccessId,
  initialPage,
  open,
  onOpenChange,
}: ContractAttachmentViewerProps) {
  const access = useAccess();
  const scope = contract && typeof contract.specialty === 'string' ? { specialty: contract.specialty, buildings: contract.buildings } : null;
  const canPreview = canUseContractAction(access, 'read', scope);
  const canDownload = canUseContractAction(access, 'export', scope);
  const [attachmentIndex, setAttachmentIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [manifest, setManifest] = useState<ContractAttachmentManifest | null>(
    null,
  );
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_PREVIEW_ZOOM);
  const [isDragging, setIsDragging] = useState(false);
  const [manifestError, setManifestError] = useState(false);
  const [manifestRetryKey, setManifestRetryKey] = useState(0);
  const [imageRetryKey, setImageRetryKey] = useState(0);
  const [previewTimedOut, setPreviewTimedOut] = useState(false);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const previewPanStateRef = useRef({
    active: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    startScrollLeft: 0,
    startScrollTop: 0,
  });

  const attachment = contract?.attachments[attachmentIndex] || null;
  const effectiveManifest = useMemo<ContractAttachmentManifest | null>(() => {
    if (!attachment) return null;
    if (manifest?.accessId === attachment.accessId) return manifest;
    return {
      accessId: attachment.accessId,
      name: attachment.name,
      previewStatus: attachment.previewStatus,
      pageCount: attachment.pageCount,
    };
  }, [attachment, manifest]);
  const pageCount = effectiveManifest?.pageCount || 0;
  const previewReady = canPreview && effectiveManifest?.previewStatus === 'ready';
  const storageUnavailable =
    effectiveManifest?.unavailableReason === 'storage_not_configured';
  const wheelZoomStateRef = useRef({ open, previewReady });
  wheelZoomStateRef.current = { open, previewReady };

  const handlePreviewWheel = useCallback((event: WheelEvent) => {
    const state = wheelZoomStateRef.current;
    if (
      !state.open ||
      !state.previewReady ||
      !Number.isFinite(event.deltaY) ||
      Math.abs(event.deltaY) < 1
    ) {
      return;
    }
    event.preventDefault();
    setZoom((currentZoom) => zoomAfterWheel(currentZoom, event.deltaY));
  }, []);

  const startPreviewPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !previewReady || zoom <= DEFAULT_PREVIEW_ZOOM) {
      return;
    }
    const viewport = event.currentTarget;
    previewPanStateRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: viewport.scrollLeft,
      startScrollTop: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    setIsDragging(true);
    event.preventDefault();
  };

  const movePreviewPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = previewPanStateRef.current;
    if (!pan.active || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.currentTarget.scrollLeft =
      pan.startScrollLeft - (event.clientX - pan.startX);
    event.currentTarget.scrollTop =
      pan.startScrollTop - (event.clientY - pan.startY);
  };

  const finishPreviewPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = previewPanStateRef.current;
    if (!pan.active || pan.pointerId !== event.pointerId) return;
    pan.active = false;
    pan.pointerId = -1;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDragging(false);
  };

  const setPreviewViewport = useCallback(
    (viewport: HTMLDivElement | null) => {
      const current = previewViewportRef.current;
      if (current === viewport) return;
      current?.removeEventListener('wheel', handlePreviewWheel);
      previewViewportRef.current = viewport;
      viewport?.addEventListener('wheel', handlePreviewWheel, {
        passive: false,
      });
    },
    [handlePreviewWheel],
  );

  useEffect(() => {
    if (!open) return;
    const requestedIndex =
      contract?.attachments.findIndex(
        (item) => item.accessId === initialAccessId,
      ) ?? -1;
    const nextIndex = requestedIndex >= 0 ? requestedIndex : 0;
    const requestedAttachment = contract?.attachments[nextIndex];
    setAttachmentIndex(nextIndex);
    setPage(
      Math.min(
        Math.max(1, initialPage || 1),
        Math.max(1, requestedAttachment?.pageCount || 1),
      ),
    );
    setManifest(null);
    setImageError(false);
    setImageLoading(true);
    setZoom(DEFAULT_PREVIEW_ZOOM);
    setManifestError(false);
    setImageRetryKey(0);
    setPreviewTimedOut(false);
    previewPanStateRef.current.active = false;
    setIsDragging(false);
  }, [contract, initialAccessId, initialPage, open]);

  useEffect(() => {
    if (!open || !attachment?.accessId || !canPreview) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    let failedAttempts = 0;
    let processingPolls = 0;
    setManifestError(false);
    setPreviewTimedOut(false);
    const refreshManifest = async () => {
      try {
        const next = await getContractAttachmentManifest(attachment.accessId);
        if (cancelled) return;
        failedAttempts = 0;
        setManifestError(false);
        setManifest(next);
        if (next.previewStatus === 'processing') {
          processingPolls += 1;
          const pollDelay = getManifestProcessingPollDelay(processingPolls);
          if (pollDelay === null) setPreviewTimedOut(true);
          else timer = window.setTimeout(refreshManifest, pollDelay);
        } else {
          setPreviewTimedOut(false);
        }
      } catch {
        if (cancelled) return;
        failedAttempts += 1;
        const retryDelay = getManifestRetryDelay(failedAttempts);
        if (retryDelay === null) setManifestError(true);
        else timer = window.setTimeout(refreshManifest, retryDelay);
      }
    };
    void refreshManifest();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [attachment?.accessId, manifestRetryKey, open, canPreview]);

  useEffect(() => {
    if (!previewReady || !attachment || page >= pageCount) return;
    const nextImage = new Image();
    nextImage.src = getContractAttachmentPageUrl(attachment.accessId, page + 1);
  }, [attachment, page, pageCount, previewReady]);

  const changeAttachment = (nextIndex: number) => {
    if (nextIndex === attachmentIndex) return;
    setAttachmentIndex(nextIndex);
    setPage(1);
    setManifest(null);
    setImageError(false);
    setImageLoading(true);
    setZoom(DEFAULT_PREVIEW_ZOOM);
    setManifestError(false);
    setImageRetryKey(0);
    setPreviewTimedOut(false);
    previewPanStateRef.current.active = false;
    setIsDragging(false);
  };

  const changePage = (nextPage: number) => {
    if (nextPage < 1 || nextPage > pageCount || nextPage === page) return;
    setImageLoading(true);
    setImageError(false);
    setPage(nextPage);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[96dvh] w-[98vw] max-w-[1600px] flex-col gap-0 overflow-hidden border-blue-100 p-0 shadow-2xl">
        <header className="shrink-0 border-b border-blue-800/40 bg-gradient-to-r from-blue-700 via-blue-700 to-blue-800 px-4 py-2.5 text-white sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5 pr-9">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15">
              <Eye className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 flex-1 items-baseline gap-3">
              <DialogTitle className="shrink-0 text-base font-bold">
                合同在线阅读
              </DialogTitle>
              <DialogDescription className="truncate text-xs text-blue-100">
                {contract?.code || '编号待补充'} ·{' '}
                {contract?.name || '合同原件'}
              </DialogDescription>
            </div>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 bg-slate-100 lg:grid-cols-[230px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto border-b border-slate-200 bg-white p-3 lg:border-b-0 lg:border-r">
            <p className="mb-2 text-xs font-semibold text-slate-500">
              合同附件
            </p>
            <div className="space-y-2">
              {contract?.attachments.map((item, index) => {
                const itemManifest =
                  attachmentIndex === index ? effectiveManifest : item;
                return (
                  <button
                    key={item.accessId}
                    type="button"
                    onClick={() => changeAttachment(index)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                      attachmentIndex === index
                        ? 'border-blue-300 bg-blue-50 text-blue-800'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-blue-50/60',
                    )}
                  >
                    <FileText className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="min-w-0">
                      <span className="block break-all text-xs font-semibold leading-5">
                        {item.name}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-slate-500">
                        {attachmentIndex === index && storageUnavailable
                          ? '附件暂不可用'
                          : itemManifest?.previewStatus === 'ready'
                            ? `${itemManifest.pageCount} 页`
                            : itemManifest?.previewStatus === 'failed'
                              ? '预览生成失败'
                              : '安全预览生成中'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-5 border-t border-slate-100 pt-4">
              <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-700">
                  <ShieldCheck className="h-4 w-4" />
                  合同附件权限
                </div>
                {attachment && !storageUnavailable && canDownload && (
                  <a
                    href={getContractAttachmentDownloadUrl(attachment.accessId)}
                    className="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                  >
                    <Download className="h-3.5 w-3.5" />
                    下载合同原件
                  </a>
                )}
              </div>
            </div>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col">
            <div
              ref={setPreviewViewport}
              data-contract-preview-viewport="true"
              aria-label="合同阅读主窗口，支持鼠标滚轮缩放和拖拽移动"
              tabIndex={0}
              onPointerDown={startPreviewPan}
              onPointerMove={movePreviewPan}
              onPointerUp={finishPreviewPan}
              onPointerCancel={finishPreviewPan}
              onLostPointerCapture={finishPreviewPan}
              style={{
                touchAction: zoom > DEFAULT_PREVIEW_ZOOM ? 'none' : 'auto',
              }}
              className={cn(
                'flex min-h-0 flex-1 items-center justify-center overflow-auto overscroll-contain p-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 sm:p-3',
                previewReady &&
                  zoom > DEFAULT_PREVIEW_ZOOM &&
                  (isDragging ? 'cursor-grabbing' : 'cursor-grab'),
              )}
            >
              {!attachment ? (
                <PreviewMessage icon={FileText} label="暂无合同附件" />
              ) : !canPreview ? (
                <PreviewMessage icon={ShieldCheck} label="当前账号无此合同附件的预览权限" />
              ) : storageUnavailable ? (
                <PreviewMessage
                  icon={AlertCircle}
                  label="合同附件暂不可用，请联系管理员恢复存储配置"
                  danger
                />
              ) : previewReady && imageError ? (
                <PreviewMessage
                  icon={AlertCircle}
                  label="当前预览页加载失败"
                  danger
                  action={
                    <button
                      type="button"
                      onClick={() => {
                        setImageError(false);
                        setImageLoading(true);
                        setImageRetryKey((value) => value + 1);
                      }}
                      className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      重新加载当前页
                    </button>
                  }
                />
              ) : previewReady ? (
                <div
                  data-contract-preview-canvas="true"
                  className="relative flex min-h-full min-w-full shrink-0 items-center justify-center"
                  style={{
                    width: `${Math.max(DEFAULT_PREVIEW_ZOOM, zoom) * 100}%`,
                    height: `${Math.max(DEFAULT_PREVIEW_ZOOM, zoom) * 100}%`,
                  }}
                >
                  {imageLoading && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-100/80">
                      <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                    </div>
                  )}
                  <img
                    key={`${attachment.accessId}:${page}:${imageRetryKey}`}
                    src={getContractAttachmentPageUrl(
                      attachment.accessId,
                      page,
                    )}
                    alt={`${attachment.name} 第 ${page} 页`}
                    draggable={false}
                    onContextMenu={(event) => event.preventDefault()}
                    onLoad={() => setImageLoading(false)}
                    onError={() => {
                      setImageLoading(false);
                      setImageError(true);
                    }}
                    style={{
                      width:
                        zoom < DEFAULT_PREVIEW_ZOOM ? `${zoom * 100}%` : '100%',
                      height:
                        zoom < DEFAULT_PREVIEW_ZOOM ? `${zoom * 100}%` : '100%',
                    }}
                    className="select-none rounded-sm bg-white object-contain shadow-lg shadow-slate-900/15"
                  />
                </div>
              ) : effectiveManifest?.originalAvailable && canDownload ? (
                <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                  <div className="flex shrink-0 items-center justify-between gap-3 border-b border-blue-100 bg-blue-50 px-4 py-2 text-xs text-blue-800">
                    <span className="font-semibold">
                      在线显示合同原件，水印预览正在后台准备
                    </span>
                    <a
                      href={getContractAttachmentInlineUrl(attachment.accessId)}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 font-semibold underline underline-offset-2"
                    >
                      新窗口打开
                    </a>
                  </div>
                  <iframe
                    title={`${attachment.name} 在线原件`}
                    src={getContractAttachmentInlineUrl(attachment.accessId)}
                    className="min-h-0 flex-1 border-0 bg-white"
                  />
                </div>
              ) : manifestError ? (
                <PreviewMessage
                  icon={AlertCircle}
                  label="预览状态读取失败，请检查网络后重试"
                  danger
                  action={
                    <button
                      type="button"
                      onClick={() => setManifestRetryKey((value) => value + 1)}
                      className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      重新读取预览状态
                    </button>
                  }
                />
              ) : previewTimedOut ? (
                <PreviewMessage
                  icon={AlertCircle}
                  label="安全预览准备时间较长，可重新检查或下载原件"
                  action={
                    <button
                      type="button"
                      onClick={() => setManifestRetryKey((value) => value + 1)}
                      className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      重新检查预览
                    </button>
                  }
                />
              ) : effectiveManifest?.previewStatus === 'failed' ? (
                <PreviewMessage
                  icon={AlertCircle}
                  label="安全预览生成失败，可下载原件或联系管理员处理"
                  danger
                />
              ) : (
                <PreviewMessage
                  icon={Loader2}
                  label="正在生成密文水印预览，完成后会自动显示"
                  spinning
                />
              )}
            </div>

            <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-white px-3 py-2 sm:px-4">
              <button
                type="button"
                disabled={!previewReady || page <= 1}
                onClick={() => changePage(page - 1)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
                上一页
              </button>
              <div className="flex items-center gap-3">
                <span className="text-center text-xs font-semibold tabular-nums text-slate-600">
                  <span className="block">
                    {previewReady
                      ? `第 ${page} / ${pageCount} 页`
                      : effectiveManifest?.originalAvailable
                        ? 'COS 原件'
                        : storageUnavailable
                          ? '预览不可用'
                          : '预览准备中'}
                  </span>
                  {previewReady && (
                    <span className="mt-0.5 hidden text-[10px] font-normal text-slate-400 sm:block">
                      滚轮缩放 · 拖拽移动
                    </span>
                  )}
                </span>
                <div
                  role="group"
                  aria-label="合同预览缩放控制"
                  className="inline-flex h-9 items-center overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
                >
                  <button
                    type="button"
                    aria-label="缩小合同预览"
                    disabled={!previewReady || zoom <= MIN_PREVIEW_ZOOM}
                    onClick={() =>
                      setZoom((currentZoom) => zoomAfterWheel(currentZoom, 100))
                    }
                    className="inline-flex h-full w-9 items-center justify-center text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ZoomOut className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="恢复合同预览为适合页面"
                    disabled={!previewReady}
                    onClick={() => setZoom(DEFAULT_PREVIEW_ZOOM)}
                    className="h-full min-w-14 border-x border-slate-200 px-2 text-xs font-semibold tabular-nums text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <button
                    type="button"
                    aria-label="放大合同预览"
                    disabled={!previewReady || zoom >= MAX_PREVIEW_ZOOM}
                    onClick={() =>
                      setZoom((currentZoom) =>
                        zoomAfterWheel(currentZoom, -100),
                      )
                    }
                    className="inline-flex h-full w-9 items-center justify-center text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ZoomIn className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <button
                type="button"
                disabled={!previewReady || page >= pageCount}
                onClick={() => changePage(page + 1)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                下一页
                <ChevronRight className="h-4 w-4" />
              </button>
            </footer>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewMessage({
  icon: Icon,
  label,
  danger = false,
  spinning = false,
  action,
}: {
  icon: typeof FileText;
  label: string;
  danger?: boolean;
  spinning?: boolean;
  action?: ReactNode;
}) {
  return (
    <div
      role={danger ? 'alert' : 'status'}
      className={cn(
        'flex max-w-md flex-col items-center gap-3 rounded-xl border bg-white px-8 py-10 text-center text-sm shadow-sm',
        danger
          ? 'border-rose-200 text-rose-700'
          : 'border-blue-100 text-slate-600',
      )}
    >
      <Icon
        className={cn(
          'h-7 w-7',
          danger ? 'text-rose-500' : 'text-blue-600',
          spinning && 'animate-spin',
        )}
      />
      <span>{label}</span>
      {action}
    </div>
  );
}
