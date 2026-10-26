import type {
  TodayOperationsOverviewResponse,
  TodayOperationsWorkKind,
} from '@shared/today-operations-overview.interface';

export type OverviewSourceNotice = {
  tone: 'stale' | 'error';
  message: string;
};

type OverviewSourceNoticeInput =
  | Pick<
      TodayOperationsOverviewResponse,
      'sourceStatus' | 'sourceStates' | 'rackSourceState'
    >
  | null
  | undefined;

const WORK_SOURCES: readonly {
  kind: TodayOperationsWorkKind;
  label: string;
}[] = [
  { kind: 'events', label: '今日事件' },
  { kind: 'changes', label: '今日变更' },
  { kind: 'inspections', label: '今日检修' },
  { kind: 'maintenance', label: '今日维保' },
];

export function buildOverviewSourceNotice(
  overview: OverviewSourceNoticeInput,
): OverviewSourceNotice | null {
  if (!overview || overview.sourceStatus === 'fresh') {
    return null;
  }

  if (overview.sourceStatus === 'partial') {
    const failedLabels = WORK_SOURCES.filter(
      ({ kind }) => overview.sourceStates[kind].status === 'failed',
    ).map(({ label }) => label);

    if (overview.rackSourceState?.status === 'failed') {
      return {
        tone: 'error',
        message: `${['机柜使用概览', ...failedLabels].join('、')}暂时无法读取，其他可用数据正常展示`,
      };
    }

    return {
      tone: 'error',
      message: `${failedLabels.join('、')}数据源暂时不可用，对应卡片已标记为“—”`,
    };
  }

  const staleSources = WORK_SOURCES.filter(
    ({ kind }) => overview.sourceStates[kind].status === 'stale',
  );
  if (staleSources.length === 0) {
    return {
      tone: 'stale',
      message:
        overview.rackSourceState?.errorMessage ||
        '运行概览刷新失败，当前显示最近一次成功数据',
    };
  }

  const staleEntries = staleSources.map(({ kind, label }) => {
    const sourceState = overview.sourceStates[kind];
    return {
      label,
      isRefreshFailure:
        sourceState.errorCode !== null ||
        sourceState.errorMessage?.includes('刷新失败') === true,
    };
  });
  const failedRefreshLabels = staleEntries
    .filter(({ isRefreshFailure }) => isRefreshFailure)
    .map(({ label }) => label);

  if (failedRefreshLabels.length === staleEntries.length) {
    return {
      tone: 'stale',
      message: `${failedRefreshLabels.join('、')}数据刷新失败，当前显示本日缓存`,
    };
  }

  if (failedRefreshLabels.length === 0) {
    return {
      tone: 'stale',
      message: `${staleEntries.map(({ label }) => label).join('、')}数据正在刷新，当前显示本日缓存`,
    };
  }

  const mixedSourceMessage = staleEntries
    .map(
      ({ label, isRefreshFailure }) =>
        `${label}数据${isRefreshFailure ? '刷新失败' : '正在刷新'}`,
    )
    .join('；');
  return {
    tone: 'stale',
    message: `${mixedSourceMessage}，当前均显示本日缓存`,
  };
}
