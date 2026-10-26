jest.mock('@server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('@server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  getTenantAccessToken: jest.fn(),
}));
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  fetchBitableRecords,
  getTenantAccessToken,
} from '../../server/common/feishu/bitable-direct-read';
import { AttendanceAutomationFeishuGateway } from '../../server/modules/duty-schedule/attendance-automation-feishu.gateway';
import { attendanceBusinessKey } from '../../server/modules/duty-schedule/attendance-archive-reconciliation';

describe('attendance duplicate recovery through the real gateway', () => {
  let dir: string;
  let oldDir: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attendance-dedup-fixture-'));
    oldDir = process.env.ATTENDANCE_AUTOMATION_STATE_DIR;
    process.env.ATTENDANCE_AUTOMATION_STATE_DIR = dir;
  });
  afterEach(() => {
    if (oldDir === undefined)
      delete process.env.ATTENDANCE_AUTOMATION_STATE_DIR;
    else process.env.ATTENDANCE_AUTOMATION_STATE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
    jest.resetAllMocks();
  });

  const fields = (status: string) => ({
    记录唯一键: `legacy-${status}`,
    记录类型: '考勤结果',
    钉钉员工ID: 'test-user',
    姓名: '测试员工',
    工作日期: Date.parse('2026-09-07T00:00:00+08:00'),
    打卡类型: '下班',
    应打卡时间: Date.parse('2026-09-07T18:00:00+08:00'),
    ...(status === '正常'
      ? { 实际打卡时间: Date.parse('2026-09-07T18:06:00+08:00') }
      : {}),
    时间状态: status,
    是否合法: status === '正常' ? '是' : '否',
    原始记录JSON: JSON.stringify({
      expectationKey: '2026-09-07:building_h:white:OffDuty:测试员工',
    }),
  });
  const input = {
    businessDate: '2026-09-07',
    users: [{ userId: 'test-user', name: '测试员工' }],
    details: [],
    results: [
      {
        id: 'new-id',
        userId: 'test-user',
        checkType: 'OffDuty',
        baseCheckTime: Date.parse('2026-09-07T18:00:00+08:00'),
        userCheckTime: null,
        workDate: Date.parse('2026-09-07T00:00:00+08:00'),
        timeResult: 'NotSigned',
        locationResult: null,
        approveId: null,
        procInstId: null,
        sourceType: null,
        original: {},
      },
    ],
  };

  function fixture(
    mode: 'ok' | 'bad-readback' | 'partial-delete' | 'stale-last' = 'ok',
  ) {
    const records: Array<[string, Record<string, unknown>]> = [
      ['rec-one', fields('未打卡')],
      ['rec-two', fields('正常')],
    ];
    if (mode === 'stale-last') {
      const canonicalKey = attendanceBusinessKey(records[1][1])!;
      records.forEach(([, value]) => {
        value.记录唯一键 = canonicalKey;
      });
    }
    const table = new Map<string, Record<string, unknown>>(
      mode === 'stale-last' ? records.reverse() : records,
    );
    jest
      .mocked(fetchBitableRecords)
      .mockImplementation(async () =>
        [...table].map(([record_id, fields]) => ({ record_id, fields })),
      );
    jest.mocked(getTenantAccessToken).mockResolvedValue('test-only-token');
    const post = jest.fn(async (url: string, body: any) => {
      if (url.endsWith('/batch_update'))
        for (const item of body.records)
          table.set(item.record_id, {
            ...item.fields,
            ...(mode === 'bad-readback' ? { 时间状态: '未打卡' } : {}),
          });
      if (url.endsWith('/batch_create')) throw new Error('must reuse keeper');
      if (url.endsWith('/batch_delete')) {
        expect(
          readdirSync(join(dir, 'attendance-dedup-backups')).length,
        ).toBeGreaterThan(0);
        if (mode !== 'partial-delete')
          body.records.forEach((id: string) => table.delete(id));
        return {
          data: {
            code: 0,
            data: {
              records: body.records.map((id: string) => ({
                record_id: id,
                deleted: mode !== 'partial-delete',
              })),
            },
          },
        };
      }
      return { data: { code: 0 } };
    });
    return {
      table,
      post,
      gateway: new AttendanceAutomationFeishuGateway({
        axiosRef: { post },
      } as never),
    };
  }

  it('backs up both originals, verifies the signed keeper, removes only its duplicate and is repeatable', async () => {
    const { gateway, table, post } = fixture();
    await gateway.archiveAttendance(input as never);
    expect(table.size).toBe(1);
    expect([...table.values()][0].时间状态).toBe('正常');
    const name = readdirSync(join(dir, 'attendance-dedup-backups'))[0];
    expect(
      JSON.parse(
        readFileSync(join(dir, 'attendance-dedup-backups', name), 'utf8'),
      ).originals,
    ).toHaveLength(2);
    await gateway.archiveAttendance(input as never);
    expect(table.size).toBe(1);
    expect(
      post.mock.calls.filter(([url]) => url.endsWith('/batch_delete')),
    ).toHaveLength(1);
    expect(readdirSync(dir)).not.toContain('attendance-archive-write.lock');
  });

  it('serializes concurrent archive requests instead of reporting the active write as a failure', async () => {
    const { gateway, table } = fixture();
    const fetch = jest.mocked(fetchBitableRecords);
    const originalFetch = fetch.getMockImplementation()!;
    let releaseFirstFetch!: () => void;
    let firstFetchStarted!: () => void;
    const paused = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstFetchStarted = resolve;
    });
    let fetchCount = 0;
    fetch.mockImplementation(async (...args) => {
      if (++fetchCount === 1) {
        firstFetchStarted();
        await paused;
      }
      return originalFetch(...args);
    });

    const first = gateway.archiveAttendance(input as never);
    await started;
    const second = gateway.archiveAttendance(input as never);
    releaseFirstFetch();
    const results = await Promise.allSettled([first, second]);

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    expect(table.size).toBe(1);
    expect(readdirSync(dir)).not.toContain('attendance-archive-write.lock');
  });

  it('never deletes when readback does not match the intended attendance truth', async () => {
    const { gateway, post } = fixture('bad-readback');
    await expect(gateway.archiveAttendance(input as never)).rejects.toThrow(
      '语义回读失败',
    );
    expect(post.mock.calls.some(([url]) => url.endsWith('/batch_delete'))).toBe(
      false,
    );
  });

  it('verifies the updated keeper rather than a stale duplicate returned last', async () => {
    const { gateway, table } = fixture('stale-last');
    await gateway.archiveAttendance(input as never);
    expect(table.size).toBe(1);
    expect([...table.keys()]).toEqual(['rec-two']);
  });

  it('does not claim success when Feishu only partially acknowledges deletion', async () => {
    const { gateway } = fixture('partial-delete');
    await expect(gateway.archiveAttendance(input as never)).rejects.toThrow(
      '删除未全部确认',
    );
    expect(readdirSync(join(dir, 'attendance-dedup-backups'))).toHaveLength(1);
  });
});
