import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock3,
  ImageIcon,
  MessageSquareText,
  ShieldCheck,
  UserRoundCheck,
} from 'lucide-react';
import type {
  SystemMonthlyReportArchivedAttachment,
  SystemMonthlyReportDashboard,
  SystemMonthlyReportReviewOpinion,
} from '@shared/system-monthly-report.interface';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { getSystemMonthlyReportArchiveDownloadUrl } from './api';
import { systemMonthlyReportPeriodKey } from './overview.logic';
import { buildSystemMonthlyReportReviewOpinionModel } from './review-opinions.logic';

const signedImageCache = new Map<string, Promise<string>>();

export function ReviewOpinionsView({
  dashboard,
  selectedPeriodKey,
}: {
  dashboard: SystemMonthlyReportDashboard;
  selectedPeriodKey: string;
}) {
  const [year, month] = selectedPeriodKey.split('-').map(Number);
  const roomNames = useMemo(() => {
    const currentKey = systemMonthlyReportPeriodKey(
      dashboard.period.year,
      dashboard.period.month,
    );
    if (selectedPeriodKey === currentKey)
      return dashboard.rooms.map((room) => room.room);
    return (
      dashboard.monthlySnapshots
        .find(
          (snapshot) =>
            systemMonthlyReportPeriodKey(snapshot.year, snapshot.month) ===
            selectedPeriodKey,
        )
        ?.rooms.map((room) => room.room) || []
    );
  }, [dashboard, selectedPeriodKey]);
  const model = useMemo(
    () =>
      buildSystemMonthlyReportReviewOpinionModel(
        roomNames,
        dashboard.reviewOpinions,
        dashboard.schedule,
        year,
        month,
      ),
    [dashboard.reviewOpinions, dashboard.schedule, month, roomNames, year],
  );
  const metrics = [
    ['机房总数', model.summary.totalRooms, 'text-slate-900'],
    ['初审已完成', model.summary.initialReviewedRooms, 'text-blue-600'],
    ['复审已完成', model.summary.recheckReviewedRooms, 'text-teal-600'],
    ['存在问题', model.summary.issueRooms, 'text-orange-600'],
  ] as const;

  return (
    <div className="space-y-3">
      <Card className="border-slate-200 bg-white shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle className="text-xl">审核意见</CardTitle>
              <p className="mt-1 text-sm text-slate-500">
                {year}年{month}月 · 按机房对照初审与复审结果
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {metrics.map(([label, value, tone]) => (
                <div
                  key={label}
                  className="min-w-24 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"
                >
                  <p className="text-[11px] text-slate-400">{label}</p>
                  <p className={cn('mt-0.5 text-lg font-semibold', tone)}>
                    {value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </CardHeader>
      </Card>

      {model.rows.length ? (
        model.rows.map((row) => (
          <Card
            key={row.room}
            className="overflow-hidden border-slate-200 bg-white shadow-sm"
          >
            <CardContent className="p-0">
              <div className="grid min-[1100px]:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)]">
                <div className="border-b border-slate-100 bg-slate-50/80 p-5 min-[1100px]:border-b-0 min-[1100px]:border-r">
                  <p className="text-lg font-semibold text-slate-950">
                    {row.room}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">两轮意见对照</p>
                </div>
                <OpinionPanel title="初审意见" opinion={row.initial} />
                <OpinionPanel
                  title="复审意见"
                  opinion={row.recheck}
                  className="border-t min-[1100px]:border-l min-[1100px]:border-t-0"
                />
              </div>
            </CardContent>
          </Card>
        ))
      ) : (
        <Card className="border-slate-200 bg-white">
          <CardContent className="flex min-h-56 flex-col items-center justify-center text-center">
            <MessageSquareText className="h-10 w-10 text-slate-300" />
            <p className="mt-3 font-medium text-slate-600">
              该月份暂无审核意见
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function OpinionPanel({
  title,
  opinion,
  className,
}: {
  title: string;
  opinion: SystemMonthlyReportReviewOpinion | null;
  className?: string;
}) {
  const [preview, setPreview] =
    useState<SystemMonthlyReportArchivedAttachment | null>(null);
  if (!opinion) {
    return (
      <section
        className={cn(
          'flex min-h-48 flex-col items-center justify-center p-5 text-center',
          className,
        )}
      >
        <Clock3 className="h-7 w-7 text-slate-300" />
        <p className="mt-2 text-sm font-medium text-slate-500">
          {title}尚未提交
        </p>
      </section>
    );
  }
  return (
    <section className={cn('min-w-0 p-5', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <p className="mt-1 flex items-center gap-1 text-xs text-slate-400">
            <UserRoundCheck className="h-3.5 w-3.5" />
            {opinion.reviewer?.name || '审核人未记录'} ·{' '}
            {formatDateTime(opinion.submittedAt)}
          </p>
        </div>
        <Badge
          variant="outline"
          className={
            opinion.conclusion === 'passed'
              ? 'border-teal-100 bg-teal-50 text-teal-700'
              : 'border-orange-100 bg-orange-50 text-orange-700'
          }
        >
          {opinion.conclusion === 'passed' ? '审核通过' : '发现问题'}
        </Badge>
      </div>
      <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">
        <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-slate-500">
          <ShieldCheck className="h-4 w-4" />
          审核结论
        </div>
        <p className="whitespace-pre-line">{opinion.summary}</p>
      </div>
      {opinion.issues.length ? (
        <div className="mt-3 space-y-2">
          {opinion.issues.map((issue) => (
            <div key={issue.key} className="flex gap-3 text-sm">
              <span className="w-16 shrink-0 font-medium text-slate-500">
                {issue.label}
              </span>
              <span className="text-slate-700">{issue.description}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 flex items-center gap-2 text-sm text-teal-600">
          <CheckCircle2 className="h-4 w-4" />
          本轮未记录具体问题项
        </p>
      )}
      {opinion.images.length ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {opinion.images.slice(0, 3).map((image) => (
            <ReviewImage
              key={image.id}
              image={image}
              onPreview={() => setPreview(image)}
            />
          ))}
          {opinion.images.length > 3 ? (
            <button
              type="button"
              className="flex h-16 w-20 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-xs text-blue-600"
              onClick={() => setPreview(opinion.images[3])}
            >
              +{opinion.images.length - 3} 张
            </button>
          ) : null}
        </div>
      ) : null}
      <ImagePreview
        image={preview}
        onOpenChange={(open) => !open && setPreview(null)}
      />
    </section>
  );
}

function ReviewImage({
  image,
  onPreview,
}: {
  image: SystemMonthlyReportArchivedAttachment;
  onPreview: () => void;
}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (image.status !== 'archived') return;
    let active = true;
    let request = signedImageCache.get(image.id);
    if (!request) {
      request = getSystemMonthlyReportArchiveDownloadUrl(image.id).then(
        (value) => value.url,
      );
      signedImageCache.set(image.id, request);
    }
    void request
      .then((value) => active && setUrl(value))
      .catch(() => signedImageCache.delete(image.id));
    return () => {
      active = false;
    };
  }, [image.id, image.status]);
  return (
    <button
      type="button"
      className="h-16 w-20 overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
      onClick={onPreview}
      disabled={!url}
    >
      {url ? (
        <img
          src={url}
          alt={image.name}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="flex h-full flex-col items-center justify-center gap-1 text-[10px] text-slate-400">
          <ImageIcon className="h-4 w-4" />
          {image.status === 'error' ? '图片失败' : '图片加载中'}
        </span>
      )}
    </button>
  );
}

function ImagePreview({
  image,
  onOpenChange,
}: {
  image: SystemMonthlyReportArchivedAttachment | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    setUrl('');
    if (!image) return;
    const request =
      signedImageCache.get(image.id) ||
      getSystemMonthlyReportArchiveDownloadUrl(image.id).then(
        (value) => value.url,
      );
    signedImageCache.set(image.id, request);
    void request.then(setUrl).catch(() => setUrl(''));
  }, [image]);
  return (
    <Dialog open={Boolean(image)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{image?.name || '问题图片'}</DialogTitle>
          <DialogDescription className="sr-only">
            {image?.name || '审核问题图片'}预览
          </DialogDescription>
        </DialogHeader>
        {url ? (
          <img
            src={url}
            alt={image?.name || '审核问题图片'}
            className="max-h-[70vh] w-full rounded-lg bg-slate-50 object-contain"
          />
        ) : (
          <div className="flex min-h-56 items-center justify-center text-sm text-slate-400">
            图片加载中
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Shanghai',
      }).format(date);
}
