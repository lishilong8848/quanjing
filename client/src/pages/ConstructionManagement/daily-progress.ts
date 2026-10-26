export type DailyFollowupStage = 'prepare' | 'process' | 'close';

export interface DailyFollowupStageProgress {
  prepare: boolean;
  process: boolean;
  processEvidence: boolean;
  close: boolean;
}

export interface DailyFollowupDateFields {
  followupDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface DailyPrepareEvidenceSource {
  dailyPersonnelCheck?: string | null;
  hasDailyPersonnelChecklist?: boolean | null;
  isolationFeedback?: string | null;
  hasIsolationAttachment?: boolean | null;
}

export interface DailyPrepareEvidence {
  hasPersonnelCheck: boolean;
  hasIsolationTrace: boolean;
}

export interface InitialApplicationFollowupEvidence {
  hasInitialApplicationFiles?: boolean | null;
  hasDailySignals?: boolean | null;
  workTypes?: readonly unknown[] | null;
}

export type DailyProgressStageGroups<T> = Record<DailyFollowupStage, T[]>;

export function isDailyFollowupOnDate(
  followup: DailyFollowupDateFields,
  referenceDate: Date,
): boolean {
  const submittedAt =
    parseOptionalDate(followup.followupDate) ||
    parseOptionalDate(followup.createdAt) ||
    parseOptionalDate(followup.updatedAt);
  if (!submittedAt) return false;

  return (
    startOfLocalDay(submittedAt).getTime() ===
    startOfLocalDay(referenceDate).getTime()
  );
}

export function getDailyProgressReferenceDate(
  generatedAt?: string | null,
  fallback: Date = new Date(),
): Date {
  return startOfLocalDay(parseOptionalDate(generatedAt) || fallback);
}

export function getDailyProgressStagePrimaryMetric(
  stage: DailyFollowupStage,
  summary: Pick<DailyFollowupStageProgressSummary, 'done' | 'pending'>,
): { value: number; label: string } {
  if (stage === 'close') {
    return { value: summary.done, label: '已完成' };
  }
  return { value: summary.pending, label: '待跟进' };
}

export function getDailyProgressCandidateItems<T>(
  items: readonly T[],
  isActiveItem: (item: T) => boolean,
  hasTodayDailyFollowup: (item: T) => boolean,
): T[] {
  return items.filter(
    (item) => isActiveItem(item) || hasTodayDailyFollowup(item),
  );
}

export function getDailyPrepareEvidence(
  followups: readonly DailyPrepareEvidenceSource[],
  constructionAiAuditEnabled = false,
): DailyPrepareEvidence {
  return {
    hasPersonnelCheck: followups.some(
      (followup) =>
        Boolean(String(followup.dailyPersonnelCheck || '').trim()) ||
        followup.hasDailyPersonnelChecklist === true,
    ),
    hasIsolationTrace: followups.some(
      (followup) =>
        Boolean(followup.hasIsolationAttachment) ||
        (constructionAiAuditEnabled &&
          Boolean(String(followup.isolationFeedback || '').trim())),
    ),
  };
}

export function isInitialApplicationFollowupByEvidence(
  evidence: InitialApplicationFollowupEvidence,
): boolean {
  const hasInitialSignal =
    Boolean(evidence.hasInitialApplicationFiles) ||
    Boolean(evidence.workTypes?.length);

  return hasInitialSignal && !evidence.hasDailySignals;
}

export function getCurrentDailyProgressStage(
  progress: DailyFollowupStageProgress,
): DailyFollowupStage {
  if (!progress.prepare) return 'prepare';
  if (!progress.close) return 'process';
  return 'close';
}

export function groupDailyProgressItems<T>(
  items: readonly T[],
  getProgress: (item: T) => DailyFollowupStageProgress,
  getStartTime: (item: T) => number,
): DailyProgressStageGroups<T> {
  const groups: DailyProgressStageGroups<T> = {
    prepare: [],
    process: [],
    close: [],
  };

  items.forEach((item) => {
    groups[getCurrentDailyProgressStage(getProgress(item))].push(item);
  });

  (Object.keys(groups) as DailyFollowupStage[]).forEach((stage) => {
    groups[stage].sort((left, right) => {
      const leftDone = getProgress(left)[stage];
      const rightDone = getProgress(right)[stage];

      return (
        Number(leftDone) - Number(rightDone) ||
        getStartTime(left) - getStartTime(right)
      );
    });
  });

  return groups;
}

interface DailyFollowupStageProgressSummary {
  done: number;
  pending: number;
}

function parseOptionalDate(value?: string | null): Date | null {
  if (!value) return null;

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}
