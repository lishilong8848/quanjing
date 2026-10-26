jest.mock('../../common/feishu/bitable-direct-read', () => ({
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
}));
import { MeetingService } from './meeting.service';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
} from '../../common/feishu/bitable-direct-read';
import type { HttpService } from '@nestjs/axios';

const records = [
  {
    record_id: 'recA',
    fields: {
      第几周: '2026年第10周-运维周报',
      日期: 1772640000000,
      运营线: '运营内容',
    },
  },
];
describe('会议归档只读缓存', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(fetchBitableRecords).mockResolvedValue(records);
    jest
      .mocked(readLatestPersistedBitableRecordSnapshot)
      .mockResolvedValue(null);
  });
  const create = () => new MeetingService({} as HttpService);
  it('合并首次并发读取，详情复用同一快照', async () => {
    const service = create();
    const [a, b] = await Promise.all([service.snapshot(), service.snapshot()]);
    expect(a.snapshotId).toBe(b.snapshotId);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    expect((await service.detail('recA')).meeting.sections[0].content).toBe(
      '运营内容',
    );
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
  });
  it('首次读取失败返回错误，不能伪造零条', async () => {
    jest.mocked(fetchBitableRecords).mockRejectedValue(new Error('offline'));
    await expect(create().snapshot()).rejects.toThrow('会议归档暂时不可用');
  });
  it('刷新失败保留旧快照并明确更新失败', async () => {
    const service = create();
    const before = await service.snapshot();
    jest.mocked(fetchBitableRecords).mockRejectedValue(new Error('offline'));
    const after = await service.snapshot(true);
    expect(after.records).toEqual(before.records);
    expect(after.snapshotId).toBe(before.snapshotId);
    expect(after.syncState).toBe('error');
    expect(after.message).toContain('刷新失败');
  });
  it('过期持久快照立即可读，慢刷新不阻塞', async () => {
    jest
      .mocked(readLatestPersistedBitableRecordSnapshot)
      .mockResolvedValue({
        records,
        fetchedAt: Date.now() - 600000,
        expiresAt: 0,
      });
    jest
      .mocked(fetchBitableRecords)
      .mockImplementation(() => new Promise(() => {}));
    const result = await create().snapshot();
    expect(result.records).toHaveLength(1);
    expect(result.syncState).toBe('refreshing');
  });
  it('未知记录返回404，不返回其他记录', async () => {
    await expect(create().detail('recMissing')).rejects.toThrow(
      '未找到该会议记录',
    );
  });
  it('20秒后从后台更新新增周报，旧列表立即可用', async () => {
    const service=create();
    await service.snapshot();
    const cache=(service as unknown as {cache:{expiresAt:number}}).cache;
    cache.expiresAt=Date.now()-1;
    jest.mocked(fetchBitableRecords).mockResolvedValue([...records,{record_id:'recNew',fields:{日期:'2026-10-14'}}]);
    const stale=await service.snapshot();
    expect(stale.records).toHaveLength(1);
    expect(stale.syncState).toBe('refreshing');
    await new Promise(resolve=>setImmediate(resolve));
    expect((await service.snapshot()).records).toHaveLength(2);
    expect(fetchBitableRecords).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({cacheTtlMs:20000,forceRefresh:true}));
  });
});
