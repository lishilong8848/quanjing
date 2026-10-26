import type { MeetingAction } from '../../../../shared/meeting-management.interface';
import type {
  EditMeetingAction,
  WeeklyJob,
} from '../../../../shared/weekly-workspace.interface';

export interface ActionEditTask {
  item: MeetingAction;
  command: EditMeetingAction;
  phase: 'submitting' | 'syncing' | 'waiting' | 'success' | 'error';
  job?: WeeklyJob;
  error?: string;
}
export interface ActionSyncApi {
  submit: (command: EditMeetingAction) => Promise<WeeklyJob>;
  job: (id: string) => Promise<WeeklyJob>;
  retry: (id: string) => Promise<WeeklyJob>;
  error: (reason: unknown) => string;
  wait: () => Promise<void>;
}
export class ActionEditSync {
  private tasks: ActionEditTask[];
  private listeners = new Set<() => void>();
  private flights = new Set<string>();
  constructor(
    private api: ActionSyncApi,
    initial: ActionEditTask[] = [],
    private persist?: (tasks: ActionEditTask[]) => void,
  ) {
    this.tasks = initial;
  }
  snapshot = () => this.tasks;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private change(task: ActionEditTask) {
    const current = this.tasks.find((item) => item.item.id === task.item.id);
    if (
      current &&
      current.command.clientMutationId !== task.command.clientMutationId
    )
      return;
    this.tasks = this.tasks.map((item) =>
      item.item.id === task.item.id ? task : item,
    );
    this.persist?.(this.tasks);
    for (const listener of this.listeners) listener();
  }
  submit(item: MeetingAction, command: EditMeetingAction) {
    const current = this.tasks.find((task) => task.item.id === item.id);
    if (current && ['submitting', 'syncing', 'waiting'].includes(current.phase))
      return false;
    const task: ActionEditTask = { item, command, phase: 'submitting' };
    this.tasks = [...this.tasks.filter((old) => old.item.id !== item.id), task];
    this.persist?.(this.tasks);
    for (const listener of this.listeners) listener();
    void this.run(task);
    return true;
  }
  resume(task: ActionEditTask) {
    void this.run(task);
  }
  acknowledge(id: string) {
    this.tasks = this.tasks.filter(
      (task) =>
        task.command.clientMutationId !== id || task.phase !== 'success',
    );
    this.persist?.(this.tasks);
    for (const listener of this.listeners) listener();
  }
  private async run(task: ActionEditTask) {
    const id = task.command.clientMutationId;
    if (this.flights.has(id)) return;
    this.flights.add(id);
    this.change({
      ...task,
      phase: task.job ? 'syncing' : 'submitting',
      error: undefined,
    });
    try {
      let job = task.job;
      if (job?.status === 'error') job = await this.api.retry(job.id);
      else if (!job) job = await this.api.submit(task.command);
      const deadline = Date.now() + 120000;
      while (true) {
        if (job.status === 'success') {
          this.change({ ...task, job, phase: 'success', error: undefined });
          return;
        }
        if (['error', 'uncertain'].includes(job.status)) {
          this.change({
            ...task,
            job,
            phase: 'error',
            error: job.error || '同步失败，草稿已保留',
          });
          return;
        }
        if (Date.now() >= deadline) {
          this.change({
            ...task,
            job,
            phase: 'waiting',
            error: '后台仍在处理，可稍后查看结果',
          });
          return;
        }
        task = { ...task, job, phase: 'syncing', error: undefined };
        this.change(task);
        await this.api.wait();
        job = await this.api.job(job.id);
      }
    } catch (reason) {
      this.change({ ...task, phase: 'error', error: this.api.error(reason) });
    } finally {
      this.flights.delete(id);
    }
  }
}
