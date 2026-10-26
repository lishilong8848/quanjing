import type {
  WeatherWarningBuilding,
  WeatherWarningCheckKey,
  WeatherWarningCheckState,
  WeatherWarningDisplayWarning,
  WeatherWarningGuardLevel,
  WeatherWarningSnapshot,
} from '@shared/api.interface';
import type { UseWeatherSnapshotResult } from './use-weather-snapshot';

export type WeatherWarningTriggerTone =
  | 'info'
  | 'success'
  | 'orange'
  | 'warning'
  | 'danger';

export interface WeatherWarningTriggerPresentation {
  label: string;
  ariaLabel: string;
  tone: WeatherWarningTriggerTone;
}

export interface WeatherWarningGuardLevelPresentation {
  tone: WeatherWarningTriggerTone;
  badgeClassName: string;
}

export interface WeatherWarningColorPresentation {
  label: string;
  tone: WeatherWarningTriggerTone;
  badgeClassName: string;
  surfaceClassName: string;
  accentClassName: string;
}

export function getWeatherWarningColorPresentation(
  color: WeatherWarningDisplayWarning['color'] | undefined,
): WeatherWarningColorPresentation {
  switch (color) {
    case 'red':
      return {
        label: '红色',
        tone: 'danger',
        badgeClassName: 'border-red-200 bg-red-50 text-red-800',
        surfaceClassName: 'border-red-100 bg-red-50/60',
        accentClassName: 'text-red-800',
      };
    case 'orange':
      return {
        label: '橙色',
        tone: 'orange',
        badgeClassName: 'border-orange-200 bg-orange-50 text-orange-800',
        surfaceClassName: 'border-orange-100 bg-orange-50/60',
        accentClassName: 'text-orange-800',
      };
    case 'yellow':
      return {
        label: '黄色',
        tone: 'warning',
        badgeClassName: 'border-amber-200 bg-amber-50 text-amber-900',
        surfaceClassName: 'border-amber-100 bg-amber-50/60',
        accentClassName: 'text-amber-800',
      };
    case 'blue':
      return {
        label: '蓝色',
        tone: 'info',
        badgeClassName: 'border-blue-200 bg-blue-50 text-blue-800',
        surfaceClassName: 'border-blue-100 bg-blue-50/60',
        accentClassName: 'text-blue-800',
      };
    default:
      return {
        label: '未分级',
        tone: 'info',
        badgeClassName: 'border-slate-200 bg-slate-50 text-slate-700',
        surfaceClassName: 'border-slate-100 bg-slate-50/60',
        accentClassName: 'text-slate-700',
      };
  }
}

const WEATHER_WARNING_GUARD_LEVEL_PRESENTATION = {
  一级戒备: {
    tone: 'danger',
    badgeClassName: 'border-red-200 bg-red-50 text-red-800',
  },
  二级戒备: {
    tone: 'orange',
    badgeClassName: 'border-orange-200 bg-orange-50 text-orange-800',
  },
  三级戒备: {
    tone: 'warning',
    badgeClassName: 'border-amber-200 bg-amber-50 text-amber-900',
  },
} satisfies Record<
  WeatherWarningGuardLevel,
  WeatherWarningGuardLevelPresentation
>;

export function getWeatherWarningGuardLevelPresentation(
  guardLevel: WeatherWarningGuardLevel,
): WeatherWarningGuardLevelPresentation {
  return WEATHER_WARNING_GUARD_LEVEL_PRESENTATION[guardLevel];
}

export type WeatherWarningCheckProgressTone =
  | 'success'
  | 'warning'
  | 'danger'
  | 'neutral';

export interface WeatherWarningCheckProgressItemPresentation {
  key: WeatherWarningCheckKey;
  label: string;
  stateLabel: string;
  tone: WeatherWarningCheckProgressTone;
  className: string;
  incompleteBuildings: WeatherWarningBuilding[];
  detail: string | null;
}

export interface WeatherWarningCheckProgressPresentation {
  kind: 'available' | 'unavailable';
  message?: string;
  items: WeatherWarningCheckProgressItemPresentation[];
  missingRegistrationText: string | null;
}

