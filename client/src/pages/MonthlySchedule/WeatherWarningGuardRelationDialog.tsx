import { useRef } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  WeatherWarningColor,
  WeatherWarningDisplayWarning,
} from '@shared/api.interface';
import {
  getWeatherWarningDecisionPresentation,
  getWeatherWarningGuardLevelPresentation,
  getWeatherWarningRelationLabel,
  getWeatherWarningSummaryPresentation,
  type WeatherWarningDecisionKind,
  type WeatherWarningPresentationInput,
} from './weather-warning-presentation';

type WeatherWarningGuardRelationDialogProps = WeatherWarningPresentationInput;

const RELATION_DIALOG_TITLE_ID = 'weather-warning-relation-dialog-title';
const RELATION_DIALOG_DESCRIPTION_ID =
  'weather-warning-relation-dialog-description';

const WARNING_COLOR_PRESENTATION: Record<
  WeatherWarningColor,
  { label: string; className: string }
> = {
  red: {
    label: '红色',
    className: 'border-red-200 bg-red-50 text-red-800',
  },
  orange: {
    label: '橙色',
    className: 'border-orange-200 bg-orange-50 text-orange-800',
  },
  yellow: {
    label: '黄色',
    className: 'border-amber-200 bg-amber-50 text-amber-900',
  },
  blue: {
    label: '蓝色',
    className: 'border-blue-200 bg-blue-50 text-blue-800',
  },
};

function getWarningColorPresentation(
  color: WeatherWarningDisplayWarning['color'],
) {
  if (color) return WARNING_COLOR_PRESENTATION[color];
  return {
    label: '未分级',
    className: 'border-slate-200 bg-slate-50 text-slate-700',
  };
}

function RelationOutcomeIcon({
  kind,
  className,
}: {
  kind: WeatherWarningDecisionKind;
  className?: string;
}) {
  if (kind === 'guard_required') {
    return <ShieldAlert className={className} aria-hidden="true" />;
  }
  if (kind === 'no_guard_required') {
    return <ShieldCheck className={className} aria-hidden="true" />;
  }
  return <AlertTriangle className={className} aria-hidden="true" />;
}

