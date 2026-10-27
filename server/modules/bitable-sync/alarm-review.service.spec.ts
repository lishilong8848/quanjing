import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlarmReviewService } from './alarm-review.service';
import { AlarmReviewStore } from './alarm-review.store';
import type { AlarmReviewGateway } from './alarm-review.gateway';
import type { BitableSyncService } from './bitable-sync.service';
import type { TodayOperationsAlarmService } from './today-operations-alarm.service';

describe('alarm review acceptance and processing', () => {
  let dir: string;
  let service: AlarmReviewService;
  let sync: jest.Mock;
  let preflight: jest.Mock;
  let resolveResponsibleUserId: jest.Mock;
  const request = { recordIds: ['recA', 'recB'], outcome: '人工复核无问题', responsibleRecordId: 'recPerson', clientMutationId: 'alarm-review-12345678' };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alarm-review-service-'));
    preflight = jest.fn(async () => {});
    resolveResponsibleUserId = jest.fn(async () => 'user123');
    sync = jest.fn(async (id: string) => { if (id === 'recB') throw new Error('secret unsafe error'); return { 人工复核结果: '人工复核无问题', 复核责任人: [{ id: 'user123', name: '责任人' }] }; });
    service = new AlarmReviewService(new AlarmReviewStore(join(dir, 'ledger.json')),
      { preflight, resolveResponsibleUserId, syncRecord: sync } as unknown as AlarmReviewGateway,
      { getCachedActivePersonnelDirectory: async () => ({ personnel: [{ recordId: 'recPerson', name: '责任人', openId: 'ou_123', position: '工程师', buildings: ['A'] }] }) } as unknown as BitableSyncService,
      { patchHumanReview: jest.fn() } as unknown as TodayOperationsAlarmService);
  });
  afterEach(() => { service.onModuleDestroy(); rmSync(dir, { recursive: true, force: true }); });
  it('does not contact the source gateway for an isolated empty ledger', async () => {
    await service.processReady();
    await service.processReady();
    expect(preflight).not.toHaveBeenCalled();
    expect(resolveResponsibleUserId).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
  it.each(['guest', 'duty_editor', 'building_admin'])('rejects unauthorized role %s', async (role) => {
    await expect(service.submit(request, role as never, 'session')).rejects.toThrow('复核权限');
    expect(sync).not.toHaveBeenCalled();
  });
  it('accepts durable work, reports partial failure, retries only failures', async () => {
    const task = await service.submit(request, 'editor', 'session');
    expect(task.items.every((item) => item.state === 'pending')).toBe(true);
    await service.processReady();
    let result = service.status(task.id, 'editor', 'session');
    expect(result.items.map((item) => item.state)).toEqual(['success', 'error']);
    expect(result.items[1].message).not.toContain('secret');
    sync.mockResolvedValue({ 人工复核结果: '人工复核无问题', 复核责任人: [{ id: 'user123', name: '责任人' }] });
    service.retry(task.id, 'editor', 'session');
    await service.processReady();
    result = service.status(task.id, 'editor', 'session');
    expect(result.items.every((item) => item.state === 'success')).toBe(true);
    expect(sync.mock.calls.filter(([id]) => id === 'recA')).toHaveLength(1);
  });
  it('rejects a person outside the active local directory', async () => {
    await expect(service.submit({ ...request, responsibleRecordId: 'recUnknown' }, 'editor', 'session')).rejects.toThrow('在职');
  });
  it('carries the normalized custom reply through the worker and public review', async () => {
    sync.mockResolvedValue({ 人工复核结果: '自定义回复', 复核回复: '等待备件', 复核责任人: [{ id: 'user123', name: '责任人' }] });
    const task = await service.submit({ ...request, recordIds: ['recA'], outcome: '自定义回复', customReply: ' 等待备件 ' }, 'editor', 'session');
    await service.processReady();
    expect(sync).toHaveBeenCalledWith('recA', '自定义回复', 'user123', 'unreviewed', '等待备件');
    expect(service.status(task.id, 'editor', 'session').items[0].review?.customReply).toBe('等待备件');
  });
});
