import type { WeeklyJob } from './weekly-workspace.interface';

type WeeklyTarget = Pick<WeeklyJob, 'kind' | 'targetRecordId' | 'endDate'>;

export function weeklyTargetsOverlap(
  a: WeeklyTarget,
  b: WeeklyTarget,
): boolean {
  if (a.kind === 'attachments' || b.kind === 'attachments') return false;
  if (
    a.kind === 'generate' &&
    b.kind === 'generate' &&
    (a.targetRecordId === 'new' || b.targetRecordId === 'new')
  ) {
    // 未保存日期的旧任务仍需核对，不能据此放开重复创建。
    return !a.endDate || !b.endDate || a.endDate === b.endDate;
  }
  return a.targetRecordId === b.targetRecordId;
}

const blocksWrites = (job: WeeklyJob) =>
  job.kind !== 'attachments' &&
  ['accepted', 'running', 'uncertain', 'deleting'].includes(job.status);

export function canDeleteWeeklyTask(job: WeeklyJob): boolean {
  return (
    job.kind === 'generate' &&
    job.targetRecordId === 'new' &&
    ['error', 'uncertain'].includes(job.status) &&
    !job.documentUrl
  );
}

export function weeklyCreationBlockReason(
  endDate: string,
  jobs: WeeklyJob[],
): string {
  const conflicts = jobs.filter(
    (job) =>
      blocksWrites(job) &&
      weeklyTargetsOverlap(job, {
        kind: 'generate',
        targetRecordId: 'new',
        endDate,
      }),
  );
  if (conflicts.some((job) => job.status === 'uncertain'))
    return `${endDate} 的周报创建结果待核对，请先核对已有任务，或选择其他日期`;
  if (conflicts.some((job) => job.status === 'deleting'))
    return `${endDate} 的旧任务正在核对删除，请稍候`;
  return conflicts.length ? `${endDate} 的周报正在处理中，请等待任务完成` : '';
}

export function weeklyRecordBlockReason(
  selected: string,
  jobs: WeeklyJob[],
): string {
  if (!selected || selected === 'new') return '';
  if (selected.startsWith('pending:'))
    return '目标周报正在处理中，请等待任务完成';
  const conflicts = jobs.filter(
    (job) => blocksWrites(job) && job.targetRecordId === selected,
  );
  if (conflicts.some((job) => job.status === 'uncertain'))
    return '目标周报有结果待核对的任务，请先核对';
  return conflicts.length ? '目标周报正在处理中，请等待任务完成' : '';
}
