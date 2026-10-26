import {
  AlertTriangle,
  Clock3,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  formatWeatherWarningTime,
  getWeatherWarningColorPresentation,
  getWeatherWarningDecisionPresentation,
  getWeatherWarningSummaryPresentation,
  getWeatherWarningTimePresentation,
  type WeatherWarningDecisionKind,
  type WeatherWarningPresentationInput,
  type WeatherWarningSummaryKind,
  type WeatherWarningTriggerTone,
} from './weather-warning-presentation';
import { WeatherWarningGuardRelationDialog } from './WeatherWarningGuardRelationDialog';
import { WeatherWarningInfoPopover } from './WeatherWarningInfoPopover';

type WeatherWarningSnapshotSummaryProps = WeatherWarningPresentationInput & {
  onRegisterGuard?: (warningId: string) => void;
};

const SUMMARY_TONE_CLASS: Record<WeatherWarningTriggerTone, string> = {
  info: 'border-blue-200 bg-blue-50/70 text-blue-800',
  success: 'border-emerald-200 bg-emerald-50/70 text-emerald-800',
  orange: 'border-orange-200 bg-orange-50/70 text-orange-900',
  warning: 'border-amber-200 bg-amber-50/70 text-amber-900',
  danger: 'border-red-200 bg-red-50/70 text-red-800',
};

function DecisionIcon({
  kind,
  className,
}: {
  kind: WeatherWarningDecisionKind | WeatherWarningSummaryKind;
  className?: string;
}) {
  if (kind === 'guard_required') {
    return <ShieldAlert className={className} aria-hidden="true" />;
  }
  if (kind === 'no_guard_required' || kind === 'no_warning') {
    return <ShieldCheck className={className} aria-hidden="true" />;
  }
  if (kind === 'decision_pending' || kind === 'stale') {
    return <Clock3 className={className} aria-hidden="true" />;
  }
  if (kind === 'loading') {
    return (
      <Loader2
        className={cn(className, 'animate-spin motion-reduce:animate-none')}
        aria-hidden="true"
      />
    );
  }
  return <AlertTriangle className={className} aria-hidden="true" />;
}

export function WeatherWarningSnapshotSummary({
  warningSnapshot,
  warningStatus,
  warningError,
  warningFailureKind,
  onRegisterGuard,
}: WeatherWarningSnapshotSummaryProps) {
  const summary = getWeatherWarningSummaryPresentation({
    warningSnapshot,
    warningStatus,
    warningError,
    warningFailureKind,
  });
  const warnings = warningSnapshot
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
  const visibleWarnings = warnings.slice(0, 2);
  const hiddenWarningCount = Math.max(
    0,
    warnings.length - visibleWarnings.length,
  );
  const snapshotTime = warningSnapshot
    ? formatWeatherWarningTime(
        warningSnapshot.lastSuccessAt || warningSnapshot.snapshotAt,
      )
    : '';
  return (
    <Card className="duty-weather-warning-summary flex min-h-0 flex-1 flex-col overflow-hidden border-blue-100 bg-white shadow-sm">
      <div className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="border-b border-slate-100 bg-slate-50/70 px-3.5 py-2.5">
          <span
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {summary.title}。{summary.description}
          </span>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900">
              <ShieldAlert
                className="h-4 w-4 shrink-0 text-blue-600"
                aria-hidden="true"
              />
              <span>天气预警与戒备</span>
            </div>
            {summary.warningCount > 0 && (
              <span className="rounded-md border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                {summary.warningCount} 条有效预警
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {snapshotTime && (
                <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                  <Clock3 className="h-3 w-3" aria-hidden="true" />
                  更新于 {snapshotTime}
                </span>
              )}
              <WeatherWarningGuardRelationDialog
                warningSnapshot={warningSnapshot}
                warningStatus={warningStatus}
                warningError={warningError}
                warningFailureKind={warningFailureKind}
              />
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-1 items-center justify-center p-2.5">
          <section
            aria-label="天气预警信息"
            className="mx-auto w-full max-w-lg"
          >
            {visibleWarnings.length > 0 ? (
              <div className="grid gap-2 xl:grid-cols-2">
                {visibleWarnings.map(({ warning, matched }) => {
                  const color = getWeatherWarningColorPresentation(
                    warning.color,
                  );
                  const decision = getWeatherWarningDecisionPresentation({
                    warningSnapshot: warningSnapshot!,
                    warning,
                    matched,
                  });
                  const time = getWeatherWarningTimePresentation(warning);
                  return (
                    <WeatherWarningInfoPopover
                      key={`${matched ? 'matched' : 'unmatched'}-${warning.id}`}
                      warningSnapshot={warningSnapshot}
                      warningStatus={warningStatus}
                      warningError={warningError}
                      warningFailureKind={warningFailureKind}
                      selectedWarningId={warning.id}
                      selectedWarningMatched={matched}
                      onRegisterGuard={onRegisterGuard}
                      trigger={
                        <button
                          type="button"
                          aria-label={`查看天气预警详情：${warning.title}`}
                          className="w-full rounded-lg border border-slate-200 bg-white p-2 text-left shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md active:translate-y-0 active:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 motion-reduce:transform-none motion-reduce:transition-none"
                        >
                          <div className="flex min-w-0 flex-wrap items-start gap-1.5">
                            <div className="min-w-0 flex-1 break-words text-xs font-semibold leading-5 text-slate-900 [overflow-wrap:anywhere]">
                              {warning.title}
                            </div>
                            <span
                              className={cn(
                                'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
                                color.badgeClassName,
                              )}
                            >
                              {color.label}
                            </span>
                          </div>
                          <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-5 text-slate-500">
                              <span>{warning.type || '类型待确认'}</span>
                              {time.label && <span>{time.label}</span>}
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                              <span
                                className={cn(
                                  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
                                  decision.badgeClassName,
                                )}
                              >
                                <DecisionIcon
                                  kind={decision.kind}
                                  className="h-3 w-3"
                                />
                                {decision.label}
                              </span>
                              {decision.guardCompleted && (
                                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                                  <ShieldCheck
                                    className="h-3 w-3"
                                    aria-hidden="true"
                                  />
                                  戒备完成
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      }
                    />
                  );
                })}
                {hiddenWarningCount > 0 && (
                  <div className="text-right text-[11px] text-slate-500 xl:col-span-2">
                    另有 {hiddenWarningCount} 条，点击上方预警标签查看全部
                  </div>
                )}
              </div>
            ) : (
              <div
                className={cn(
                  'flex min-h-16 items-center justify-center gap-3 rounded-lg border px-3 py-2.5',
                  SUMMARY_TONE_CLASS[summary.tone],
                )}
              >
                <DecisionIcon
                  kind={summary.kind}
                  className="h-6 w-6 shrink-0"
                />
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{summary.title}</div>
                  <div className="mt-1 text-xs leading-5 opacity-80">
                    {summary.description}
                  </div>
                </div>
              </div>
            )}
          </section>
        </CardContent>
      </div>
    </Card>
  );
}