export function WeatherWarningGuardRelationDialog({
  warningSnapshot,
  warningStatus,
  warningError,
  warningFailureKind,
}: WeatherWarningGuardRelationDialogProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const summary = getWeatherWarningSummaryPresentation({
    warningSnapshot,
    warningStatus,
    warningError,
    warningFailureKind,
  });
  const warningRelations = warningSnapshot
    ? [
        ...warningSnapshot.matchedWarnings.map((warning) => ({
          warning,
          matched: true,
        })),
        ...warningSnapshot.unmatchedWarnings.map((warning) => ({
          warning,
          matched: false,
        })),
      ]
    : [];
  const highestGuardPresentation = warningSnapshot?.guardLevel
    ? getWeatherWarningGuardLevelPresentation(warningSnapshot.guardLevel)
    : null;

  const handleDialogOpen = () => {
    if (!dialogRef.current?.open) {
      dialogRef.current?.showModal();
    }
  };

  const handleDialogClose = () => {
    triggerRef.current?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="查看重保与戒备对应关系"
        title="查看重保与戒备对应关系"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-blue-200 bg-white text-blue-600 shadow-sm transition-colors hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        onClick={handleDialogOpen}
      >
        <BookOpenCheck className="h-4 w-4" aria-hidden="true" />
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={RELATION_DIALOG_TITLE_ID}
        aria-describedby={RELATION_DIALOG_DESCRIPTION_ID}
        onClose={handleDialogClose}
        className="fixed inset-0 z-50 m-auto max-h-[min(86dvh,42rem)] w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/50"
      >
        <div className="relative border-b border-slate-100 bg-slate-50/80 px-5 py-4 pr-12 text-left">
          <h2
            id={RELATION_DIALOG_TITLE_ID}
            className="flex items-center gap-2 text-base font-semibold text-slate-900"
          >
            <BookOpenCheck
              className="h-5 w-5 text-blue-600"
              aria-hidden="true"
            />
            重保与戒备对应关系
          </h2>
          <p
            id={RELATION_DIALOG_DESCRIPTION_ID}
            className="mt-2 text-xs leading-5 text-slate-600"
          >
            依据“重保天气预警类型”多维表，展示当前有效预警判定结果
          </p>
          <button
            type="button"
            aria-label="关闭重保与戒备对应关系"
            className="absolute right-4 top-4 inline-flex size-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            onClick={() => dialogRef.current?.close()}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div
          className="max-h-[calc(min(86vh,42rem)-5.5rem)] overscroll-contain overflow-x-hidden overflow-y-auto px-5 py-4"
          tabIndex={0}
          aria-label="重保与戒备对应关系内容"
        >
          <section aria-labelledby="weather-warning-relation-list-title">
            <h3
              id="weather-warning-relation-list-title"
              className="text-xs font-semibold text-slate-700"
            >
              当前预警判定
            </h3>

            {warningRelations.length > 0 ? (
              <div className="mt-2 space-y-2.5">
                {warningRelations.map(({ warning, matched }) => {
                  const color = getWarningColorPresentation(warning.color);
                  const decision = getWeatherWarningDecisionPresentation({
                    warningSnapshot: warningSnapshot!,
                    warning,
                    matched,
                  });
                  const relationLabel = getWeatherWarningRelationLabel({
                    decision,
                    guardLevel: warning.guardLevel,
                  });

                  return (
                    <article
                      key={`${matched ? 'matched' : 'unmatched'}-${warning.id}`}
                      className="grid min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,0.82fr)]"
                    >
                      <div className="min-w-0">
                        <div className="break-words text-xs font-semibold leading-5 text-slate-900 [overflow-wrap:anywhere]">
                          {warning.title}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
                            {warning.type || '类型待确认'}
                          </span>
                          <span
                            className={cn(
                              'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
                              color.className,
                            )}
                          >
                            {color.label}
                          </span>
                        </div>
                      </div>

                      <ArrowRight
                        className="hidden h-4 w-4 text-slate-400 sm:block"
                        aria-hidden="true"
                      />

                      <div
                        className={cn(
                          'flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-xs font-semibold',
                          decision.badgeClassName,
                        )}
                      >
                        <RelationOutcomeIcon
                          kind={decision.kind}
                          className="h-4 w-4 shrink-0"
                        />
                        <span className="break-words [overflow-wrap:anywhere]">
                          {relationLabel}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-4 text-center">
                <div className="text-sm font-semibold text-slate-800">
                  {summary.title}
                </div>
                <div className="mt-1 text-xs leading-5 text-slate-600">
                  {summary.description}
                </div>
              </div>
            )}
          </section>

              {warningSnapshot?.guardLevel &&
                warningSnapshot.actions.length > 0 && (
                  <details className="group mt-4 border-t border-slate-100 pt-4">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-md px-1 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden">
                      <span>本次最高戒备等级与要求</span>
                      <span
                        className={cn(
                          'rounded-md border px-2 py-0.5 text-[11px] font-semibold',
                          highestGuardPresentation?.badgeClassName,
                        )}
                      >
                        {warningSnapshot.guardLevel}
                      </span>
                      <span className="ml-auto text-[11px] font-medium text-slate-500 group-open:hidden">
                        展开 {warningSnapshot.actions.length} 项要求
                      </span>
                      <span className="ml-auto hidden text-[11px] font-medium text-slate-500 group-open:inline">
                        收起要求
                      </span>
                    </summary>
                    <ol className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                      {warningSnapshot.actions.map((action, index) => (
                        <li
                          key={`${index}-${action}`}
                          className="flex gap-2 text-xs leading-5 text-slate-700"
                        >
                          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-white text-[10px] font-semibold text-blue-700 shadow-sm">
                            {index + 1}
                          </span>
                          <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                            {action}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}

          {(warningSnapshot?.sourceError || warningError) && (
            <div className="mt-4 break-words rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 [overflow-wrap:anywhere]">
              {warningSnapshot?.sourceError || warningError}
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
