import { AccessPersonnelSyncService } from '../../server/common/access/access-personnel-sync.service';

it('每日同步失败不能占用整日，五分钟后可重试，成功后当天不再重复', async () => {
  let value: Record<string, unknown> = { status: 'error', lastAttemptAt: '2026-10-16T02:00:00+08:00', attempts: 1, attemptDay: '2026-10-16', nextAttemptAt: '2026-10-16T02:05:00+08:00' };
  const service = new AccessPersonnelSyncService({ snapshot: () => ({ personnelSync: value }) } as never, {} as never);
  const run = jest.spyOn(service, 'run').mockImplementation(async () => { value = { ...value, status: 'success', lastSuccessAt: '2026-10-16T02:05:00+08:00' }; return {} as never; });
  await service.tick(new Date('2026-10-16T02:04:59+08:00'));
  expect(run).not.toHaveBeenCalled();
  await service.tick(new Date('2026-10-16T02:05:00+08:00'));
  expect(run).toHaveBeenCalledTimes(1);
  await service.tick(new Date('2026-10-16T03:00:00+08:00'));
  expect(run).toHaveBeenCalledTimes(1);
});

it('每日自动重试最多三次，下一天重新获得重试机会', async () => {
  const value = { status: 'error', lastAttemptAt: '2026-10-16T02:10:00+08:00', attempts: 3, attemptDay: '2026-10-16' };
  const service = new AccessPersonnelSyncService({ snapshot: () => ({ personnelSync: value }) } as never, {} as never);
  const run = jest.spyOn(service, 'run').mockResolvedValue({} as never);
  await service.tick(new Date('2026-10-16T03:00:00+08:00'));
  expect(run).not.toHaveBeenCalled();
  await service.tick(new Date('2026-10-17T02:00:00+08:00'));
  expect(run).toHaveBeenCalledTimes(1);
});
