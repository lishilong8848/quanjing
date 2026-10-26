import {
  AlertTriangle,
  CalendarClock,
  Clock3,
  Hash,
  LockKeyhole,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { SealingInfo } from '@shared/api.interface';

import type { NetworkFreezeDetailModel } from './overview-model';
import {
  buildSealingTimelineModel,
  getSealingTimelineRecordKey,
  type SealingTimelineModel,
} from './sealing-timeline-model';

import './styles.css';

type SealingLoadState = 'loading' | 'ready' | 'error';

interface SealingDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: NetworkFreezeDetailModel;
  loadState: SealingLoadState;
  restoreFocusTo?: HTMLElement | null;
}

const shanghaiDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return shanghaiDateTimeFormatter.format(timestamp).replace(/\//g, '-');
}

function getSealingReference(item: SealingInfo): string {
  return item.sealingCode.trim() || item.autoNumber?.trim() || '未维护';
}

function SealingGroup({
  id,
  title,
  items,
  registerSealingRow,
}: {
  id: string;
  title: string;
  items: readonly SealingInfo[];
  registerSealingRow: (recordKey: string, node: HTMLLIElement | null) => void;
}) {
  return (
    <section
      className="today-panorama-sealing-group"
      aria-labelledby={`${id}-title`}
    >
      <header className="today-panorama-sealing-group-head">
        <h3 id={`${id}-title`}>{title}</h3>
        <span>{items.length} 条</span>
      </header>

      {items.length > 0 ? (
        <ol
          className="today-panorama-sealing-list"
          aria-label={`${title}，共 ${items.length} 条`}
        >
          {items.map((item) => {
            const recordKey = getSealingTimelineRecordKey(item);
            return (
              <li
                className="today-panorama-detail-row today-panorama-sealing-row"
                key={recordKey}
                ref={(node) => registerSealingRow(recordKey, node)}
                tabIndex={-1}
              >
                <div className="today-panorama-sealing-main">
                  <div className="today-panorama-sealing-identity">
                    <span>{title}</span>
                    <b>{getSealingReference(item)}</b>
                  </div>
                  <h4>{item.sealingName.trim() || '未命名封网安排'}</h4>
                </div>

                <dl className="today-panorama-sealing-meta">
                  <div>
                    <dt>
                      <Hash aria-hidden="true" />
                      <span>封网编号</span>
                    </dt>
                    <dd>{getSealingReference(item)}</dd>
                  </div>
                  <div>
                    <dt>
                      <ShieldCheck aria-hidden="true" />
                      <span>管控类型</span>
                    </dt>
                    <dd>{item.sealingType?.trim() || '类型未维护'}</dd>
                  </div>
                  <div>
                    <dt>
                      <CalendarClock aria-hidden="true" />
                      <span>开始时间</span>
                    </dt>
                    <dd>
                      <time dateTime={item.startDate}>
                        {formatDateTime(item.startDate)}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <CalendarClock aria-hidden="true" />
                      <span>结束时间</span>
                    </dt>
                    <dd>
                      <time dateTime={item.endDate}>
                        {formatDateTime(item.endDate)}
                      </time>
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="today-panorama-sealing-empty">
          <AlertTriangle aria-hidden="true" />
          <span>{title}暂无记录</span>
        </div>
      )}
    </section>
  );
}

function SealingTimeline({
  model,
  focusSealingRecord,
}: {
  model: SealingTimelineModel;
  focusSealingRecord: (recordKey: string) => void;
}) {
  if (model.status === 'error') {
    return (
      <section className="today-panorama-sealing-timeline is-error">
        <AlertTriangle aria-hidden="true" />
        <span>未来 7 天时段图暂不可用</span>
      </section>
    );
  }

  return (
    <section
      className="today-panorama-sealing-timeline"
      aria-labelledby="sealing-timeline-title"
    >
      <header className="today-panorama-sealing-timeline-head">
        <div>
          <span aria-hidden="true">
            <Clock3 />
          </span>
          <div>
            <h3 id="sealing-timeline-title">未来 7 天封网时段</h3>
            <p>未来 168 小时连续视图</p>
          </div>
        </div>
        <div className="today-panorama-sealing-timeline-tools">
          <span className="today-panorama-sealing-timeline-granularity">
            小时颗粒度
          </span>
          <div
            className="today-panorama-sealing-timeline-legend"
            aria-label="图例"
          >
            <span className="is-sealed">封网时段</span>
          </div>
        </div>
      </header>

      <div
        className="today-panorama-sealing-timeline-chart"
        aria-label="未来 7 天封网时段"
      >
        <div className="today-panorama-sealing-timeline-gantt">
          <div className="today-panorama-sealing-timeline-gantt-head">
            <span className="today-panorama-sealing-timeline-column-title">
              封网事项
            </span>
            <div className="today-panorama-sealing-timeline-axis-head">
              <div className="today-panorama-sealing-timeline-date-strip">
                {model.days.map((day) => (
                  <span key={day.dateKey}>
                    <strong>{day.dateLabel}</strong>
                    <small>{day.weekdayLabel}</small>
                  </span>
                ))}
              </div>
              <div
                className="today-panorama-sealing-timeline-hours"
                aria-hidden="true"
              >
                {Array.from({ length: 28 }, (_, index) => (
                  <span key={index}>
                    {String((index % 4) * 6).padStart(2, '0')}
                  </span>
                ))}
              </div>
            </div>
          </div>
          {model.segments.length > 0 ? (
            <ol className="today-panorama-sealing-timeline-records">
              {model.segments.map((segment) => {
                const reference = getSealingReference(segment.item);
                const name =
                  segment.item.sealingName.trim() || '未命名封网安排';
                const type = segment.item.sealingType?.trim() || '类型未维护';
                const exactTime = `${formatDateTime(
                  segment.item.startDate,
                )} 至 ${formatDateTime(segment.item.endDate)}`;

                return (
                  <li
                    className="today-panorama-sealing-timeline-record"
                    key={segment.key}
                  >
                    <div className="today-panorama-sealing-timeline-record-info">
                      <strong>{name}</strong>
                      <div>
                        <span>{reference}</span>
                        <span>{type}</span>
                      </div>
                      <time>{exactTime}</time>
                    </div>
                    <div
                      className="today-panorama-sealing-timeline-track"
                      aria-label={`${name}，${exactTime}`}
                    >
                      <button
                        type="button"
                        className="today-panorama-sealing-timeline-segment"
                        data-compact={
                          segment.widthPercent < 9 ? 'true' : 'false'
                        }
                        data-edge={
                          segment.leftPercent < 8
                            ? 'start'
                            : segment.leftPercent + segment.widthPercent > 92
                              ? 'end'
                              : 'middle'
                        }
                        style={
                          {
                            '--timeline-left': `${segment.leftPercent}%`,
                            '--timeline-width': `${segment.widthPercent}%`,
                          } as CSSProperties
                        }
                        aria-label={`${name}，编号 ${reference}，${type}，${exactTime}，点击定位清单`}
                        title={`${name}｜${reference}｜${type}｜${exactTime}`}
                        onClick={() => focusSealingRecord(segment.recordKey)}
                      >
                        <span>{segment.visibleTimeLabel}</span>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="today-panorama-sealing-timeline-empty-row">
              <span>未来 7 天暂无封网安排</span>
              <div
                className="today-panorama-sealing-timeline-track"
                aria-hidden="true"
              />
            </div>
          )}
        </div>
        <div className="today-panorama-sealing-timeline-scale">
          <span>起点 · {model.days[0]?.dateLabel} 00:00</span>
          <span>每 6 小时标注 · 每天一段</span>
          <span>终点 · 第 8 日 00:00</span>
        </div>
      </div>
    </section>
  );
}

export function SealingDetailDialog({
  open,
  onOpenChange,
  model,
  loadState,
  restoreFocusTo,
}: SealingDetailDialogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sealingRowRefs = useRef(new Map<string, HTMLLIElement>());
  const total = model.todayItems.length + model.nextSevenDaysItems.length;
  const timelineModel = useMemo(
    () =>
      buildSealingTimelineModel(
        [...model.todayItems, ...model.nextSevenDaysItems],
        model.businessDate,
      ),
    [model.businessDate, model.nextSevenDaysItems, model.todayItems],
  );

  const registerSealingRow = (
    recordKey: string,
    node: HTMLLIElement | null,
  ) => {
    if (node) {
      sealingRowRefs.current.set(recordKey, node);
      return;
    }
    sealingRowRefs.current.delete(recordKey);
  };

  const focusSealingRecord = (recordKey: string) => {
    const row = sealingRowRefs.current.get(recordKey);
    if (!row) return;
    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    row.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'center',
    });
    window.requestAnimationFrame(() => row.focus({ preventScroll: true }));
  };

  useLayoutEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTop = 0;
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="today-panorama-detail-dialog today-panorama-sealing-dialog flex max-h-[min(90dvh,920px)] w-[min(1440px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-slate-200 p-0"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocusTo?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader className="today-panorama-operations-dialog-head today-panorama-sealing-dialog-head flex-row items-start gap-3 border-b border-slate-200 px-5 py-4 text-left sm:px-6">
          <span
            className="today-panorama-operations-dialog-icon today-panorama-sealing-dialog-icon"
            aria-hidden="true"
          >
            <LockKeyhole />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-lg leading-6 text-slate-950">
              封网安排清单
            </DialogTitle>
            <DialogDescription className="today-panorama-operations-dialog-summary mt-1 text-sm text-slate-500">
              <span>数据日期 {model.businessDate}</span>
              <strong>今日 {model.todayItems.length} 条</strong>
              <span>未来 7 天 {model.nextSevenDaysItems.length} 条</span>
              <span>共 {total} 条</span>
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="today-panorama-dialog-close shrink-0 text-slate-500"
              aria-label="关闭封网安排清单"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        {loadState === 'loading' ? (
          <div
            className="today-panorama-sealing-source-state is-loading"
            role="status"
          >
            封网数据正在刷新，清单将在同步完成后自动更新
          </div>
        ) : null}
        {loadState === 'error' && model.status === 'ready' ? (
          <div
            className="today-panorama-sealing-source-state is-stale"
            role="status"
          >
            封网数据同步暂时失败，当前展示最近一次成功同步的数据
          </div>
        ) : null}

        <div
          ref={scrollRef}
          className="today-panorama-operations-scroll today-panorama-sealing-scroll min-h-0 flex-1 overflow-y-auto"
          tabIndex={0}
          aria-label="封网安排清单滚动区域"
        >
          <div className="today-panorama-sealing-groups">
            <SealingTimeline
              model={timelineModel}
              focusSealingRecord={focusSealingRecord}
            />
            <SealingGroup
              id="today-sealings"
              title="今日封网"
              items={model.todayItems}
              registerSealingRow={registerSealingRow}
            />
            <SealingGroup
              id="upcoming-sealings"
              title="未来 7 天封网"
              items={model.nextSevenDaysItems}
              registerSealingRow={registerSealingRow}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
