import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { MeetingDetailResponse } from '../../shared/meeting-management.interface';
import {
  changeWeeklyTask,
  invalidateWeeklyFormRecord,
  seedWeeklyFormRecord,
  weeklyFormRecord,
  weeklyWorkspace,
} from '../../client/src/pages/MeetingManagement/weekly-api';
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({
  axiosForBackend: jest.fn(),
}));
const request = axiosForBackend as jest.Mock;
const record = (title: string): MeetingDetailResponse => ({
  snapshotId: title,
  meeting: {
    id: 'recQAForm',
    title,
    date: '2026-10-07',
    weekLabel: null,
    scope: '机房',
    nature: '管理类',
    source: 'nantong-weekly',
    documentUrl: null,
    updatedAt: null,
    hasActions: false,
    sectionTitles: [],
    sections: [],
  },
});
describe('weekly confirmed form cache', () => {
  it('仅用户显式重检加标记，自动读取不触发检查', async () => {
    request.mockResolvedValue({ data: { meetings: [], jobs: [], people: [] } });
    const signal = new AbortController().signal;
    await weeklyWorkspace(signal, true);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { recheck: '1' } }),
    );
    await weeklyWorkspace(signal);
    expect(request.mock.calls.at(-1)[0].params).toBeUndefined();
  });
  it('删除和恢复使用独立接口并保留稳定提交编号', async () => {
    request.mockResolvedValue({
      data: { id: 'task-12345678', status: 'deleting' },
    });
    await changeWeeklyTask('task-12345678', 'delete', 'delete-12345678');
    await changeWeeklyTask('task-12345678', 'delete', 'delete-12345678');
    await changeWeeklyTask('task-12345678', 'restore', 'restore-12345678');
    expect(
      request.mock.calls.map(([input]) => ({
        url: input.url,
        data: input.data,
        method: input.method,
      })),
    ).toEqual([
      {
        url: '/api/meeting-management/weekly/jobs/task-12345678/delete',
        data: { clientMutationId: 'delete-12345678' },
        method: 'POST',
      },
      {
        url: '/api/meeting-management/weekly/jobs/task-12345678/delete',
        data: { clientMutationId: 'delete-12345678' },
        method: 'POST',
      },
      {
        url: '/api/meeting-management/weekly/jobs/task-12345678/restore',
        data: { clientMutationId: 'restore-12345678' },
        method: 'POST',
      },
    ]);
  });
  it('原文补读内容不冒充可写多维表字段', async () => {
    const detail = record('补读');
    detail.meeting.sections = [
      {
        key: 'professional',
        title: '专业线',
        content: '已归档',
        isAction: false,
      },
      {
        key: 'previous-actions',
        title: '上周周会待办',
        content: '原文待办',
        isAction: true,
        origin: 'document',
      },
    ];
    seedWeeklyFormRecord(detail);
    const cached = await weeklyFormRecord(
      'recQAForm',
      new AbortController().signal,
    );
    expect(cached.meeting.sections.map((section) => section.content)).toEqual([
      '已归档',
    ]);
  });
  beforeEach(() => {
    request.mockReset();
    invalidateWeeklyFormRecord('recQAForm');
  });
  it('opens again without requesting the same fields', async () => {
    request.mockResolvedValue({ data: record('初次') });
    const signal = new AbortController().signal;
    await weeklyFormRecord('recQAForm', signal);
    expect((await weeklyFormRecord('recQAForm', signal)).meeting.title).toBe(
      '初次',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('forces a new read after invalidation', async () => {
    seedWeeklyFormRecord(record('旧记录'));
    invalidateWeeklyFormRecord('recQAForm');
    request.mockResolvedValue({ data: record('新记录') });
    expect(
      (await weeklyFormRecord('recQAForm', new AbortController().signal))
        .meeting.title,
    ).toBe('新记录');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not let a delayed response overwrite a newly confirmed save', async () => {
    let finish!: (value: unknown) => void;
    request.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const signal = new AbortController().signal;
    const old = weeklyFormRecord('recQAForm', signal);
    seedWeeklyFormRecord(record('已确认保存'));
    finish({ data: record('旧响应') });
    await old;
    expect((await weeklyFormRecord('recQAForm', signal)).meeting.title).toBe(
      '已确认保存',
    );
  });
});
