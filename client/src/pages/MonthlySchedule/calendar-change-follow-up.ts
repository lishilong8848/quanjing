import type { ChangeInfo } from '@shared/api.interface';
import {
  buildExceptionFollowUpTargetKeys,
  selectExceptionFollowUpsByTarget,
  type ExceptionFollowUpIndex,
} from '@shared/exception-follow-up-match';

type ChangeDetail = {
  change: Pick<
    ChangeInfo,
    | 'id'
    | 'title'
    | 'startDate'
    | 'endDate'
    | 'level'
    | 'executor'
    | 'buildings'
  >;
  windows: Array<{ start: Date; end: Date; source: string }>;
  conflictSealings: Array<{ sealingName?: string }>;
  reminderSealings: Array<{ sealingName?: string }>;
  overlapChanges: Array<{ title?: string }>;
};
const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const formatTime = (value: string) => timeFormatter.format(new Date(value));
const levelName = (level: string | null) => {
  const raw = level?.trim();
  if (!raw) return null;
  const found = raw
    .toUpperCase()
    .replace(/\s+/g, '')
    .match(/[IP][1-4]/)?.[0];
  return found && ['I1', 'I2', 'I3', 'I4', 'P1', 'P2', 'P3'].includes(found)
    ? found
    : raw;
};
const names = (items: Array<{ title?: string; sealingName?: string }>) =>
  items
    .map((i) => i.title || i.sealingName)
    .filter(Boolean)
    .join('、');

export function buildCalendarChangeFollowUpTarget(
  date: string,
  item: ChangeDetail,
) {
  const {
    change,
    windows,
    conflictSealings,
    reminderSealings,
    overlapChanges,
  } = item;
  const first = windows[0],
    last = windows[windows.length - 1];
  const timeLabel =
    first && last
      ? `${formatTime(first.start.toISOString())} - ${formatTime(last.end.toISOString())}`
      : `${formatTime(change.startDate)} - ${formatTime(change.endDate)}`;
  const sourceLabel = windows.some((w) => w.source === 'actual')
    ? '实际'
    : '计划';
  const levelLabel = levelName(change.level);
  const executorLabel = change.executor?.trim() || '未维护';
  const buildingLabel = change.buildings.length
    ? change.buildings.join('、')
    : '未维护';
  const displayLevelLabel = levelLabel || change.level || '未维护';
  const abnormalLabel = conflictSealings.length
    ? '冲突'
    : reminderSealings.length || overlapChanges.length
      ? '提醒'
      : '';
  const detail = [
    `${change.title}：${sourceLabel} ${timeLabel}`,
    `执行人 ${executorLabel}`,
    `楼栋 ${buildingLabel}`,
    `等级 ${displayLevelLabel}`,
    conflictSealings.length
      ? `与封网「${names(conflictSealings)}」时间冲突，请确认是否允许执行`
      : '',
    reminderSealings.length
      ? `当日存在封网「${names(reminderSealings)}」，当前变更未精确冲突，仍需关注执行窗口`
      : '',
    overlapChanges.length
      ? `与中风险及以上变更「${names(overlapChanges)}」时间重叠，需关注人员和资源安排`
      : '',
  ]
    .filter(Boolean)
    .join('；');
  return {
    type: 'sealing_change' as const,
    abnormalLabel,
    date,
    title: change.title,
    detail,
    matchKey:
      buildExceptionFollowUpTargetKeys(date, abnormalLabel, detail)[0] || '',
    existingFollowUp: null,
    timeLabel,
    sourceLabel,
    levelLabel,
    executorLabel,
    buildingLabel,
    displayLevelLabel,
  };
}

export function projectCalendarChangeFollowUp(
  date: string,
  item: ChangeDetail,
  index: ExceptionFollowUpIndex,
) {
  const target = buildCalendarChangeFollowUpTarget(date, item);
  const rawConflict = item.conflictSealings.length > 0;
  const rawReminder =
    !rawConflict &&
    (item.reminderSealings.length > 0 || item.overlapChanges.length > 0);
  const followUps = selectExceptionFollowUpsByTarget(
    index,
    date,
    target.abnormalLabel,
    target.detail,
  ).filter((i) => i.type === 'sealing_change' && i.handling.trim());
  const syncing = followUps.some((i) =>
    i.recordId.startsWith('optimistic-follow-up-'),
  );
  const followedUp =
    (rawConflict || rawReminder) &&
    followUps.some((i) => !i.recordId.startsWith('optimistic-follow-up-'));
  return {
    target,
    followUps,
    rawConflict,
    rawReminder,
    syncing,
    hasConflict: rawConflict && !followedUp,
    hasReminder: rawReminder && !followedUp,
    status: followedUp
      ? ('followed-up' as const)
      : rawConflict
        ? ('conflict' as const)
        : rawReminder
          ? ('reminder' as const)
          : ('change' as const),
  };
}
