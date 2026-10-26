import {
  cloneElement,
  useId,
  useRef,
  type ComponentPropsWithRef,
  type ReactElement,
} from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileCheck2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  formatWeatherWarningTime,
  getWeatherWarningCheckProgressPresentation,
  getWeatherWarningColorPresentation,
  getWeatherWarningDetailScope,
  getWeatherWarningDecisionPresentation,
  getWeatherWarningGuardLevelPresentation,
  getWeatherWarningSummaryPresentation,
  getWeatherWarningTimePresentation,
  getWeatherWarningTriggerPresentation,
  type WeatherWarningPresentationInput,
  type WeatherWarningTriggerTone,
} from './weather-warning-presentation';
import { WEATHER_WARNING_CHECKLIST_URL } from './weather-warning-links';

export { getWeatherWarningTriggerPresentation } from './weather-warning-presentation';

type WeatherWarningInfoPopoverProps = WeatherWarningPresentationInput & {
  trigger?: ReactElement<ComponentPropsWithRef<'button'>, 'button'>;
  selectedWarningId?: string;
  selectedWarningMatched?: boolean;
  onRegisterGuard?: (
    warningId: string,
    returnFocusTarget?: HTMLButtonElement | null,
  ) => void;
};

const TRIGGER_TONE_CLASS: Record<WeatherWarningTriggerTone, string> = {
  info: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100',
  success:
    'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
  orange: 'border-orange-200 bg-orange-50 text-orange-800 hover:bg-orange-100',
  warning: 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100',
  danger: 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100',
};

