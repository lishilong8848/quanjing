import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ImageIcon, Loader2, RefreshCw } from 'lucide-react';
import {
  getTodayAttendanceCorrectionEvidence,
  getTodayAttendanceCorrectionEvidenceImage,
} from '@/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  TodayAttendanceCorrectionEvidenceManifest,
  TodayAttendanceCorrectionEvidenceQuery,
} from '@shared/today-attendance.interface';
import { getAttendanceCorrectionEvidenceErrorMessage } from './attendance-correction-evidence-error';

export { getAttendanceCorrectionEvidenceErrorMessage } from './attendance-correction-evidence-error';

export interface AttendanceCorrectionEvidenceTarget extends TodayAttendanceCorrectionEvidenceQuery {
  displayName: string;
  cardLabel: '上班' | '下班';
}

type EvidenceLoadState = 'idle' | 'loading' | 'syncing' | 'ready' | 'error';

const MAX_SYNC_POLLS = 12;

export function AttendanceCorrectionEvidenceDialog({
  target,
  onOpenChange,
}: {
  target: AttendanceCorrectionEvidenceTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = useState<EvidenceLoadState>('idle');
  const [manifest, setManifest] =
    useState<TodayAttendanceCorrectionEvidenceManifest | null>(null);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [imageErrors, setImageErrors] = useState<Record<number, string>>({});
  const [errorMessage, setErrorMessage] = useState('');
  const [retryToken, setRetryToken] = useState(0);
  const syncPoll = useRef({ key: '', count: 0 });
  const fallbackImage = useRef<(index: number) => void>(() => {});

  useEffect(() => {
    if (!target) {
      setState('idle');
      setManifest(null);
      setImageUrls([]);
      setImageErrors({});
      setErrorMessage('');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const objectUrls: string[] = [];
    const proxyRequests = new Set<number>();
    const proxyLanes = [
      Promise.resolve(),
      Promise.resolve(),
      Promise.resolve(),
    ];
    const loadProxyImage = (index: number) => {
      if (proxyRequests.has(index) || cancelled) return;
      proxyRequests.add(index);
      setImageUrls((current) =>
        current.map((url, i) => (i === index ? '' : url)),
      );
      setImageErrors((current) => {
        const next = { ...current };
        delete next[index];
        return next;
      });
      const lane = index % proxyLanes.length;
      proxyLanes[lane] = proxyLanes[lane].then(async () => {
        if (cancelled) return;
        try {
          const blob = await getTodayAttendanceCorrectionEvidenceImage(
            target,
            index,
            controller.signal,
          );
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          setImageUrls((current) =>
            current.map((value, i) => (i === index ? url : value)),
          );
        } catch (error) {
          if (!cancelled) {
            setImageErrors((current) => ({
              ...current,
              [index]: getAttendanceCorrectionEvidenceErrorMessage(error),
            }));
          }
        } finally {
          proxyRequests.delete(index);
        }
      });
      return proxyLanes[lane];
    };
    fallbackImage.current = (index) => {
      void loadProxyImage(index);
    };
    const targetKey = `${target.businessDate}|${target.entryKey}`;
    if (syncPoll.current.key !== targetKey) {
      syncPoll.current = { key: targetKey, count: 0 };
    }
    setState('loading');
    setManifest(null);
    setImageUrls([]);
    setImageErrors({});
    setErrorMessage('');
    void getTodayAttendanceCorrectionEvidence(target, controller.signal)
      .then((nextManifest) => {
        if (cancelled) return;
        if (
          nextManifest.businessDate !== target.businessDate ||
          nextManifest.entryKey !== target.entryKey ||
          !Number.isSafeInteger(nextManifest.imageCount) ||
          nextManifest.imageCount < 0 ||
          nextManifest.imageCount > 21 ||
          !Array.isArray(nextManifest.images) ||
          !['ready', 'syncing', 'failed'].includes(nextManifest.syncState) ||
          (nextManifest.syncState === 'ready' &&
            nextManifest.images.length !== nextManifest.imageCount) ||
          (nextManifest.syncState !== 'ready' &&
            nextManifest.images.length > nextManifest.imageCount) ||
          nextManifest.images.some(
            (image) =>
              !image ||
              typeof image.url !== 'string' ||
              (!(image.transport === 'proxy' && image.url === '') &&
                !image.url.startsWith('https://')),
          )
        ) {
          throw new Error('补卡举证清单无效');
        }
        setManifest(nextManifest);
        setImageUrls(nextManifest.images.map((image) => image.url));
        if (nextManifest.syncState === 'failed') {
          setErrorMessage(nextManifest.failureReason || '举证图片暂时无法读取');
          setState('error');
          return;
        }
        if (nextManifest.syncState === 'syncing') {
          if (syncPoll.current.count >= MAX_SYNC_POLLS) {
            setErrorMessage('举证图片仍在后台准备，请稍后重试');
            setState('error');
            return;
          }
          syncPoll.current.count += 1;
          setState('syncing');
          pollTimer = setTimeout(
            () => setRetryToken((value) => value + 1),
            Math.max(500, Math.min(nextManifest.retryAfterMs || 1_000, 3_000)),
          );
          return;
        }
        syncPoll.current.count = 0;
        setState('ready');
        nextManifest.images.forEach((image, index) => {
          if (image.transport === 'proxy') void loadProxyImage(index);
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setImageUrls([]);
          setErrorMessage(getAttendanceCorrectionEvidenceErrorMessage(error));
          setState('error');
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (pollTimer) clearTimeout(pollTimer);
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [retryToken, target]);

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86dvh] w-[min(94vw,760px)] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-slate-200 px-5 py-4 text-left">
          <DialogTitle className="text-base font-bold text-slate-950">
            补卡举证 · {target?.displayName || ''} {target?.cardLabel || ''}
          </DialogTitle>
          <DialogDescription className="sr-only">
            查看对应补卡审批中已同步的举证图片
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {state === 'loading' && (
            <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-sm text-slate-500">
              <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
              正在读取举证图片
            </div>
          )}
          {state === 'syncing' && (
            <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-center text-sm text-slate-500">
              <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
              举证图片正在准备，完成后自动显示
            </div>
          )}
          {state === 'error' && (
            <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-center">
              <AlertTriangle className="h-7 w-7 text-amber-500" />
              <p className="text-sm font-medium text-slate-700">
                {errorMessage || '举证图片暂时无法读取'}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  syncPoll.current.count = 0;
                  setRetryToken((value) => value + 1);
                }}
              >
                <RefreshCw className="mr-1.5 h-4 w-4" />
                重试
              </Button>
            </div>
          )}
          {state === 'ready' && manifest && imageUrls.length === 0 && (
            <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-center">
              <ImageIcon className="h-8 w-8 text-slate-300" />
              <p className="text-sm font-medium text-slate-700">
                补卡审批已同步，暂无可查看的举证图片
              </p>
            </div>
          )}
          {state === 'ready' && imageUrls.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {imageUrls.map((url, index) => (
                <figure
                  key={index}
                  className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
                >
                  {imageErrors[index] ? (
                    <div className="flex min-h-44 flex-col items-center justify-center gap-2 px-3 text-center text-sm text-slate-700">
                      <p>{imageErrors[index]}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => fallbackImage.current(index)}
                      >
                        重试图片 {index + 1}
                      </Button>
                    </div>
                  ) : url ? (
                    <img
                      src={url}
                      alt={`${manifest?.name || target?.displayName || '员工'}补卡举证 ${index + 1}`}
                      className="max-h-[58dvh] w-full object-contain"
                      onError={() => {
                        if (url.startsWith('blob:')) {
                          setImageErrors((current) => ({
                            ...current,
                            [index]: '举证图片内容无法显示，请重试',
                          }));
                        } else fallbackImage.current(index);
                      }}
                    />
                  ) : (
                    <div className="flex min-h-44 items-center justify-center text-sm text-slate-500">
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      正在读取图片 {index + 1}
                    </div>
                  )}
                  <figcaption className="border-t border-slate-200 px-3 py-2 text-center text-xs text-slate-500">
                    举证图片 {index + 1}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
