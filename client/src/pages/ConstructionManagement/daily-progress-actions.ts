import type { DailyFollowupStage } from './daily-progress';

export type DailyChecklistActionKind =
  | 'workType'
  | 'personnel'
  | 'permit'
  | 'isolation'
  | 'processPhoto'
  | 'closeChecklist'
  | 'closePhoto';

export interface DailyChecklistActionItem {
  label: string;
  value: string;
  done: boolean;
  issue?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  actionKind: DailyChecklistActionKind;
  stage: DailyFollowupStage;
}

export function getDailyChecklistTargetStage(
  item: Pick<DailyChecklistActionItem, 'label' | 'stage'> | string,
): DailyFollowupStage {
  if (typeof item !== 'string') {
    return item.stage;
  }
  const label = item;
  if (label.includes('过程')) {
    return 'process';
  }
  if (label.includes('收尾')) {
    return 'close';
  }
  return 'prepare';
}

export function isDailyChecklistActionable(
  item: DailyChecklistActionItem,
): boolean {
  return item.disabled !== true;
}
