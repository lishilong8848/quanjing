jest.mock('../../common/feishu/bitable-direct-read', () => ({
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
}));
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
} from '../../common/feishu/bitable-direct-read';
import { MeetingSourcesService } from './meeting.sources.service';
import { MeetingService } from './meeting.service';
import type { HttpService } from '@nestjs/axios';
const http = {} as HttpService;
const training = { record_id: 'recSame', fields: { 分享主题: '培训甲' } };
const ali = {
  record_id: 'recSame',
  fields: { 会议名称: '会议甲', 会议属性: '属地' },
};
const weekly = {
  record_id: 'recSame',
  fields: { 第几周: '周报甲', 日期: '2026-10-07', 阿里会议待办: '周报待办' },
};
describe('多来源独立缓存和周报隔离', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest
      .mocked(readLatestPersistedBitableRecordSnapshot)
      .mockResolvedValue(null);
    jest
      .mocked(fetchBitableRecords)
      .mockImplementation(async (_, options) =>
        options.tableId === 'tblsWOglzcniGFwu'
          ? [training]
          : options.tableId === 'tblssaUZfDuqW5PQ'
            ? [ali]
            : [weekly],
      );
  });
  it('合并并发首次读取、跨表同ID全部保留，详情与周报读取不重拉', async () => {
    const sources = new MeetingSourcesService(http);
    const service = new MeetingService(http, sources);
    const [a, b] = await Promise.all([service.snapshot(), service.snapshot()]);
    expect(a.snapshotId).toBe(b.snapshotId);
    expect(a.records.map((r) => r.id)).toEqual([
      'recSame',
      'training:recSame',
      'ali-meeting:recSame',
    ]);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(3);
    expect((await service.weeklySnapshot()).records).toHaveLength(1);
    expect((await service.detail('ali-meeting:recSame')).meeting.title).toBe(
      '会议甲',
    );
    expect((await service.detail('recSame')).meeting.title).toBe('周报甲');
    expect(fetchBitableRecords).toHaveBeenCalledTimes(3);
  });
  it('单表首次失败不伪造0，也不阻断其他表，刷新可恢复', async () => {
    const sources = new MeetingSourcesService(http);
    jest
      .mocked(fetchBitableRecords)
      .mockRejectedValueOnce(new Error('offline'));
    const first = await sources.load();
    expect(first.states[0]).toMatchObject({ count: null, state: 'error' });
    expect(first.meetings).toHaveLength(1);
    await expect(sources.detail('training:recSame')).rejects.toThrow(
      '读取失败',
    );
    expect(
      (await sources.load(true)).states.every((s) => s.state === 'ready'),
    ).toBe(true);
  });
  it('刷新失败保留旧表，未知ID不落到另一个来源', async () => {
    const sources = new MeetingSourcesService(http);
    const before = await sources.load();
    jest.mocked(fetchBitableRecords).mockRejectedValue(new Error('offline'));
    const after = await sources.load(true);
    expect(after.meetings).toEqual(before.meetings);
    expect(after.states.every((s) => s.message?.includes('上次数据'))).toBe(
      true,
    );
    await expect(sources.detail('training:recMissing')).rejects.toThrow();
  });
  it('属地表失败仍可查看培训和阿里', async () => {
    jest.mocked(fetchBitableRecords).mockImplementation(async (_, options) => {
      if (options.tableId === 'tbl9GlPjdwTHIKSp') throw new Error('offline');
      return options.tableId === 'tblsWOglzcniGFwu' ? [training] : [ali];
    });
    const snapshot = await new MeetingService(
      http,
      new MeetingSourcesService(http),
    ).snapshot();
    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.sources?.[0]).toMatchObject({
      count: null,
      state: 'error',
    });
    expect(snapshot.latestActions).toBeNull();
  });
});