const WEATHER_WARNING_CHECK_ITEMS = [
  ['device', '设备安全'],
  ['environment', '环境安全'],
  ['disaster', '灾害专项'],
  ['materials', '物资清单'],
  ['contacts', '联络清单'],
  ['managerConfirmation', '机房经理确认'],
] as const satisfies ReadonlyArray<readonly [WeatherWarningCheckKey, string]>;

const WEATHER_WARNING_BUILDING_ORDER: WeatherWarningBuilding[] = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
];

function sortWeatherWarningBuildings(
  buildings: Iterable<WeatherWarningBuilding>,
): WeatherWarningBuilding[] {
  const uniqueBuildings = new Set(buildings);
  return WEATHER_WARNING_BUILDING_ORDER.filter((building) =>
    uniqueBuildings.has(building),
  );
}

function getWeatherWarningCheckStatePresentation(
  state: WeatherWarningCheckState,
): Pick<
  WeatherWarningCheckProgressItemPresentation,
  'stateLabel' | 'tone' | 'className'
> {
  switch (state) {
    case 'completed':
      return {
        stateLabel: '已完成',
        tone: 'success',
        className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
      };
    case 'not_required':
      return {
        stateLabel: '无需检查',
        tone: 'success',
        className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
      };
    case 'abnormal':
      return {
        stateLabel: '存在异常',
        tone: 'danger',
        className: 'border-red-200 bg-red-50 text-red-800',
      };
    case 'pending':
      return {
        stateLabel: '待检查',
        tone: 'warning',
        className: 'border-amber-200 bg-amber-50 text-amber-900',
      };
    case 'not_started':
    default:
      return {
        stateLabel: '未开始',
        tone: 'neutral',
        className: 'border-slate-200 bg-slate-50 text-slate-700',
      };
  }
}

export function getWeatherWarningCheckProgressPresentation(
  snapshot: WeatherWarningSnapshot,
): WeatherWarningCheckProgressPresentation {
  const buildingProgress = snapshot.buildingProgress;
  if (
    snapshot.checkSyncState === 'unavailable' ||
    !buildingProgress?.available
  ) {
    return {
      kind: 'unavailable',
      message: '重保检查进度不可用，戒备登记仍可继续提交。',
      items: [],
      missingRegistrationText: null,
    };
  }

  const items = WEATHER_WARNING_CHECK_ITEMS.map(([key, label]) => {
    const state = snapshot.checkSummary[key];
    const incompleteBuildings =
      state === 'not_required'
        ? []
        : sortWeatherWarningBuildings(
            buildingProgress.incompleteItems
              .filter((item) => item.key === key)
              .map((item) => item.building),
          );

    return {
      key,
      label,
      ...getWeatherWarningCheckStatePresentation(state),
      incompleteBuildings,
      detail:
        incompleteBuildings.length > 0
          ? `未完成：${incompleteBuildings.join('、')}`
          : null,
    };
  });
  const missingRegistrationBuildings = sortWeatherWarningBuildings([
    ...buildingProgress.missingRegistrationBuildings,
    ...buildingProgress.incompleteItems
      .filter((item) => item.key === 'registration')
      .map((item) => item.building),
  ]);

  return {
    kind: 'available',
    items,
    missingRegistrationText:
      missingRegistrationBuildings.length > 0
        ? `未登记：${missingRegistrationBuildings.join('、')}`
        : null,
  };
}

export interface WeatherWarningPresentationInput {
  warningSnapshot: UseWeatherSnapshotResult['warningSnapshot'];
  warningStatus: UseWeatherSnapshotResult['warningStatus'];
  warningError: string | null;
  warningFailureKind: UseWeatherSnapshotResult['warningFailureKind'];
}

export interface WeatherWarningDetailScope {
  warnings: Array<{
    warning: WeatherWarningDisplayWarning;
    matched: boolean;
  }>;
  description: string;
  showGuardDetails: boolean;
  canRegisterGuard: boolean;
  isSecondaryGuardWarning: boolean;
}

