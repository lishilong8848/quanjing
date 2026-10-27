import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WeeklyStore } from './weekly.store';
import {
  validateWeeklyMeeting,
  weeklyPeriod,
} from '../../../shared/weekly-workspace.rules';
import type { SaveWeeklyMeeting } from '../../../shared/weekly-workspace.interface';

describe('weekly durable workflow', () => {
  let root: string;
  let store: WeeklyStore;
  const command = (): SaveWeeklyMeeting => ({
    clientMutationId: 'mutation-12345678',
    expectedVersion: 0,
    expectedText: '原文',
    meeting: {
      targetRecordId: 'recExample',
      kind: 'local',
      plannedDate: '2026-10-08',
      actualDate: '2026-10-08',
      status: 'held',
      note: '',
      todos: [
        {
          id: 'todo-1',
          content: '检查漏水',
          ownerOpenId: 'ou_12345678901',
          ownerName: '测试人员',
          dueDate: '2026-10-09',
          status: 'pending',
        },
      ],
    },
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'weekly-ledger-test-'));
    store = new WeeklyStore(join(root, 'ledger.json'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it('returns the same durable receipt on repeat and restart', () => {
    const input = command();
    const job = store.accept('meeting', input, 'actor');
    expect(
      new WeeklyStore(store.path).accept('meeting', input, 'actor'),
    ).toEqual(job);
    expect(store.pending()).toHaveLength(1);
  });
  it('生成成功与提醒入队原子保存，重启和后续生成不产生第二份通知', () => {
    const input = {
      clientMutationId: 'notify-first-12345678',
      targetRecordId: 'recExample',
      startDate: '2026-10-01',
      endDate: '2026-10-07',
      expectedDocumentUrl: null,
    };
    store.accept('generate', input, 'actor');
    store.completeGeneration(
      input.clientMutationId,
      { documentUrl: 'https://vnet.feishu.cn/docx/Example' },
      'oc_ba4172984f3293d75bbe7e268d51ef40',
    );
    const restarted = new WeeklyStore(store.path);
    expect(restarted.notifications()).toHaveLength(1);
    store.accept(
      'generate',
      { ...input, clientMutationId: 'notify-other-12345678' },
      'scheduler',
    );
    store.completeGeneration(
      'notify-other-12345678',
      { documentUrl: 'https://vnet.feishu.cn/docx/Example' },
      'oc_ba4172984f3293d75bbe7e268d51ef40',
    );
    expect(store.notifications()).toHaveLength(1);
    expect(store.get('notify-other-12345678').job.notification).toBeUndefined();
  });
  it('rejects reuse with different content or actor', () => {
    const input = command();
    store.accept('meeting', input, 'actor');
    expect(() =>
      store.accept('meeting', { ...input, expectedText: '别的内容' }, 'actor'),
    ).toThrow('不同内容');
    expect(() => store.accept('meeting', input, 'other')).toThrow();
  });
  it.each(['pending', 'sending', 'success', 'error'] as const)(
    '空条目不入提醒队列，旧条目提醒%s不阻止周报提醒',
    (status) => {
      const chatId = 'oc_QaChat';
      const input = {
        clientMutationId: 'empty-12345678',
        targetRecordId: 'recExample',
        startDate: '2026-10-01',
        endDate: '2026-10-07',
        expectedDocumentUrl: null,
        createOnly: true,
      };
      store.accept('generate', input, 'actor');
      store.completeGeneration(input.clientMutationId, {}, chatId);
      expect(
        store.get(input.clientMutationId).job.notification,
      ).toBeUndefined();
      const oldUuid = createHash('sha256')
        .update(`${chatId}:recExample`)
        .digest('hex')
        .slice(0, 32);
      store.change(
        input.clientMutationId,
        {},
        {
          notification: {
            status,
            chatId,
            uuid: oldUuid,
            attempts: 1,
            error: null,
          },
        },
      );
      expect(new WeeklyStore(store.path).notifications()).toHaveLength(0);
      store.accept(
        'generate',
        { ...input, clientMutationId: 'report-12345678', createOnly: false },
        'actor',
      );
      store.completeGeneration(
        'report-12345678',
        { documentUrl: 'https://vnet.feishu.cn/docx/Example' },
        chatId,
      );
      expect(store.notifications()).toHaveLength(1);
      expect(store.get('report-12345678').job.notification?.uuid).not.toBe(
        oldUuid,
      );
    },
  );
  it('升级后不重复发送旧版本已生成周报的通知', () => {
    const input = {
      clientMutationId: 'old-report-12345678',
      targetRecordId: 'recExample',
      startDate: '2026-10-01',
      endDate: '2026-10-07',
      expectedDocumentUrl: null,
    };
    const chatId = 'oc_QaChat';
    store.accept('generate', input, 'actor');
    store.change(
      input.clientMutationId,
      {},
      {
        status: 'success',
        stage: 'done',
        documentUrl: 'https://vnet.feishu.cn/docx/Example',
        notification: {
          status: 'success',
          chatId,
          uuid: 'old-uuid',
          attempts: 1,
          error: null,
        },
      },
    );
    store.accept(
      'generate',
      { ...input, clientMutationId: 'new-report-12345678' },
      'actor',
    );
    store.completeGeneration(
      'new-report-12345678',
      { documentUrl: 'https://vnet.feishu.cn/docx/Example' },
      chatId,
    );
    expect(store.get('new-report-12345678').job.notification).toBeUndefined();
  });
  it('blocks conflicting jobs and stale versions', () => {
    const input = command();
    const job = store.accept('meeting', input, 'actor');
    expect(() =>
      store.accept(
        'meeting',
        { ...input, clientMutationId: 'mutation-23456789' },
        'actor',
      ),
    ).toThrow('未完成');
    store.change(job.id, {}, { status: 'success', stage: 'done' });
    expect(() =>
      store.accept(
        'meeting',
        { ...input, clientMutationId: 'mutation-23456789' },
        'actor',
      ),
    ).toThrow('已被修改');
  });
  const creation = (id: string, endDate: string) => ({
    clientMutationId: id,
    targetRecordId: 'new',
    startDate: '2026-10-01',
    endDate,
    expectedDocumentUrl: null,
    createOnly: true,
  });
  it.each(['accepted', 'running', 'uncertain'] as const)(
    '新建任务 %s 只锁同日期，重启后不阻塞其他日期',
    (status) => {
      const old = store.accept(
        'generate',
        creation('old-create-12345678', '2026-10-09'),
        'actor',
      );
      store.change(old.id, {}, { status });
      const restarted = new WeeklyStore(store.path);
      expect(() =>
        restarted.accept(
          'generate',
          creation('same-create-12345678', '2026-10-09'),
          'actor',
        ),
      ).toThrow();
      expect(
        restarted.accept(
          'generate',
          creation('next-create-12345678', '2026-10-14'),
          'actor',
        ).status,
      ).toBe('accepted');
      expect(restarted.get(old.id).job.status).toBe(status);
    },
  );
  it('条目ID已确认后，同日期新建仍不能绕过未完成任务', () => {
    const old = store.accept(
      'generate',
      creation('resolved-create-12345678', '2026-10-09'),
      'actor',
    );
    store.change(
      old.id,
      {},
      { status: 'running', targetRecordId: 'recCreated' },
    );
    expect(() =>
      store.accept(
        'generate',
        creation('same-create-23456789', '2026-10-09'),
        'actor',
      ),
    ).toThrow();
    expect(
      store.accept(
        'generate',
        creation('next-create-23456789', '2026-10-14'),
        'actor',
      ).status,
    ).toBe('accepted');
  });
  it('不同日期的新建提交不会阻止旧失败步骤重试，同日期仍阻止', () => {
    const old = store.accept(
      'generate',
      creation('retry-create-12345678', '2026-10-09'),
      'actor',
    );
    store.change(old.id, {}, { status: 'error' });
    store.accept(
      'generate',
      creation('later-create-12345678', '2026-10-14'),
      'actor',
    );
    expect(store.retry(old.id, 'actor').status).toBe('accepted');
    store.change(old.id, {}, { status: 'error' });
    store.accept(
      'generate',
      creation('same-later-create-12345678', '2026-10-09'),
      'actor',
    );
    expect(() => store.retry(old.id, 'actor')).toThrow('后续提交');
  });
  it('preserves existing todos when a meeting is cancelled', () => {
    const input = command();
    const job = store.accept('meeting', input, 'actor');
    store.change(job.id, {}, { status: 'success' });
    const cancel = {
      ...input,
      clientMutationId: 'cancel-12345678',
      expectedVersion: 1,
      meeting: {
        ...input.meeting,
        status: 'cancelled' as const,
        actualDate: '',
        note: '会议取消',
        todos: [],
      },
    };
    expect(validateWeeklyMeeting(cancel.meeting)).toBeNull();
    const result = store.accept('meeting', cancel, 'actor');
    store.change(result.id, {}, { status: 'success' });
    expect(store.list().meetings[0].todos).toEqual(input.meeting.todos);
    expect(store.list().meetings[0].status).toBe('cancelled');
  });
  it('queues different actions in one report but blocks repeat edits of the same action', () => {
    const edit = {
      clientMutationId: 'action-edit-12345678',
      targetRecordId: 'recExample',
      actionId: 'recExample:current-actions:0',
      expectedContent: '原文',
      content: '修改',
    };
    store.accept('action-edit', edit, 'actor');
    store.accept(
      'action-edit',
      {
        ...edit,
        clientMutationId: 'action-edit-23456789',
        actionId: 'recExample:current-actions:1',
      },
      'actor',
    );
    expect(store.pending()).toHaveLength(2);
    expect(() =>
      store.accept(
        'action-edit',
        {
          ...edit,
          clientMutationId: 'action-edit-34567890',
        },
        'actor',
      ),
    ).toThrow('未完成');
  });
  it('fails closed on corrupt ledger', () => {
    writeFileSync(store.path, '{}');
    expect(() => store.list()).toThrow('台账读取失败');
  });
  it('does not allow blind retry of unknown creation', () => {
    const job = store.accept('meeting', command(), 'actor');
    store.change(job.id, {}, { status: 'uncertain' });
    expect(() => store.retry(job.id, 'actor')).toThrow('不能自动重试');
  });
  it('rejects retry of a failed task superseded by a newer submission', () => {
    const old = store.accept('meeting', command(), 'actor');
    store.change(old.id, {}, { status: 'error' });
    store.accept(
      'meeting',
      { ...command(), clientMutationId: 'newer-12345678' },
      'actor',
    );
    expect(() => store.retry(old.id, 'actor')).toThrow('后续提交');
  });
  it('calculates Wed boundaries and validates actual calendar dates', () => {
    expect(weeklyPeriod('2026-10-08')).toEqual({
      startDate: '2026-10-01',
      endDate: '2026-10-07',
    });
    expect(weeklyPeriod('2026-10-15')).toEqual({
      startDate: '2026-10-08',
      endDate: '2026-10-14',
    });
    expect(
      validateWeeklyMeeting({
        ...command().meeting,
        plannedDate: '2026-02-30',
      }),
    ).toBe('计划会议日期无效');
    expect(
      validateWeeklyMeeting({
        ...command().meeting,
        status: 'cancelled',
        todos: [],
      }),
    ).toBe('请填写取消或延期原因');
  });
  it('删除任务持久受理、同日期保持锁定，核对成功才解除，并可恢复', () => {
    const old = store.accept(
      'generate',
      creation('delete-old-12345678', '2026-10-09'),
      'actor',
    );
    store.change(
      old.id,
      {},
      { status: 'uncertain', stage: 'row-create', error: '原错误' },
    );
    const accepted = store.deleteTask(old.id, 'delete-task-12345678', 'admin');
    expect(accepted.status).toBe('deleting');
    expect(store.pending()).toHaveLength(1);
    expect(() =>
      store.accept(
        'generate',
        creation('while-delete-12345678', '2026-10-09'),
        'actor',
      ),
    ).toThrow();
    const restarted = new WeeklyStore(store.path);
    expect(
      restarted.deleteTask(old.id, 'delete-task-12345678', 'admin').status,
    ).toBe('deleting');
    restarted.finishTaskDeletion(old.id);
    expect(restarted.get(old.id).job.status).toBe('deleted');
    expect(restarted.get(old.id).command).toEqual(
      creation(old.id, '2026-10-09'),
    );
    expect(() =>
      restarted.accept(
        'generate',
        creation('delete-task-12345678', '2026-10-16'),
        'admin',
      ),
    ).toThrow('提交编号');
    expect(
      restarted.restoreTask(old.id, 'restore-task-12345678', 'admin').status,
    ).toBe('uncertain');
    expect(restarted.get(old.id).job.error).toBe('原错误');
    expect(restarted.pending()).toHaveLength(0);
    expect(
      restarted.deleteTask(old.id, 'delete-task-12345678', 'admin').status,
    ).toBe('uncertain');
  });
  it('源表核对失败恢复原任务，并保护操作编号及新任务', () => {
    const old = store.accept(
      'generate',
      creation('failure-old-12345678', '2026-10-09'),
      'actor',
    );
    store.change(old.id, {}, { status: 'uncertain', stage: 'row-create' });
    store.deleteTask(old.id, 'delete-error-12345678', 'admin');
    store.finishTaskDeletion(old.id, '源表仍有记录');
    expect(store.get(old.id).job).toMatchObject({
      status: 'uncertain',
      deletion: { status: 'error', error: '源表仍有记录' },
    });
    expect(() =>
      store.restoreTask(old.id, 'delete-error-12345678', 'admin'),
    ).toThrow('提交编号');
    expect(() =>
      store.deleteTask(old.id, 'delete-error-12345678', 'other'),
    ).toThrow('提交编号');
    store.deleteTask(old.id, 'delete-again-12345678', 'admin');
    store.finishTaskDeletion(old.id);
    store.accept(
      'generate',
      creation('new-after-delete-12345678', '2026-10-09'),
      'actor',
    );
    expect(() =>
      store.restoreTask(old.id, 'restore-after-new-12345678', 'admin'),
    ).toThrow('新任务');
  });
  it('执行中、已创建文档及其他类型任务不接受删除', () => {
    const old = store.accept(
      'generate',
      creation('inflight-old-12345678', '2026-10-09'),
      'actor',
    );
    expect(() =>
      store.deleteTask(old.id, 'delete-active-12345678', 'admin'),
    ).toThrow();
    store.change(
      old.id,
      {},
      {
        status: 'uncertain',
        documentUrl: 'https://vnet.feishu.cn/docx/Existing',
      },
    );
    expect(() =>
      store.deleteTask(old.id, 'delete-document-12345678', 'admin'),
    ).toThrow();
    const other = store.accept('meeting', command(), 'actor');
    store.change(other.id, {}, { status: 'error' });
    expect(() =>
      store.deleteTask(other.id, 'delete-meeting-12345678', 'admin'),
    ).toThrow();
  });
});
