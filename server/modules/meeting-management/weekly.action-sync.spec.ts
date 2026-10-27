import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeeklyService } from './weekly.service';
import { WeeklyGateway } from './weekly.gateway';
import { WeeklyEngine } from './weekly.engine';
import { MeetingService } from './meeting.service';
import type { EditMeetingAction } from '../../../shared/weekly-workspace.interface';
describe('待办单项同步闭环', () => {
  let root: string;
  let service: WeeklyService;
  let update: jest.Mock;
  const command: EditMeetingAction = {
    clientMutationId: 'action-12345678',
    targetRecordId: 'recExample',
    actionId: 'recExample:current-actions:0',
    expectedContent: '检查液位',
    content: '检查液位并调整',
    assignee: { kind: 'employee', name: '马进宇', openId: 'ou_12345678901' },
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'weekly-action-test-'));
    process.env.WEEKLY_WORKSPACE_DIR = root;
    update = jest.fn().mockResolvedValue(undefined);
    const gateway = {
      record: jest
        .fn()
        .mockResolvedValue({ 本周代办: '1. 检查液位\n2. 相邻事项' }),
      people: jest
        .fn()
        .mockResolvedValue([{ name: '马进宇', openId: 'ou_12345678901' }]),
      update,
    };
    service = new WeeklyService(
      gateway as unknown as WeeklyGateway,
      { status: () => ({ ready: false }) } as unknown as WeeklyEngine,
      {
        applyWeeklyFields: jest.fn().mockResolvedValue(undefined),
      } as unknown as MeetingService,
    );
  });
  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    service.onModuleDestroy();
    delete process.env.WEEKLY_WORKSPACE_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  const tick = () => (service as unknown as { tick(): Promise<void> }).tick();
  it('持久受理、精准字段写入、重试同编号以及稳定身份保留', async () => {
    const accepted = await service.editAction(command, 'qa');
    expect(accepted.status).toBe('accepted');
    await tick();
    expect(service.job(accepted.id).status).toBe('success');
    expect(update).toHaveBeenCalledWith(
      'recExample',
      { 本周代办: '1. 检查液位\n2. 相邻事项' },
      { 本周代办: '1. 检查液位并调整（责任人：马进宇）\n2. 相邻事项' },
    );
    expect((await service.editAction(command, 'qa')).status).toBe('success');
    expect(update).toHaveBeenCalledTimes(1);
    expect(service.store.actionOwners()[0].assignee).toEqual(command.assignee);
  });
  it('失败重试不重建任务，原文冲突不受理，假身份不受理', async () => {
    update.mockRejectedValueOnce(new Error('同步失败'));
    const accepted = await service.editAction(command, 'qa');
    await tick();
    expect(service.job(accepted.id).status).toBe('error');
    service.retry(accepted.id, 'qa');
    await tick();
    expect(service.job(accepted.id).status).toBe('success');
    expect(service.store.list().jobs).toHaveLength(1);
    await expect(
      service.editAction(
        {
          ...command,
          clientMutationId: 'conflict-12345678',
          expectedContent: '已修改',
        },
        'qa',
      ),
    ).rejects.toThrow('已被修改');
    await expect(
      service.editAction(
        {
          ...command,
          clientMutationId: 'fake-12345678',
          assignee: {
            kind: 'employee',
            name: '其他人',
            openId: 'ou_99999999999',
          },
        },
        'qa',
      ),
    ).rejects.toThrow('在职员工列表');
  });
});