export function getWeatherWarningDetailScope(
  input: WeatherWarningPresentationInput,
  selectedWarningId?: string,
  selectedWarningMatched?: boolean,
): WeatherWarningDetailScope {
  const { warningSnapshot } = input;
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
  const summary = getWeatherWarningSummaryPresentation(input);
  const showGuardDetails =
    summary.kind === 'guard_required' && Boolean(warningSnapshot?.guardLevel);

  if (!selectedWarningId) {
    return {
      warnings,
      description: summary.description,
      showGuardDetails,
      canRegisterGuard: summary.canRegisterGuard,
      isSecondaryGuardWarning: false,
    };
  }

  const selectedWarning = warnings.find(
    ({ warning, matched }) =>
      warning.id === selectedWarningId &&
      (selectedWarningMatched === undefined ||
        matched === selectedWarningMatched),
  );
  if (!selectedWarning) {
    return {
      warnings: [],
      description: '未找到所选预警',
      showGuardDetails: false,
      canRegisterGuard: false,
      isSecondaryGuardWarning: false,
    };
  }

  const isPrimaryGuardWarning =
    selectedWarning.matched &&
    warningSnapshot?.matchedWarnings[0]?.id === selectedWarningId;
  const decision = getWeatherWarningDecisionPresentation({
    warningSnapshot: warningSnapshot!,
    warning: selectedWarning.warning,
    matched: selectedWarning.matched,
  });
  return {
    warnings: [selectedWarning],
    description: `${selectedWarning.warning.title}：${decision.label}`,
    showGuardDetails: isPrimaryGuardWarning && showGuardDetails,
    canRegisterGuard: isPrimaryGuardWarning && summary.canRegisterGuard,
    isSecondaryGuardWarning: selectedWarning.matched && !isPrimaryGuardWarning,
  };
}

export type WeatherWarningDecisionKind =
  | 'guard_required'
  | 'no_guard_required'
  | 'decision_pending'
  | 'manual_review'
  | 'stale';

export interface WeatherWarningDecisionPresentation {
  kind: WeatherWarningDecisionKind;
  label: string;
  tone: WeatherWarningTriggerTone;
  badgeClassName: string;
  guardCompleted: boolean;
}

export type WeatherWarningSummaryKind =
  | WeatherWarningDecisionKind
  | 'no_warning'
  | 'loading'
  | 'error';

export interface WeatherWarningSummaryPresentation {
  kind: WeatherWarningSummaryKind;
  title: string;
  description: string;
  tone: WeatherWarningTriggerTone;
  warningCount: number;
  canRegisterGuard: boolean;
}

function getWeatherWarningGuardDecisionState(
  warningSnapshot: WeatherWarningSnapshot,
): NonNullable<WeatherWarningSnapshot['guardDecisionState']> {
  if (warningSnapshot.guardDecisionState) {
    return warningSnapshot.guardDecisionState;
  }
  const warningCount =
    warningSnapshot.matchedWarnings.length +
    warningSnapshot.unmatchedWarnings.length;
  if (
    warningCount > 0 &&
    !warningSnapshot.guardLevel &&
    warningSnapshot.sourceError?.includes('重保规则')
  ) {
    return 'pending';
  }
  if (
    warningSnapshot.status === 'stale' ||
    warningSnapshot.status === 'degraded' ||
    warningSnapshot.sourceState !== 'fresh'
  ) {
    return 'stale';
  }
  return 'fresh';
}

export function isWeatherWarningGuardDecisionPending(
  warningSnapshot: WeatherWarningSnapshot | null,
): boolean {
  if (!warningSnapshot) return false;
  const warningCount =
    warningSnapshot.matchedWarnings.length +
    warningSnapshot.unmatchedWarnings.length;
  return (
    warningCount > 0 &&
    getWeatherWarningGuardDecisionState(warningSnapshot) === 'pending'
  );
}

