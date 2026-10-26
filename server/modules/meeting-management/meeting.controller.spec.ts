import { MeetingController } from './meeting.controller';
import type { MeetingService } from './meeting.service';
import type { Request } from 'express';

describe('会议归档权限与记录参数', () => {
  const service = { snapshot: jest.fn(), detail: jest.fn() };
  const controller = new MeetingController(
    service as unknown as MeetingService,
  );
  const request = (role: string) =>
    ({ accessPrincipal: { role } }) as unknown as Request;
  beforeEach(() => jest.clearAllMocks());
  it.each(['guest', 'building_admin', 'inventory_admin', 'purchase_admin'])(
    '%s 不得读取会议内容',
    (role) => {
      expect(() => controller.snapshot(request(role))).toThrow(
        '无会议归档访问权限',
      );
      expect(() => controller.detail(request(role), 'recA')).toThrow(
        '无会议归档访问权限',
      );
      expect(service.snapshot).not.toHaveBeenCalled();
      expect(service.detail).not.toHaveBeenCalled();
    },
  );
  it.each(['admin', 'editor'])('%s 可只读访问', (role) => {
    controller.snapshot(request(role), '1');
    controller.detail(request(role), 'recA');
    expect(service.snapshot).toHaveBeenCalledWith(true);
    expect(service.detail).toHaveBeenCalledWith('recA');
  });
  it.each(['../secret', 'wrong', 'recA%2fB'])('拒绝非法记录参数 %s', (id) => {
    expect(() => controller.detail(request('admin'), id)).toThrow('编号无效');
  });
});
