import type { CampusTrainingDashboardResponse } from './model';

export const TRAINING_REFRESH_POLL_DELAY_MS = 3_000;
export const TRAINING_REFRESH_WAIT_LIMIT_MS = 5 * 60 * 1_000;

type PollResult =
  | CampusTrainingDashboardResponse['sourceStatus']
  | 'error'
  | undefined;

export function startTrainingRefreshPolling(
  read: () => Promise<PollResult>,
  onStop: (reason: 'timeout' | 'error') => void,
): () => void {
  let stopped = false;
  let next: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(next);
    clearTimeout(deadline);
  };
  const finish = (reason: 'timeout' | 'error') => {
    if (stopped) return;
    stop();
    onStop(reason);
  };
  const poll = async () => {
    if (stopped) return;
    let result: PollResult;
    try {
      result = await read();
    } catch {
      finish('error');
      return;
    }
    if (stopped) return;
    if (result === 'refreshing') {
      next = setTimeout(poll, TRAINING_REFRESH_POLL_DELAY_MS);
    } else if (result === 'error') {
      finish('error');
    } else {
      stop();
    }
  };
  deadline = setTimeout(
    () => finish('timeout'),
    TRAINING_REFRESH_WAIT_LIMIT_MS,
  );
  next = setTimeout(poll, TRAINING_REFRESH_POLL_DELAY_MS);
  return stop;
}