export function getWeatherWarningDecisionPresentation({
  warningSnapshot,
  warning,
  matched,
}: {
  warningSnapshot: WeatherWarningSnapshot;
  warning: WeatherWarningDisplayWarning;
  matched: boolean;
}): WeatherWarningDecisionPresentation {
  const guardDecisionState =
    getWeatherWarningGuardDecisionState(warningSnapshot);
  if (guardDecisionState === 'pending') {
    return {
      kind: 'decision_pending',
      label: '戒备判定待同步',
      tone: 'warning',
      badgeClassName: 'border-amber-200 bg-amber-50 text-amber-900',
      guardCompleted: false,
    };
  }

  if (guardDecisionState === 'stale') {
    return {
      kind: 'stale',
      label: '判定待更新',
      tone: 'warning',
      badgeClassName: 'border-amber-200 bg-amber-50 text-amber-900',
      guardCompleted: false,
    };
  }

  const guardLevel =
    warning.guardLevel ?? (matched ? warningSnapshot.guardLevel : null);
  if (guardLevel) {
    const primaryWarning = warningSnapshot.matchedWarnings[0];
    const warningIdMatchCount = warningSnapshot.matchedWarnings.filter(
      (candidate) => candidate.id === warning.id,
    ).length;
    const isPrimaryMatchedWarning =
      matched &&
      (primaryWarning === warning ||
        (warningIdMatchCount === 1 && primaryWarning?.id === warning.id));
    const guardCompleted =
      isPrimaryMatchedWarning &&
      warningSnapshot.guardCompletion?.state === 'completed';
    const warningColorPresentation = warning.color
      ? getWeatherWarningColorPresentation(warning.color)
      : getWeatherWarningGuardLevelPresentation(guardLevel);
    return {
      kind: 'guard_required',
      label: guardCompleted ? guardLevel : `${guardLevel} · 需戒备`,
      tone: warningColorPresentation.tone,
      badgeClassName: warningColorPresentation.badgeClassName,
      guardCompleted,
    };
  }

  if (!warning.type || !warning.color) {
    return {
      kind: 'manual_review',
      label: '需人工复核',
      tone: 'warning',
      badgeClassName: 'border-amber-200 bg-amber-50 text-amber-900',
      guardCompleted: false,
    };
  }

  if (guardDecisionState === 'fresh') {
    return {
      kind: 'no_guard_required',
      label: '无需戒备',
      tone: 'success',
      badgeClassName: 'border-emerald-200 bg-emerald-50 text-emerald-800',
      guardCompleted: false,
    };
  }

  return {
    kind: 'manual_review',
    label: '需人工复核',
    tone: 'warning',
    badgeClassName: 'border-amber-200 bg-amber-50 text-amber-900',
    guardCompleted: false,
  };
}

export function getWeatherWarningRelationLabel({
  decision,
  guardLevel,
}: {
  decision: WeatherWarningDecisionPresentation;
  guardLevel: WeatherWarningGuardLevel | null;
}): string {
  if (decision.kind === 'guard_required') {
    return guardLevel ? `重保类型：${guardLevel}` : '戒备等级待确认';
  }
  if (decision.kind === 'no_guard_required') {
    return '不触发重保';
  }
  return decision.label;
}

