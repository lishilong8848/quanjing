import { ActionEditSync } from '../../client/src/pages/MeetingManagement/action-edit-sync';
import type { MeetingAction } from '../../shared/meeting-management.interface';
import type { WeeklyJob } from '../../shared/weekly-workspace.interface';
const item = {
  id: 'recExample:current-actions:0',
  sourceRecordId: 'recExample',
  content: '原文',
  responsible: null,
} as MeetingAction;
const command = {
  clientMutationId: 'edit-12345678',
  actionId: item.id,
  targetRecordId: item.sourceRecordId,
  expectedContent: '原文',
  content: '修改',
};
const job = (status: WeeklyJob['status']): WeeklyJob => ({
  id: command.clientMutationId,
  kind: 'action-edit',
  targetRecordId: item.sourceRecordId,
  status,
  stage: 'queued',
  attempts: 0,
  error: null,
  createdAt: '',
  updatedAt: '',
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
describe('待办修改独立后台任务', () => {
  it('慢受理时立即发布同步状态，重复点击只有一条请求', async () => {
    let resolve!: (value: WeeklyJob) => void;
    const submit = jest.fn(
      () =>
        new Promise<WeeklyJob>((done) => {
          resolve = done;
        }),
    );
    const sync = new ActionEditSync({
      submit,
      job: jest.fn(),
      retry: jest.fn(),
      error: String,
      wait: async () => {},
    });
    const listener = jest.fn();
    sync.subscribe(listener);
    expect(sync.submit(item, command)).toBe(true);
    expect(sync.snapshot()[0].phase).toBe('submitting');
    expect(listener).toHaveBeenCalled();
    expect(sync.submit(item, command)).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    resolve(job('success'));
    await settle();
    expect(sync.snapshot()[0].phase).toBe('success');
  });
  it('弹窗/订阅退出后仍跟踪终态，失败保留草稿并使用同一Mutation重试', async () => {
    const submit = jest
      .fn()
      .mockRejectedValueOnce(new Error('断网'))
      .mockResolvedValue(job('success'));
    const sync = new ActionEditSync({
      submit,
      job: jest.fn(),
      retry: jest.fn(),
      error: String,
      wait: async () => {},
    });
    const release = sync.subscribe(() => {});
    sync.submit(item, command);
    release();
    await settle();
    const failed = sync.snapshot()[0];
    expect(failed.phase).toBe('error');
    expect(failed.command.content).toBe('修改');
    sync.resume(failed);
    await settle();
    expect(sync.snapshot()[0].phase).toBe('success');
    expect(submit.mock.calls[1][0].clientMutationId).toBe(
      command.clientMutationId,
    );
  });
  it('同步失败不影响其他事项，旧响应不能覆盖新修改', async () => {
    let oldResolve!: (value: WeeklyJob) => void;
    const submit = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<WeeklyJob>((done) => {
            oldResolve = done;
          }),
      )
      .mockResolvedValue(job('success'));
    const sync = new ActionEditSync({
      submit,
      job: jest.fn(),
      retry: jest.fn(),
      error: String,
      wait: async () => {},
    });
    sync.submit(item, command);
    sync.submit(
      { ...item, id: 'recOther:current-actions:0' },
      {
        ...command,
        clientMutationId: 'edit-other-123',
        actionId: 'recOther:current-actions:0',
      },
    );
    await settle();
    oldResolve({ ...job('error'), error: '冲突' });
    await settle();
    expect(sync.snapshot().map((task) => task.phase)).toEqual([
      'error',
      'success',
    ]);
  });
});