export function WeatherWarningInfoPopover({
  warningSnapshot,
  warningStatus,
  warningError,
  warningFailureKind,
  trigger,
  selectedWarningId,
  selectedWarningMatched,
  onRegisterGuard,
}: WeatherWarningInfoPopoverProps) {
  const weatherWarningTriggerRef = useRef<HTMLButtonElement | null>(null);
  const weatherWarningPopoverId = useId();
  const weatherWarningTitleId = `${weatherWarningPopoverId}-title`;
  const weatherWarningListId = `${weatherWarningPopoverId}-warning-list`;
  const weatherGuardActionsId = `${weatherWarningPopoverId}-guard-actions`;
  const weatherGuardCheckId = `${weatherWarningPopoverId}-guard-check`;
  const presentation = getWeatherWarningTriggerPresentation({
    warningSnapshot,
    warningStatus,
    warningError,
    warningFailureKind,
  });
  const summary = getWeatherWarningSummaryPresentation({
    warningSnapshot,
    warningStatus,
    warningError,
    warningFailureKind,
  });
  const detailScope = getWeatherWarningDetailScope(
    {
      warningSnapshot,
      warningStatus,
      warningError,
      warningFailureKind,
    },
    selectedWarningId,
    selectedWarningMatched,
  );
  const warnings = detailScope.warnings;
  const registrationEnabled =
    warningSnapshot?.features?.registrationEnabled === true;
  const progressNotificationsEnabled =
    warningSnapshot?.features?.progressNotificationsEnabled === true;
  const registrationWarningId =
    selectedWarningId ?? warningSnapshot?.matchedWarnings[0]?.id;
  const checkProgress =
    warningSnapshot && progressNotificationsEnabled
      ? getWeatherWarningCheckProgressPresentation(warningSnapshot)
      : null;
  const snapshotTime = warningSnapshot
    ? formatWeatherWarningTime(
        warningSnapshot.lastSuccessAt || warningSnapshot.snapshotAt,
      )
    : '';
  const guardLevelPresentation = warningSnapshot?.guardLevel
    ? getWeatherWarningGuardLevelPresentation(warningSnapshot.guardLevel)
    : null;
  const guardColorPresentation = warningSnapshot?.matchedWarnings[0]?.color
    ? getWeatherWarningColorPresentation(
        warningSnapshot.matchedWarnings[0].color,
      )
    : null;
  const defaultTrigger = (
    <button
      type="button"
      aria-label={presentation.ariaLabel}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 motion-reduce:transition-none',
        TRIGGER_TONE_CLASS[presentation.tone],
      )}
    >
      {presentation.tone === 'success' ? (
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
      ) : presentation.tone === 'danger' ? (
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span>{presentation.label}</span>
    </button>
  );
  const resolvedTrigger = cloneElement(trigger ?? defaultTrigger, {
    ref: weatherWarningTriggerRef,
  });
  return (
    <Popover>
      <PopoverTrigger asChild>{resolvedTrigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        collisionPadding={12}
        aria-labelledby={weatherWarningTitleId}
        className="max-h-[min(70vh,36rem)] w-[min(92vw,28rem)] overflow-x-hidden overflow-y-auto overscroll-contain break-words border-slate-200 bg-white p-0 shadow-xl [overflow-wrap:anywhere] data-[state=open]:!animate-none data-[state=closed]:!animate-none"
      >
        <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
          <div className="min-w-0">
            <h2
              id={weatherWarningTitleId}
              className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900"
            >
              <ShieldAlert
                className="h-4 w-4 text-blue-600"
                aria-hidden="true"
              />
              {selectedWarningId ? '预警详情与戒备进展' : '预警与戒备信息'}
            </h2>
            <div className="mt-1 min-w-0 break-words text-xs leading-5 text-slate-600 [overflow-wrap:anywhere]">
              {detailScope.description}
            </div>
          </div>
          {snapshotTime && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
              <Clock3 className="h-3 w-3" aria-hidden="true" />
              最近有效快照：{snapshotTime}
            </div>
          )}
          {(warningSnapshot?.sourceError || warningError) && (
            <div className="mt-2 min-w-0 break-words rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-900 [overflow-wrap:anywhere]">
              {warningSnapshot?.sourceError || warningError}
            </div>
          )}
        </div>

        <div className="space-y-4 px-4 py-3">
          {warningSnapshot && warnings.length > 0 && (
            <section aria-labelledby={weatherWarningListId}>
              <h3
                id={weatherWarningListId}
                className="text-xs font-semibold text-slate-800"
              >
                {selectedWarningId
                  ? '当前预警'
                  : `有效天气预警（${warnings.length}）`}
              </h3>
              <div className="mt-2 space-y-2">
                {warnings.map(({ warning, matched }) => {
                  const color = getWeatherWarningColorPresentation(
                    warning.color,
                  );
                  const time = getWeatherWarningTimePresentation(warning);
                  const decision = warningSnapshot
                    ? getWeatherWarningDecisionPresentation({
                        warningSnapshot,
                        warning,
                        matched,
                      })
                    : null;
                  return (
                    <article
                      key={`${matched ? 'matched' : 'unmatched'}-${warning.id || warning.title}`}
                      className="rounded-lg border border-slate-200 bg-white p-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="min-w-0 flex-1 break-words text-xs font-semibold leading-5 text-slate-900 [overflow-wrap:anywhere]">
                          {warning.title}
                        </span>
                        <span
                          className={cn(
                            'rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
                            color.badgeClassName,
                          )}
                        >
                          {color.label}
                        </span>
                        {decision && (
                          <>
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
                                decision.badgeClassName,
                              )}
                            >
                              {decision.kind === 'guard_required' ? (
                                <ShieldAlert
                                  className="h-3 w-3"
                                  aria-hidden="true"
                                />
                              ) : decision.kind === 'no_guard_required' ? (
                                <ShieldCheck
                                  className="h-3 w-3"
                                  aria-hidden="true"
                                />
                              ) : decision.kind === 'decision_pending' ||
                                decision.kind === 'stale' ? (
                                <Clock3
                                  className="h-3 w-3"
                                  aria-hidden="true"
                                />
                              ) : (
                                <AlertTriangle
                                  className="h-3 w-3"
                                  aria-hidden="true"
                                />
                              )}
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
                          </>
                        )}
                      </div>
                      {(warning.type || time.label) && (
                        <div className="mt-1 min-w-0 break-words text-[11px] leading-5 text-slate-500 [overflow-wrap:anywhere]">
                          {warning.type && <span>{warning.type}</span>}
                          {warning.type && time.label && <span> · </span>}
                          {time.label && <span>{time.label}</span>}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {detailScope.isSecondaryGuardWarning && (
            <div className="rounded-md border border-blue-100 bg-blue-50/70 px-2.5 py-2 text-xs leading-5 text-blue-800">
              此预警已命中戒备规则，戒备进展归属于主预警，本卡不重复展示。
            </div>
          )}

          {detailScope.showGuardDetails && warningSnapshot?.guardLevel && (
            <section aria-labelledby={weatherGuardActionsId}>
              <div className="flex items-center justify-between gap-2">
                <h3
                  id={weatherGuardActionsId}
                  className="text-xs font-semibold text-slate-800"
                >
                  戒备行动
                </h3>
                <span
                  className={cn(
                    'rounded-md border px-2 py-1 text-[11px] font-semibold',
                    guardColorPresentation?.badgeClassName ??
                      guardLevelPresentation?.badgeClassName,
                  )}
                >
                  {warningSnapshot.guardLevel}
                </span>
              </div>
              {warningSnapshot.actions.length > 0 ? (
                <ol
                  className={cn(
                    'mt-2 space-y-1.5 rounded-lg border p-2.5 text-xs leading-5 text-slate-700',
                    guardColorPresentation?.surfaceClassName ??
                      'border-amber-100 bg-amber-50/60',
                  )}
                >
                  {warningSnapshot.actions.map((action, index) => (
                    <li
                      key={`${index}-${action}`}
                      className="flex min-w-0 gap-2"
                    >
                      <span
                        className={cn(
                          'font-semibold',
                          guardColorPresentation?.accentClassName ??
                            'text-amber-800',
                        )}
                      >
                        {index + 1}.
                      </span>
                      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                        {action}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-xs text-slate-500">
                  暂无戒备行动明细。
                </p>
              )}
            </section>
          )}

          {progressNotificationsEnabled &&
            detailScope.showGuardDetails &&
            warningSnapshot?.guardLevel && (
              <section aria-labelledby={weatherGuardCheckId}>
                <h3
                  id={weatherGuardCheckId}
                  className="text-xs font-semibold text-slate-800"
                >
                  重保检查进度
                </h3>
                {checkProgress?.kind === 'unavailable' ? (
                  <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
                    <Clock3
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    {checkProgress.message ??
                      '重保检查进度不可用，戒备登记仍可继续提交。'}
                  </div>
                ) : (
                  <>
                    <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                      {checkProgress?.items.map((item) => (
                        <div
                          key={item.key}
                          className={cn(
                            'min-w-0 rounded-md border px-2 py-1.5 text-xs',
                            item.className,
                          )}
                        >
                          <div className="flex min-w-0 items-center justify-between gap-1.5">
                            <span className="truncate font-medium">
                              {item.label}
                            </span>
                            <span className="shrink-0 text-[10px]">
                              {item.stateLabel}
                            </span>
                          </div>
                          {item.detail && (
                            <div className="mt-0.5 truncate text-[10px] opacity-80">
                              {item.detail}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {checkProgress?.missingRegistrationText && (
                      <div className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] font-medium text-amber-900">
                        {checkProgress.missingRegistrationText}
                      </div>
                    )}
                    {warningSnapshot.checkSummary.abnormalSummaries.length >
                      0 && (
                      <div className="mt-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs leading-5 text-red-800">
                        异常：
                        {warningSnapshot.checkSummary.abnormalSummaries.join(
                          '；',
                        )}
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

          {detailScope.canRegisterGuard && summary.canRegisterGuard && (
            <div
              className={cn(
                'grid grid-cols-1 gap-2 border-t border-slate-100 pt-3',
                registrationEnabled && onRegisterGuard && 'sm:grid-cols-2',
              )}
            >
              <a
                href={WEATHER_WARNING_CHECKLIST_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none"
              >
                <FileCheck2 className="h-3.5 w-3.5" aria-hidden="true" />
                下载重保检查单
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
              {registrationEnabled && onRegisterGuard && (
                <button
                  type="button"
                  disabled={!registrationWarningId || !onRegisterGuard}
                  onClick={() => {
                    if (!registrationWarningId || !onRegisterGuard) return;
                    onRegisterGuard(
                      registrationWarningId,
                      weatherWarningTriggerRef.current,
                    );
                  }}
                  className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 motion-reduce:transition-none"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  提交戒备登记
                </button>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