export function getWeatherWarningSummaryPresentation({
  warningSnapshot,
  warningStatus,
  warningError,
  warningFailureKind,
}: WeatherWarningPresentationInput): WeatherWarningSummaryPresentation {
  if (!warningSnapshot) {
    if (warningStatus === 'loading' || warningStatus === 'refreshing') {
      return {
        kind: 'loading',
        title: warningError ? '预警重试中' : '预警同步中',
        description: warningError || '正在同步天气预警快照',
        tone: warningError ? 'warning' : 'info',
        warningCount: 0,
        canRegisterGuard: false,
      };
    }
    const title = getFailureLabel(warningFailureKind);
    return {
      kind: 'error',
      title,
      description: warningError || '暂时无法判断是否需要启动戒备',
      tone: 'warning',
      warningCount: 0,
      canRegisterGuard: false,
    };
  }

  const warningCount =
    warningSnapshot.matchedWarnings.length +
    warningSnapshot.unmatchedWarnings.length;
  const guardDecisionState =
    getWeatherWarningGuardDecisionState(warningSnapshot);
  if (guardDecisionState === 'pending' && warningCount > 0) {
    return {
      kind: 'decision_pending',
      title: '戒备判定待同步',
      description: '具体预警已获取，正在等待重保规则同步',
      tone: 'warning',
      warningCount,
      canRegisterGuard: false,
    };
  }

  if (warningStatus === 'error' || guardDecisionState === 'stale') {
    return {
      kind: 'stale',
      title: warningSnapshot.guardLevel
        ? `${warningSnapshot.guardLevel} · 判定待更新`
        : '预警判定待更新',
      description:
        warningError ||
        warningSnapshot.sourceError ||
        '当前展示最近有效快照，请先复核最新预警',
      tone: 'warning',
      warningCount,
      canRegisterGuard: false,
    };
  }

  if (
    warningSnapshot.guardLevel &&
    warningSnapshot.matchedWarnings.length > 0
  ) {
    const guardCompleted =
      warningSnapshot.guardCompletion?.state === 'completed';
    const registrationEnabled = warningSnapshot.features?.registrationEnabled;
    const progressNotificationsEnabled =
      warningSnapshot.features?.progressNotificationsEnabled;
    const actionPrompt = guardCompleted
      ? '戒备已完成'
      : registrationEnabled === false && progressNotificationsEnabled === false
        ? '请按戒备要求执行'
        : registrationEnabled === false
          ? '请完成重保检查'
          : progressNotificationsEnabled === false
            ? '请完成戒备登记'
            : '请完成重保检查和登记';

    return {
      kind: 'guard_required',
      title: warningSnapshot.guardLevel,
      description: `已匹配 ${warningSnapshot.matchedWarnings.length} 条戒备规则，${actionPrompt}`,
      tone: warningSnapshot.matchedWarnings[0]?.color
        ? getWeatherWarningColorPresentation(
            warningSnapshot.matchedWarnings[0].color,
          ).tone
        : getWeatherWarningGuardLevelPresentation(warningSnapshot.guardLevel)
            .tone,
      warningCount,
      canRegisterGuard: true,
    };
  }

  if (warningCount === 0) {
    if (guardDecisionState !== 'fresh') {
      return {
        kind: 'error',
        title: '预警数据待同步',
        description:
          warningSnapshot.sourceError || '暂时无法判断是否需要启动戒备',
        tone: 'warning',
        warningCount: 0,
        canRegisterGuard: false,
      };
    }
    return {
      kind: 'no_warning',
      title: '当前无有效天气预警',
      description: '当前无需启动天气重保戒备',
      tone: 'success',
      warningCount: 0,
      canRegisterGuard: false,
    };
  }

  const unmatchedWarnings = warningSnapshot.unmatchedWarnings;
  const canConfirmNoGuard =
    guardDecisionState === 'fresh' &&
    unmatchedWarnings.length === warningCount &&
    unmatchedWarnings.every((warning) => warning.type && warning.color);
  if (canConfirmNoGuard) {
    return {
      kind: 'no_guard_required',
      title: '无需启动重保戒备',
      description: `当前 ${warningCount} 条天气预警未命中重保戒备规则`,
      tone: 'success',
      warningCount,
      canRegisterGuard: false,
    };
  }

  return {
    kind: 'manual_review',
    title: '预警需人工复核',
    description: '预警信息不完整或同步状态异常，暂不能确认戒备结论',
    tone: 'warning',
    warningCount,
    canRegisterGuard: false,
  };
}

