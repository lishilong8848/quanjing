import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeeklyService } from './weekly.service';
import { WeeklyGateway } from './weekly.gateway';
import { WeeklyEngine, WeeklyEngineError } from './weekly.engine';
import { MeetingService } from './meeting.service';
import { mapWeeklyMeeting } from './meeting.mapper';
import type {
  GenerateWeeklyReport,
  SaveWeeklyMeeting,
} from '../../../shared/weekly-workspace.interface';

describe('weekly phased synchronization', () => {
  let root: string;
  let service: WeeklyService;
  let gateway: {
    people: jest.Mock;
    update: jest.Mock;
    grantDocument: jest.Mock;
    ensureCreationField: jest.Mock;
    findCreated: jest.Mock;
    assertNoDate: jest.Mock;
    createRow: jest.Mock;
    record: jest.Mock;
    sendWeeklyReport: jest.Mock;
    creationLink: jest.Mock;
  };
  let engine: { call: jest.Mock; status: jest.Mock; requestCheck: jest.Mock };
  const command: GenerateWeeklyReport = {
    clientMutationId: 'generate-12345678',
    targetRecordId: 'recExample',
    startDate: '2026-10-01',
    endDate: '2026-10-07',
    expectedDocumentUrl: null,
    confirmedNoTodos: true,
  };
  const tick = () => (service as unknown as { tick(): Promise<void> }).tick();
  it('显式重检即时返回状态，不等待慢检查，自动读取不重复检查', async () => {
    engine.status.mockReturnValue({
      ready: false,
      message: '正在检查周报引擎',
    });
    await service.snapshot(true);
    expect(engine.requestCheck).toHaveBeenCalledTimes(1);
    await service.snapshot();
    expect(engine.requestCheck).toHaveBeenCalledTimes(1);
    expect(engine.call).not.toHaveBeenCalled();
  });
  it('生成不能隐式新建条目，空待办需要显式确认', async () => {
    await expect(
      service.generate({ ...command, targetRecordId: 'new' }, 'actor'),
    ).rejects.toThrow('已有条目');
    gateway.record.mockResolvedValue({ 日期: command.endDate });
    await expect(
      service.generate({ ...command, confirmedNoTodos: false }, 'actor'),
    ).rejects.toThrow('确认本期无待办');
    expect(service.store.list().jobs).toHaveLength(0);
    const accepted = await service.generate(command, 'actor');
    await tick();
    expect(service.job(accepted.id).status).toBe('success');
    expect(gateway.createRow).not.toHaveBeenCalled();
  });
  it.each(['阿里会议待办', '上周周会待办'])(
    '仅%s有内容时可以直接生成',
    async (field) => {
      gateway.record.mockResolvedValue({
        日期: command.endDate,
        [field]: '核查设备',
      });
      const accepted = await service.generate(
        { ...command, confirmedNoTodos: false },
        'actor',
      );
      await tick();
      expect(service.job(accepted.id).status).toBe('success');
    },
  );
  it('受理后待办被清空仍须确认，不能绕过后台校验', async () => {
    gateway.record
      .mockResolvedValueOnce({
        日期: command.endDate,
        阿里会议待办: '核查设备',
      })
      .mockResolvedValue({ 日期: command.endDate });
    const accepted = await service.generate(
      { ...command, confirmedNoTodos: false },
      'actor',
    );
    await tick();
    expect(service.job(accepted.id)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('确认本期无待办'),
    });
    expect(engine.call).not.toHaveBeenCalled();
  });
  it('月末预建下月空条目，不运行引擎；同日多次调度不重复创建', async () => {
    process.env.NANTONG_WEEKLY_PRECREATE_ENABLED = 'true';
    jest.useFakeTimers().setSystemTime(new Date('2026-10-31T02:00:00+08:00'));
    const snapshot = jest.fn().mockResolvedValue({ records: [] });
    (
      service as unknown as { meetings: { weeklySnapshot: jest.Mock } }
    ).meetings.weeklySnapshot = snapshot;
    gateway.createRow.mockImplementation(async (date, _marker, saved) => {
      const id = `rec${date.replaceAll('-', '')}`;
      saved(id);
      return id;
    });
    gateway.record.mockImplementation(async (id) => ({
      日期: `${id.slice(3, 7)}-${id.slice(7, 9)}-${id.slice(9, 11)}`,
    }));
    await tick();
    await tick();
    expect(gateway.createRow).toHaveBeenCalledTimes(4);
    expect(gateway.createRow.mock.calls.map((args) => args[0])).toEqual([
      '2026-11-04',
      '2026-11-11',
      '2026-11-18',
      '2026-11-25',
    ]);
    expect(engine.call).not.toHaveBeenCalled();
    expect(
      service.store
        .list()
        .jobs.every((job) => job.createOnly && job.status === 'success'),
    ).toBe(true);
    expect(gateway.sendWeeklyReport).not.toHaveBeenCalled();
  });
  it.each(['missing', 'empty', 'filled'])(
    '定时生成%s目标遵守独立条目及待办检查',
    async (mode) => {
      process.env.NANTONG_WEEKLY_SCHEDULE_ENABLED = 'true';
      jest.useFakeTimers().setSystemTime(new Date('2026-10-08T08:30:00+08:00'));
      const records =
        mode === 'missing'
          ? []
          : [{ id: 'recExample', date: command.endDate, documentUrl: null }];
      (
        service as unknown as { meetings: { weeklySnapshot: jest.Mock } }
      ).meetings.weeklySnapshot = jest.fn().mockResolvedValue({ records });
      gateway.record.mockResolvedValue({
        日期: command.endDate,
        ...(mode === 'filled' ? { 阿里会议待办: '核查设备' } : {}),
      });
      await tick();
      await tick();
      expect(gateway.createRow).not.toHaveBeenCalled();
      if (mode === 'filled') {
        expect(service.store.list().jobs).toHaveLength(1);
        expect(service.store.list().jobs[0].status).toBe('success');
        expect(engine.call).toHaveBeenCalledTimes(2);
      } else {
        expect(engine.call).not.toHaveBeenCalled();
        expect((await service.snapshot()).schedule.message).toContain(
          mode === 'empty' ? '确认本期无待办' : '新建条目',
        );
      }
    },
  );
  it('retains safe engine failure evidence and retries preparation on the original created row', async () => {
    const input = { ...command, targetRecordId: 'new', endDate: '2026-10-14' };
    engine.call.mockRejectedValueOnce(
      new WeeklyEngineError('采集超时', undefined, {
        category: 'timeout',
        type: 'RuntimeError',
        frames: ['main:68'],
      }),
    );
    service.store.accept('generate', input, 'actor');
    await tick();
    expect(service.job(input.clientMutationId)).toMatchObject({
      status: 'error',
      stage: 'prepare',
      targetRecordId: 'recCreated',
    });
    expect(
      (
        service.store.get(input.clientMutationId) as unknown as {
          engineDiagnostic: unknown;
        }
      ).engineDiagnostic,
    ).toEqual({
      category: 'timeout',
      type: 'RuntimeError',
      frames: ['main:68'],
    });
    service.retry(input.clientMutationId, 'actor');
    await tick();
    expect(service.job(input.clientMutationId).status).toBe('success');
    expect(gateway.createRow).toHaveBeenCalledTimes(1);
    expect(gateway.sendWeeklyReport).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'weekly-service-test-'));
    process.env.WEEKLY_WORKSPACE_DIR = root;
    process.env.NANTONG_WEEKLY_EDITOR_OPEN_IDS = 'ou_12345678901';
    gateway = {
      people: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
      grantDocument: jest.fn().mockResolvedValue(undefined),
      ensureCreationField: jest.fn().mockResolvedValue(undefined),
      findCreated: jest.fn().mockResolvedValue(null),
      assertNoDate: jest.fn().mockResolvedValue(undefined),
      createRow: jest.fn().mockResolvedValue('recCreated'),
      record: jest.fn().mockResolvedValue({ 日期: '2026-10-14' }),
      sendWeeklyReport: jest.fn().mockResolvedValue('om_QaNotification'),
      creationLink: jest
        .fn()
        .mockResolvedValue(
          'https://vnet.feishu.cn/base/QaBase?table=tblExample&record=recCreated',
        ),
    };
    engine = {
      requestCheck: jest.fn(),
      status: jest.fn().mockReturnValue({ ready: true }),
      call: jest.fn().mockImplementation(async (payload) =>
        payload.action === 'prepare'
          ? {
              xml: '<p>周报</p>',
              title: '周报',
              professional: '专业',
              operations: '运营',
            }
          : { documentUrl: 'https://vnet.feishu.cn/docx/Example' },
      ),
    };
    const meetings = {
      detail: jest.fn().mockResolvedValue({
        meeting: mapWeeklyMeeting({
          record_id: 'recExample',
          fields: { 日期: '2026-10-07' },
        }),
      }),
      applyWeeklyFields: jest.fn().mockResolvedValue(undefined),
      addWeeklyRecord: jest.fn().mockResolvedValue(undefined),
    };
    service = new WeeklyService(
      gateway as unknown as WeeklyGateway,
      engine as unknown as WeeklyEngine,
      meetings as unknown as MeetingService,
    );
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.NANTONG_WEEKLY_PRECREATE_ENABLED;
    delete process.env.NANTONG_WEEKLY_SCHEDULE_ENABLED;
    service.onModuleDestroy();
    delete process.env.WEEKLY_WORKSPACE_DIR;
    delete process.env.NANTONG_WEEKLY_EDITOR_OPEN_IDS;
    rmSync(root, { recursive: true, force: true });
  });
  const uncertainCreation = () => {
    const job = service.store.accept(
      'generate',
      { ...command, targetRecordId: 'new', endDate: '2026-10-09' },
      'actor',
    );
    return service.store.change(
      job.id,
      {},
      { status: 'uncertain', stage: 'row-create' },
    );
  };
  it('删除先落账立即受理，后台核对不存在后删除；不创建文档或发送消息', async () => {
    const old = uncertainCreation();
    const result = service.deleteTask(
      old.id,
      'delete-fast-12345678',
      'admin',
      true,
    );
    expect(result.status).toBe('deleting');
    expect(gateway.findCreated).not.toHaveBeenCalled();
    await tick();
    expect(service.store.get(old.id).job.status).toBe('deleted');
    expect(gateway.findCreated).toHaveBeenCalledWith(old.id);
    expect(gateway.assertNoDate).toHaveBeenCalledWith('2026-10-09');
    expect(gateway.createRow).not.toHaveBeenCalled();
    expect(gateway.update).not.toHaveBeenCalled();
    expect(engine.call).not.toHaveBeenCalled();
    expect(gateway.sendWeeklyReport).not.toHaveBeenCalled();
  });
  it.each(['found', 'timeout', 'same-date'])(
    '核对 %s 时原任务保留，不能伪报删除成功',
    async (failure) => {
      const old = uncertainCreation();
      if (failure === 'found')
        gateway.findCreated.mockResolvedValue('recStillExists');
      if (failure === 'timeout')
        gateway.findCreated.mockRejectedValue(new Error('查询超时'));
      if (failure === 'same-date')
        gateway.assertNoDate.mockRejectedValue(new Error('该日期已有周报'));
      service.deleteTask(old.id, 'delete-failure-12345678', 'admin', true);
      await tick();
      expect(service.store.get(old.id).job).toMatchObject({
        status: 'uncertain',
        deletion: { status: 'error' },
      });
      expect(gateway.createRow).not.toHaveBeenCalled();
    },
  );
  it('非管理员不能删除或恢复；删除后恢复不自动执行旧任务', async () => {
    const old = uncertainCreation();
    expect(() =>
      service.deleteTask(old.id, 'delete-role-12345678', 'editor'),
    ).toThrow();
    service.deleteTask(old.id, 'delete-admin-12345678', 'admin', true);
    await tick();
    expect(() =>
      service.restoreTask(old.id, 'restore-role-12345678', 'editor'),
    ).toThrow();
    expect(
      service.restoreTask(old.id, 'restore-admin-12345678', 'admin', true)
        .status,
    ).toBe('uncertain');
    expect(service.store.pending()).toHaveLength(0);
  });
  it('修改待办先持久受理，读取原文和员工校验不阻塞受理', async () => {
    gateway.record.mockImplementation(() => new Promise(() => {}));
    const input = {
      clientMutationId: 'edit-fast-12345678',
      targetRecordId: 'recExample',
      actionId: 'recExample:current-actions:0',
      expectedContent: '检查',
      content: '调整',
      assignee: {
        kind: 'employee' as const,
        openId: 'ou_12345678901',
        name: '张三',
      },
    };
    const result = await Promise.race([
      service.editAction(input, 'actor'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);
    expect(result).not.toBe('blocked');
    expect(result).toMatchObject({
      status: 'accepted',
      id: input.clientMutationId,
    });
    expect(service.store.get(input.clientMutationId).command).toMatchObject(
      input,
    );
    gateway.record.mockResolvedValue({ 本周代办: '1. 检查' });
    await tick();
  });
  it('creates once and retries only archive after failure', async () => {
    gateway.update.mockRejectedValueOnce(new Error('回读失败'));
    service.store.accept('generate', command, 'actor');
    await tick();
    expect(service.job(command.clientMutationId).status).toBe('error');
    expect(service.job(command.clientMutationId).stage).toBe('archive');
    expect(gateway.sendWeeklyReport).not.toHaveBeenCalled();
    service.store.retry(command.clientMutationId, 'actor');
    await tick();
    expect(service.job(command.clientMutationId).status).toBe('success');
    expect(engine.call.mock.calls.map((c) => c[0].action)).toEqual([
      'prepare',
      'create',
    ]);
    expect(gateway.update).toHaveBeenCalledTimes(2);
    expect(gateway.sendWeeklyReport).toHaveBeenCalledTimes(1);
    expect(gateway.update.mock.calls[1][2]).not.toHaveProperty('阿里会议待办');
    expect(gateway.update.mock.calls[1][2]).not.toHaveProperty('上周周会待办');
  });
  it('手动和定时任务共用生成流程，归档确认后仅提醒一次', async () => {
    service.store.accept('generate', command, 'actor');
    await tick();
    await tick();
    expect(gateway.sendWeeklyReport).toHaveBeenCalledTimes(1);
    expect(gateway.sendWeeklyReport).toHaveBeenCalledWith(
      'oc_ba4172984f3293d75bbe7e268d51ef40',
      expect.any(String),
      expect.any(String),
      'https://vnet.feishu.cn/docx/Example',
    );
    expect(service.job(command.clientMutationId).notification).toMatchObject({
      status: 'success',
      messageId: 'om_QaNotification',
    });
    service.store.accept(
      'generate',
      {
        ...command,
        clientMutationId: 'scheduled-2026-10-14',
        targetRecordId: 'recOther',
        endDate: '2026-10-14',
      },
      'scheduler',
    );
    await tick();
    expect(gateway.sendWeeklyReport).toHaveBeenCalledTimes(2);
  });
  it('群提醒超时可安全重试，不能重建周报，超过去重窗口不能盲目重发', async () => {
    gateway.sendWeeklyReport.mockRejectedValueOnce(new Error('超时'));
    service.store.accept('generate', command, 'actor');
    await tick();
    expect(service.job(command.clientMutationId).status).toBe('success');
    expect(service.job(command.clientMutationId).notification?.status).toBe(
      'pending',
    );
    await tick();
    expect(service.job(command.clientMutationId).notification?.status).toBe(
      'success',
    );
    expect(gateway.sendWeeklyReport.mock.calls[0][1]).toBe(
      gateway.sendWeeklyReport.mock.calls[1][1],
    );
    expect(engine.call).toHaveBeenCalledTimes(2);
    const notification = service.job(command.clientMutationId).notification!;
    service.store.change(
      command.clientMutationId,
      {},
      {
        notification: {
          ...notification,
          status: 'sending',
          firstAttemptAt: new Date(Date.now() - 3600000).toISOString(),
        },
      },
    );
    await tick();
    expect(service.job(command.clientMutationId).notification?.status).toBe(
      'uncertain',
    );
    expect(gateway.sendWeeklyReport).toHaveBeenCalledTimes(2);
  });
  it('新建空条目不发送，完成周报才发一次，已有文档再生成不重复提醒', async () => {
    service.store.accept(
      'generate',
      { ...command, targetRecordId: 'new', createOnly: true },
      'actor',
    );
    await tick();
    expect(gateway.sendWeeklyReport).not.toHaveBeenCalled();
    expect(gateway.creationLink).not.toHaveBeenCalled();
    service.store.accept(
      'generate',
      {
        ...command,
        targetRecordId: 'recCreated',
        clientMutationId: 'complete-new-12345678',
      },
      'actor',
    );
    await tick();
    expect(gateway.sendWeeklyReport).toHaveBeenCalledTimes(1);
    expect(gateway.sendWeeklyReport.mock.calls[0][3]).toBe(
      'https://vnet.feishu.cn/docx/Example',
    );
    service.store.accept(
      'generate',
      {
        ...command,
        clientMutationId: 'regenerate-12345678',
        expectedDocumentUrl: 'https://vnet.feishu.cn/docx/Existing',
      },
      'actor',
    );
    await tick();
    expect(gateway.sendWeeklyReport).toHaveBeenCalledTimes(1);
  });
  it('旧空条目提醒不能调度发送或手动重试', async () => {
    service.store.accept('generate', { ...command, createOnly: true }, 'actor');
    service.store.change(
      command.clientMutationId,
      {},
      {
        status: 'success',
        stage: 'done',
        notification: {
          status: 'pending',
          chatId: 'oc_QaChat',
          uuid: 'old-uuid',
          attempts: 0,
          error: null,
        },
      },
    );
    await tick();
    expect(gateway.sendWeeklyReport).not.toHaveBeenCalled();
    service.store.change(
      command.clientMutationId,
      {},
      {
        notification: {
          status: 'error',
          chatId: 'oc_QaChat',
          uuid: 'old-uuid',
          attempts: 1,
          error: '超时',
        },
      },
    );
    expect(() =>
      service.retryNotification(command.clientMutationId, 'actor'),
    ).toThrow('不能重试');
  });
  it('先超时后拒绝仍保留原发送窗口，权限修复后也不能跨窗口盲发', async () => {
    gateway.sendWeeklyReport
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(
        Object.assign(new Error('权限拒绝'), { notificationRejected: true }),
      );
    service.store.accept('generate', command, 'actor');
    await tick();
    const first = service.job(command.clientMutationId).notification!
      .firstAttemptAt;
    await tick();
    const failed = service.job(command.clientMutationId).notification!;
    expect(failed).toMatchObject({
      status: 'error',
      firstAttemptAt: first,
      mayHaveSent: true,
    });
    service.store.change(
      command.clientMutationId,
      {},
      {
        notification: {
          ...failed,
          firstAttemptAt: new Date(Date.now() - 3600000).toISOString(),
        },
      },
    );
    expect(() =>
      service.retryNotification(command.clientMutationId, 'actor'),
    ).toThrow('去重窗口');
    expect(gateway.sendWeeklyReport).toHaveBeenCalledTimes(2);
  });
  it('blocks repeated creation after an unknown result and after restart', async () => {
    engine.call.mockImplementation(async (payload) => {
      if (payload.action === 'create') throw new Error('超时');
      return { xml: '<p/>', title: '周报', professional: '', operations: '' };
    });
    service.store.accept('generate', command, 'actor');
    await tick();
    await tick();
    expect(service.job(command.clientMutationId).status).toBe('uncertain');
    expect(
      engine.call.mock.calls.filter((c) => c[0].action === 'create'),
    ).toHaveLength(1);
    expect(gateway.update).not.toHaveBeenCalled();
  });
  it('converts interrupted creation to uncertain without another external call', async () => {
    service.store.accept('generate', command, 'actor');
    service.store.change(
      command.clientMutationId,
      {},
      { status: 'running', stage: 'create' },
    );
    await tick();
    expect(service.job(command.clientMutationId).status).toBe('uncertain');
    expect(engine.call).not.toHaveBeenCalled();
  });
  it('stores cancellation without clearing external todos', async () => {
    const cancel: SaveWeeklyMeeting = {
      clientMutationId: 'cancel-12345678',
      expectedText: '旧待办',
      expectedVersion: 0,
      meeting: {
        targetRecordId: 'recExample',
        kind: 'local',
        plannedDate: '2026-10-08',
        actualDate: '',
        status: 'cancelled',
        note: '本周取消',
        todos: [],
      },
    };
    service.store.accept('meeting', cancel, 'actor');
    await tick();
    expect(service.job(cancel.clientMutationId).status).toBe('success');
    expect(gateway.update).not.toHaveBeenCalled();
    expect(service.store.list().meetings[0].status).toBe('cancelled');
  });
  it('rejects an incorrect target date and invalid person identity', async () => {
    gateway.record.mockResolvedValue({ 日期: '2026-10-07' });
    await expect(
      service.generate({ ...command, endDate: '2026-10-14' }, 'actor'),
    ).rejects.toThrow('结束日期');
    const save: SaveWeeklyMeeting = {
      clientMutationId: 'person-12345678',
      expectedText: '',
      expectedVersion: 0,
      meeting: {
        targetRecordId: 'recExample',
        kind: 'ali',
        plannedDate: '2026-10-07',
        actualDate: '2026-10-07',
        status: 'held',
        note: '',
        todos: [
          {
            id: 'todo-1',
            content: '修复',
            ownerOpenId: 'ou_12345678901',
            ownerName: '不在册',
            dueDate: '',
            status: 'pending',
          },
        ],
      },
    };
    await expect(service.save(save, 'actor')).rejects.toThrow('责任人不在');
  });
  it('仅更新待办不改已有取消状态，并实际同步正文', async () => {
    service.store.accept(
      'meeting',
      {
        clientMutationId: 'cancel-before-todo',
        expectedText: '旧',
        expectedVersion: 0,
        meeting: {
          targetRecordId: 'recExample',
          kind: 'local',
          plannedDate: '2026-10-08',
          actualDate: '',
          status: 'cancelled',
          note: '临时取消',
          todos: [],
        },
      },
      'actor',
    );
    await tick();
    const accepted = await service.save(
      {
        clientMutationId: 'todo-only-123456',
        todoOnly: true,
        expectedText: '旧',
        expectedVersion: 1,
        meeting: {
          targetRecordId: 'recExample',
          kind: 'local',
          plannedDate: '2026-10-07',
          actualDate: '2026-10-07',
          status: 'held',
          note: '',
          todos: [],
          rawText: '新待办',
        },
      },
      'actor',
    );
    await tick();
    expect(service.job(accepted.id).status).toBe('success');
    expect(service.store.list().meetings[0]).toMatchObject({
      status: 'cancelled',
      note: '临时取消',
      rawText: '新待办',
    });
    expect(gateway.update).toHaveBeenCalledWith(
      'recExample',
      { 上周周会待办: '旧' },
      { 上周周会待办: '新待办' },
    );
  });
  it('后台准备并写入单项，失败重试复用原文快照且Mutation保持幂等', async () => {
    gateway.record.mockResolvedValue({ 本周代办: '☐ 采购\n☐ 研发' });
    gateway.update.mockRejectedValueOnce(new Error('慢系统失败'));
    const input = {
      clientMutationId: 'action-retry-123456',
      targetRecordId: 'recExample',
      actionId: 'recExample:current-actions:1',
      expectedContent: '研发',
      content: '研发测试',
    };
    await service.editAction(input, 'actor');
    await tick();
    expect(service.job(input.clientMutationId).status).toBe('error');
    expect(
      service.store.get(input.clientMutationId).preparedAction?.desiredText,
    ).toBe('☐ 采购\n☐ 研发测试');
    expect((await service.editAction(input, 'actor')).id).toBe(
      input.clientMutationId,
    );
    service.retry(input.clientMutationId, 'actor');
    await tick();
    expect(service.job(input.clientMutationId)).toMatchObject({
      status: 'success',
      actionResult: { content: '研发测试' },
    });
    expect(gateway.record).toHaveBeenCalledTimes(1);
  });
  it('creates a report row without running the document engine', async () => {
    const create = {
      ...command,
      targetRecordId: 'new',
      endDate: '2026-10-14',
      createOnly: true,
    };
    service.store.accept('generate', create, 'actor');
    await tick();
    expect(service.job(create.clientMutationId)).toMatchObject({
      status: 'success',
      targetRecordId: 'recCreated',
    });
    expect(gateway.createRow).toHaveBeenCalledTimes(1);
    expect(engine.call).not.toHaveBeenCalled();
  });
  it('retries only confirmation after receiving a row ID and returns the canonical record', async () => {
    const create = {
      ...command,
      targetRecordId: 'new',
      endDate: '2026-10-14',
      createOnly: true,
    };
    gateway.createRow.mockImplementationOnce(async (_date, _id, saved) => {
      saved('recCreated');
      throw new Error('确认超时');
    });
    gateway.record.mockResolvedValue({
      日期: '2026-10-14',
      周报生成标识: create.clientMutationId,
    });
    (gateway as unknown as { text: (value: unknown) => string }).text = String;
    service.store.accept('generate', create, 'actor');
    await tick();
    expect(service.job(create.clientMutationId).status).toBe('error');
    service.retry(create.clientMutationId, 'actor');
    await tick();
    expect(gateway.createRow).toHaveBeenCalledTimes(1);
    expect(service.job(create.clientMutationId)).toMatchObject({
      status: 'success',
      record: { id: 'recCreated', date: '2026-10-14' },
    });
  });
  it('recovers an interrupted row creation by marker without creating twice', async () => {
    const create = { ...command, targetRecordId: 'new', createOnly: true };
    service.store.accept('generate', create, 'actor');
    service.store.change(
      create.clientMutationId,
      {},
      { stage: 'row-create', status: 'running' },
    );
    gateway.findCreated.mockResolvedValue('recCreated');
    await tick();
    expect(service.job(create.clientMutationId).status).toBe('success');
    expect(gateway.createRow).not.toHaveBeenCalled();
  });
  it('does not create another row when interrupted creation cannot be found', async () => {
    const create = { ...command, targetRecordId: 'new', createOnly: true };
    service.store.accept('generate', create, 'actor');
    service.store.change(
      create.clientMutationId,
      {},
      { stage: 'row-create', status: 'running' },
    );
    await tick();
    await tick();
    expect(service.job(create.clientMutationId).status).toBe('uncertain');
    expect(gateway.createRow).not.toHaveBeenCalled();
  });
  it('retries only permissions and archive after a permission failure', async () => {
    gateway.grantDocument.mockRejectedValueOnce(new Error('权限失败'));
    service.store.accept('generate', command, 'actor');
    await tick();
    expect(service.job(command.clientMutationId).stage).toBe('permissions');
    expect(gateway.sendWeeklyReport).not.toHaveBeenCalled();
    service.store.retry(command.clientMutationId, 'actor');
    await tick();
    expect(service.job(command.clientMutationId).status).toBe('success');
    expect(engine.call.mock.calls.map((c) => c[0].action)).toEqual([
      'prepare',
      'create',
    ]);
    expect(
      service.store.get(command.clientMutationId).artifact,
    ).toBeUndefined();
    expect(gateway.sendWeeklyReport).toHaveBeenCalledTimes(1);
  });
  it('replays an accepted generation after the target document has changed', async () => {
    gateway.record.mockResolvedValue({ 日期: '2026-10-07' });
    const accepted = await service.generate(command, 'actor');
    await tick();
    const duplicate = await service.generate(command, 'actor');
    expect(duplicate.id).toBe(accepted.id);
    expect(
      engine.call.mock.calls.filter((c) => c[0].action === 'create'),
    ).toHaveLength(1);
  });
});
