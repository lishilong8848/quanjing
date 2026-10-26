import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ActionEditSync, type ActionEditTask } from './action-edit-sync';
import { weeklyMutation, weeklyJob, retryWeeklyJob } from './weekly-api';
import { meetingError } from './api';
const sessions = new Map<string, ActionEditSync>();
export function useActionEditSync(account: string) {
  const sync = useMemo(() => {
    const existing = sessions.get(account);
    if (existing) return existing;
    const key = 'nt-weekly-action-edits:' + account;
    let initial: ActionEditTask[] = [];
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || '[]');
      if (Array.isArray(saved))
        initial = saved
          .filter(
            (task) =>
              task?.item?.id &&
              task.command?.clientMutationId &&
              task.command?.targetRecordId,
          )
          .slice(-100);
    } catch {
      initial = [];
    }
    const next = new ActionEditSync(
      {
        submit: (command) => weeklyMutation('actions', command),
        job: (id) => weeklyJob(id, new AbortController().signal),
        retry: (id) => retryWeeklyJob(id),
        error: meetingError,
        wait: () => new Promise((resolve) => setTimeout(resolve, 1000)),
      },
      initial,
      (tasks) => {
        try {
          sessionStorage.setItem(key, JSON.stringify(tasks.slice(-100)));
        } catch {
          /* 内存草稿仍保留，后台正式任务由服务端持久化。 */
        }
      },
    );
    sessions.set(account, next);
    return next;
  }, [account]);
  const tasks = useSyncExternalStore(
    sync.subscribe,
    sync.snapshot,
    sync.snapshot,
  );
  useEffect(() => {
    for (const task of sync.snapshot())
      if (['submitting', 'syncing'].includes(task.phase)) sync.resume(task);
  }, [sync]);
  return { sync, tasks };
}