export function getWeatherWarningTriggerPresentation({
  warningSnapshot,
  warningStatus,
  warningError,
  warningFailureKind,
}: WeatherWarningPresentationInput): WeatherWarningTriggerPresentation {
  if (!warningSnapshot) {
    if (warningStatus === 'loading' || warningStatus === 'refreshing') {
      if (warningError) {
        return {
          label: '预警重试中',
          ariaLabel: `打开预警与戒备信息，正在重试：${warningError}`,
          tone: 'warning',
        };
      }
      return {
        label: '预警同步中',
        ariaLabel: '打开预警与戒备信息，预警快照正在同步',
        tone: 'info',
      };
    }

    const label = getFailureLabel(warningFailureKind);
    return {
      label,
      ariaLabel: `打开预警与戒备信息，${warningError || label}`,
      tone: 'warning',
    };
  }

  const warningCount =
    warningSnapshot.matchedWarnings.length +
    warningSnapshot.unmatchedWarnings.length;
  const summary = getWeatherWarningSummaryPresentation({
    warningSnapshot,
    warningStatus,
    warningError,
    warningFailureKind,
  });

  if (summary.kind === 'decision_pending') {
    return {
      label: `天气预警 · ${warningCount} · 戒备判定待同步`,
      ariaLabel: `打开预警与戒备信息，天气预警 ${warningCount} 条，戒备判定待同步`,
      tone: 'warning',
    };
  }

  if (summary.kind === 'stale') {
    const subject = warningSnapshot.guardLevel
      ? warningSnapshot.guardLevel
      : warningCount > 0
        ? `天气预警 · ${warningCount}`
        : '预警数据';
    return {
      label:
        warningSnapshot.guardLevel || warningCount > 0
          ? `${subject} · 数据待更新`
          : '预警数据待更新',
      ariaLabel: `打开预警与戒备信息，${subject}，数据待更新`,
      tone: 'warning',
    };
  }

  if (summary.kind === 'guard_required' && warningSnapshot.guardLevel) {
    const completionSuffix =
      warningSnapshot.guardCompletion?.state === 'completed'
        ? ' · 戒备完成'
        : warningSnapshot.checkSyncState === 'unavailable'
          ? ' · 检查待同步'
          : '';
    const label = `${warningSnapshot.guardLevel} · ${warningCount}${completionSuffix}`;
    return {
      label,
      ariaLabel: `打开预警与戒备信息，${label}`,
      tone: summary.tone,
    };
  }

  if (summary.kind === 'no_guard_required') {
    return {
      label: `天气预警 · ${warningCount} · 无需戒备`,
      ariaLabel: `打开预警与戒备信息，天气预警 ${warningCount} 条，无需戒备，无需启动重保戒备`,
      tone: 'success',
    };
  }

  if (summary.kind === 'no_warning') {
    return {
      label: '当前无重保预警',
      ariaLabel: '打开预警与戒备信息，当前无重保预警',
      tone: 'success',
    };
  }

  if (warningCount > 0) {
    return {
      label: `天气预警 · ${warningCount} · 需复核`,
      ariaLabel: `打开预警与戒备信息，有 ${warningCount} 条天气预警需要人工复核`,
      tone: 'warning',
    };
  }

  return {
    label: summary.title,
    ariaLabel: `打开预警与戒备信息，${summary.description}`,
    tone: summary.tone,
  };
}

function getFailureLabel(
  kind: UseWeatherSnapshotResult['warningFailureKind'] | undefined,
): string {
  switch (kind) {
    case 'configuration':
      return '预警待配置';
    case 'permission':
      return '预警信息受限';
    case 'timeout':
    case 'unavailable':
    default:
      return '预警待同步';
  }
}

export function formatWeatherWarningTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getWeatherWarningTimePresentation(
  warning: NonNullable<
    UseWeatherSnapshotResult['warningSnapshot']
  >['matchedWarnings'][number],
) {
  const startTime = formatWeatherWarningTime(warning.startTime);
  const endTime = formatWeatherWarningTime(warning.endTime);
  const pubTime = formatWeatherWarningTime(warning.pubTime);

  if (startTime && endTime) {
    return { label: `有效期 ${startTime} 至 ${endTime}` };
  }
  if (pubTime) return { label: `发布于 ${pubTime}` };
  if (startTime) return { label: `生效于 ${startTime}` };
  if (endTime) return { label: `截至 ${endTime}` };
  return { label: '' };
}
