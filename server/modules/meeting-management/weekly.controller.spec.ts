import type { Request } from 'express';
import { WeeklyController } from './weekly.controller';
import { WeeklyService } from './weekly.service';

describe('weekly server authorization', () => {
  const request = (role?: string) =>
    ({
      accessPrincipal: role ? { role, accountId: 'qa-actor' } : undefined,
    }) as unknown as Request;
  const service = {
    snapshot: jest.fn(),
    recover: jest.fn(),
    recoverRow: jest.fn(),
    save: jest.fn(),
    generate: jest.fn(),
    editAction: jest.fn(),
    attachImages: jest.fn(),
    recoverImage: jest.fn(),
    deleteTask: jest.fn(),
    restoreTask: jest.fn(),
  };
  const controller = new WeeklyController(service as unknown as WeeklyService);
  beforeEach(() => jest.clearAllMocks());
  it.each([undefined, 'visitor', 'purchase', 'viewer'])(
    'denies %s on workspace and mutations',
    (role) => {
      expect(() => controller.snapshot(request(role))).toThrow(
        '无周会操作权限',
      );
      expect(() => controller.generate(request(role), {} as never)).toThrow(
        '无周会操作权限',
      );
      expect(service.generate).not.toHaveBeenCalled();
      expect(() => controller.editAction(request(role), {} as never)).toThrow(
        '无周会操作权限',
      );
      expect(() => controller.attachImages(request(role), '{}', [])).toThrow(
        '无周会操作权限',
      );
    },
  );
  it('allows editors to save and restricts unknown-result recovery to administrators', () => {
    controller.save(request('editor'), {} as never);
    expect(service.save).toHaveBeenCalledWith({}, 'qa-actor');
    expect(() =>
      controller.recover(request('editor'), 'job', { documentUrl: 'url' }),
    ).toThrow('无周会操作权限');
    controller.recoverRow(request('admin'), 'job', { targetRecordId: 'recQa' });
    expect(service.recoverRow).toHaveBeenCalledWith('job', 'recQa');
  });
  it('工作台仅显式recheck=1请求重检，自动读取保持原行为', () => {
    controller.snapshot(request('editor'), '1');
    expect(service.snapshot).toHaveBeenLastCalledWith(true);
    controller.snapshot(request('editor'));
    expect(service.snapshot).toHaveBeenLastCalledWith(false);
    controller.snapshot(request('editor'), 'true');
    expect(service.snapshot).toHaveBeenLastCalledWith(false);
  });
  it('图片恢复仅管理员可操作，非法 JSON 不受理', () => {
    expect(() =>
      controller.recoverImage(request('editor'), 'job', {
        fileToken: 'fileQa',
      }),
    ).toThrow('无周会操作权限');
    expect(() =>
      controller.attachImages(request('admin'), 'invalid', []),
    ).toThrow('参数无效');
    expect(service.attachImages).not.toHaveBeenCalled();
  });
  it('删除和恢复任务仅管理员可操作，并携带稳定操作编号', () => {
    const body = { clientMutationId: 'delete-role-12345678' };
    expect(() =>
      controller.deleteTask(request('editor'), 'job', body),
    ).toThrow();
    expect(() =>
      controller.restoreTask(request('editor'), 'job', body),
    ).toThrow();
    expect(service.deleteTask).not.toHaveBeenCalled();
    controller.deleteTask(request('admin'), 'job', body);
    expect(service.deleteTask).toHaveBeenCalledWith(
      'job',
      body.clientMutationId,
      'qa-actor',
      true,
    );
    controller.restoreTask(request('admin'), 'job', body);
    expect(service.restoreTask).toHaveBeenCalledWith(
      'job',
      body.clientMutationId,
      'qa-actor',
      true,
    );
  });
});
