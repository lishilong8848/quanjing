import type { HttpService } from '@nestjs/axios';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DingTalkAttendanceClient } from '../../server/modules/duty-schedule/dingtalk-attendance.client';

describe('DingTalkAttendanceClient', () => {
  const originalEnv = process.env;
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'dingtalk-directory-cache-'));
    process.env = {
      ...originalEnv,
      DINGTALK_ATTENDANCE_CLIENT_ID: 'test-client-id',
      DINGTALK_ATTENDANCE_CLIENT_SECRET: 'test-client-secret',
      ATTENDANCE_AUTOMATION_STATE_DIR: stateDir,
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = originalEnv;
    rmSync(stateDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it.each([
    ['2026-09-24T14:20:00.000Z', 70, 'night after 18:35'],
    ['2026-09-30T15:20:00.000Z', 70, 'September last day'],
    ['2026-10-01T15:20:00.000Z', 150, 'October first day'],
  ])('uses the %s Shanghai daily combined ceiling (%s)', async (instant, limit) => {
    jest.useFakeTimers().setSystemTime(new Date(instant));
    delete process.env.DINGTALK_ATTENDANCE_API_DAILY_LIMIT;
    delete process.env.DINGTALK_CORRECTION_API_DAILY_LIMIT;
    const budgetPath = join(stateDir, 'dingtalk-attendance-api-budget.json');
    writeFileSync(budgetPath, JSON.stringify({
      version: 1,
      date: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date()),
      attendanceCalls: 35,
      correctionCalls: limit - 36,
      updatedAt: new Date().toISOString(),
    }), 'utf8');
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken'))
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      if (url.includes('/processinstance/listids'))
        return { data: { errcode: 0, result: { list: [] } } };
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({ axiosRef: { post } } as unknown as HttpService);
    const query = { start: '2026-09-24 00:00:00', end: '2026-09-24 23:59:59' };
    await expect(client.listCorrectionApprovals(query)).resolves.toEqual([]);
    await expect(client.listCorrectionApprovals(query)).rejects.toThrow(`上限 ${limit}`);
    expect(post.mock.calls.filter(([url]) => url.includes('/processinstance/listids'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(budgetPath, 'utf8'))).toMatchObject({
      attendanceCalls: 35, correctionCalls: limit - 35,
    });
  });

  it('walks DingTalk departments and user pages without exposing credentials in URLs', async () => {
    const post = jest.fn(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/department/listsub')) {
        return {
          data: {
            errcode: 0,
            result: body.dept_id === 1 ? [{ dept_id: 2 }, { dept_id: -7 }] : [],
          },
        };
      }
      if (url.includes('/user/list')) {
        return {
          data: {
            errcode: 0,
            result: {
              list:
                body.dept_id === 1
                  ? [{ userid: 'u1', name: '示例人员008' }]
                  : [{ userid: 'u2', name: '示例人员013' }],
              has_more: false,
            },
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(client.listAllUsers()).resolves.toEqual([
      { userId: 'u1', name: '示例人员008' },
      { userId: 'u2', name: '示例人员013' },
    ]);
    expect(post.mock.calls.every(([url]) => !url.includes('test-client'))).toBe(
      true,
    );
  });

  it('reuses the persisted directory cache across client instances', async () => {
    const firstPost = jest.fn(
      async (url: string, body: Record<string, unknown>) => {
        if (url.endsWith('/v1.0/oauth2/accessToken')) {
          return { data: { accessToken: 'access-token', expireIn: 7200 } };
        }
        if (url.includes('/department/listsub')) {
          return { data: { errcode: 0, result: [] } };
        }
        if (url.includes('/user/list')) {
          expect(body.dept_id).toBe(1);
          return {
            data: {
              errcode: 0,
              result: {
                list: [{ userid: 'u1', name: '示例人员008' }],
                has_more: false,
              },
            },
          };
        }
        throw new Error(`unexpected url: ${url}`);
      },
    );
    const firstClient = new DingTalkAttendanceClient({
      axiosRef: { post: firstPost },
    } as unknown as HttpService);
    await expect(firstClient.listAllUsers()).resolves.toEqual([
      { userId: 'u1', name: '示例人员008' },
    ]);

    const secondPost = jest.fn(() => {
      throw new Error('the warm directory cache must avoid all HTTP requests');
    });
    const secondClient = new DingTalkAttendanceClient({
      axiosRef: { post: secondPost },
    } as unknown as HttpService);

    await expect(secondClient.listAllUsers()).resolves.toEqual([
      { userId: 'u1', name: '示例人员008' },
    ]);
    expect(secondPost).not.toHaveBeenCalled();
  });

  it('invalidates the persisted directory cache after the client ID changes', async () => {
    const buildPost = (userId: string, name: string) =>
      jest.fn(async (url: string) => {
        if (url.endsWith('/v1.0/oauth2/accessToken')) {
          return { data: { accessToken: `token-${userId}`, expireIn: 7200 } };
        }
        if (url.includes('/department/listsub')) {
          return { data: { errcode: 0, result: [] } };
        }
        if (url.includes('/user/list')) {
          return {
            data: {
              errcode: 0,
              result: {
                list: [{ userid: userId, name }],
                has_more: false,
              },
            },
          };
        }
        throw new Error(`unexpected url: ${url}`);
      });

    const firstPost = buildPost('u1', '示例人员008');
    const firstClient = new DingTalkAttendanceClient({
      axiosRef: { post: firstPost },
    } as unknown as HttpService);
    await firstClient.listAllUsers();

    process.env.DINGTALK_ATTENDANCE_CLIENT_ID = 'replacement-client-id';
    const secondPost = buildPost('u2', '示例人员013');
    const secondClient = new DingTalkAttendanceClient({
      axiosRef: { post: secondPost },
    } as unknown as HttpService);

    await expect(secondClient.listAllUsers()).resolves.toEqual([
      { userId: 'u2', name: '示例人员013' },
    ]);
    expect(
      secondPost.mock.calls.some(([url]) => url.includes('/user/list')),
    ).toBe(true);
  });

  it('paginates attendance results in DingTalk batches', async () => {
    const post = jest.fn(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/attendance/list')) {
        const offset = Number(body.offset || 0);
        return {
          data: {
            errcode: 0,
            recordresult: offset === 0 ? [{ id: 1, userid: 'u1' }] : [],
            hasMore: offset === 0,
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    const result = await client.listAttendanceResults({
      start: '2026-08-30 00:00:00',
      end: '2026-08-30 23:59:59',
      userIds: ['u1'],
    });

    expect(result).toHaveLength(1);
    expect(
      post.mock.calls.filter(([url]) => url.includes('/attendance/list')),
    ).toHaveLength(2);
  });

  it('stops result pagination when DingTalk repeats a page', async () => {
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/attendance/list')) {
        return {
          data: {
            errcode: 0,
            recordresult: [{ id: 1, userid: 'u1' }],
            hasMore: true,
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      client.listAttendanceResults({
        start: '2026-08-30 00:00:00',
        end: '2026-08-30 23:59:59',
        userIds: ['u1'],
      }),
    ).rejects.toThrow('检测到重复页');
    expect(
      post.mock.calls.filter(([url]) => url.includes('/attendance/list')),
    ).toHaveLength(2);
  });

  it('stops abnormal result pagination after four pages per 50-person batch', async () => {
    let page = 0;
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/attendance/list')) {
        page += 1;
        return {
          data: {
            errcode: 0,
            recordresult: [{ id: page, userid: 'u1' }],
            hasMore: true,
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      client.listAttendanceResults({
        start: '2026-08-30 00:00:00',
        end: '2026-08-30 23:59:59',
        userIds: ['u1'],
      }),
    ).rejects.toThrow('分页超过安全上限');
    expect(
      post.mock.calls.filter(([url]) => url.includes('/attendance/list')),
    ).toHaveLength(4);
  });

  it('persists and enforces the daily attendance API hard limit', async () => {
    process.env.DINGTALK_ATTENDANCE_API_DAILY_LIMIT = '2';
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/attendance/listRecord')) {
        return { data: { errcode: 0, recordresult: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      client.listAttendanceDetails({
        start: '2026-08-30 00:00:00',
        end: '2026-08-30 23:59:59',
        userIds: ['u1', 'u2'],
      }),
    ).resolves.toEqual([]);
    await expect(
      client.listAttendanceDetails({
        start: '2026-08-30 00:00:00',
        end: '2026-08-30 23:59:59',
        userIds: ['u1'],
      }),
    ).resolves.toEqual([]);
    await expect(
      client.listAttendanceDetails({
        start: '2026-08-30 00:00:00',
        end: '2026-08-30 23:59:59',
        userIds: ['u1'],
      }),
    ).rejects.toThrow('已达到当日调用上限 2');
    expect(
      post.mock.calls.filter(([url]) => url.includes('/attendance/listRecord')),
    ).toHaveLength(2);
    expect(
      JSON.parse(
        readFileSync(
          join(stateDir, 'dingtalk-attendance-api-budget.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ attendanceCalls: 2, correctionCalls: 0 });
  });

  it('reserves the last eight daily calls for the 18:35 attendance check', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T09:00:00.000Z'));
    process.env.DINGTALK_ATTENDANCE_API_DAILY_LIMIT = '999';
    writeFileSync(
      join(stateDir, 'dingtalk-attendance-api-budget.json'),
      JSON.stringify({
        version: 1,
        date: new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date()),
        attendanceCalls: 50,
        correctionCalls: 12,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/attendance/listRecord')) {
        return { data: { errcode: 0, recordresult: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    const query = {
      start: '2026-08-30 00:00:00',
      end: '2026-08-30 23:59:59',
      userIds: ['u1'],
    };
    await expect(client.listAttendanceDetails(query)).rejects.toThrow('预留');
    await expect(
      client.listAttendanceDetails(query, { budgetPriority: 'evening-final' }),
    ).resolves.toEqual([]);
    expect(
      post.mock.calls.filter(([url]) => url.includes('/attendance/listRecord')),
    ).toHaveLength(1);
    expect(
      JSON.parse(
        readFileSync(
          join(stateDir, 'dingtalk-attendance-api-budget.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ attendanceCalls: 51, correctionCalls: 12 });
  });

  it('keeps all five scheduled pulls within 40 calls for 200 users and no new approvals', async () => {
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (
        url.includes('/attendance/list') ||
        url.includes('/attendance/listRecord')
      ) {
        return { data: { errcode: 0, recordresult: [], hasMore: false } };
      }
      if (url.includes('/processinstance/listids')) {
        return { data: { errcode: 0, result: { list: [] } } };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);
    const attendanceQuery = {
      start: '2026-09-15 00:00:00',
      end: '2026-09-15 23:59:59',
      userIds: Array.from({ length: 200 }, (_, index) => `user-${index}`),
    };
    const correctionQuery = {
      start: '2026-09-15 00:00:00',
      end: '2026-09-15 23:59:59',
    };

    await client.listAttendanceResults(attendanceQuery);
    await client.listAttendanceDetails(attendanceQuery);
    await client.listCorrectionApprovals(correctionQuery);
    for (let index = 0; index < 3; index += 1) {
      await client.listAttendanceDetails(attendanceQuery);
      await client.listCorrectionApprovals(correctionQuery);
    }
    await client.listAttendanceDetails(attendanceQuery, {
      budgetPriority: 'evening-final',
    });
    await client.listCorrectionApprovals(correctionQuery);

    expect(
      JSON.parse(
        readFileSync(
          join(stateDir, 'dingtalk-attendance-api-budget.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ attendanceCalls: 24, correctionCalls: 5 });
    expect(
      post.mock.calls.filter(([url]) => url.includes('/attendance/list')),
    ).toHaveLength(24);
    expect(
      post.mock.calls.filter(([url]) =>
        url.includes('/processinstance/listids'),
      ),
    ).toHaveLength(5);
  });

  it('allows correction calls through 30 but refuses the 31st', async () => {
    process.env.DINGTALK_CORRECTION_API_DAILY_LIMIT = '30';
    const budgetPath = join(stateDir, 'dingtalk-attendance-api-budget.json');
    writeFileSync(
      budgetPath,
      JSON.stringify({
        version: 1,
        date: new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date()),
        attendanceCalls: 0,
        correctionCalls: 20,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/processinstance/listids')) {
        return { data: { errcode: 0, result: { list: [] } } };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);
    const query = {
      start: '2026-08-28 00:00:00',
      end: '2026-08-28 23:59:59',
    };

    for (let index = 0; index < 10; index += 1) {
      await expect(client.listCorrectionApprovals(query)).resolves.toEqual([]);
    }
    await expect(client.listCorrectionApprovals(query)).rejects.toThrow(
      '已达到当日调用上限 30',
    );
    expect(
      post.mock.calls.filter(([url]) =>
        url.includes('/processinstance/listids'),
      ),
    ).toHaveLength(10);
    expect(JSON.parse(readFileSync(budgetPath, 'utf8'))).toMatchObject({
      attendanceCalls: 0,
      correctionCalls: 30,
    });
  });

  it('keeps the evening reserve before 18:35 with the new daily ceiling', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T09:00:00.000Z'));
    process.env.DINGTALK_CORRECTION_API_DAILY_LIMIT = '70';
    const budgetPath = join(stateDir, 'dingtalk-attendance-api-budget.json');
    writeFileSync(
      budgetPath,
      JSON.stringify({
        version: 1,
        date: new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date()),
        attendanceCalls: 0,
        correctionCalls: 60,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/processinstance/listids')) {
        return { data: { errcode: 0, result: { list: [] } } };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);
    const query = {
      start: '2026-08-28 00:00:00',
      end: '2026-08-28 23:59:59',
    };

    for (let index = 0; index < 2; index += 1) {
      await expect(client.listCorrectionApprovals(query)).resolves.toEqual([]);
    }
    await expect(client.listCorrectionApprovals(query)).rejects.toThrow('预留');
    expect(
      post.mock.calls.filter(([url]) =>
        url.includes('/processinstance/listids'),
      ),
    ).toHaveLength(2);
    expect(JSON.parse(readFileSync(budgetPath, 'utf8'))).toMatchObject({
      attendanceCalls: 0,
      correctionCalls: 62,
    });
  });

  it('refuses a correction query once attendance and correction calls total 70 in September', async () => {
    const budgetPath = join(stateDir, 'dingtalk-attendance-api-budget.json');
    writeFileSync(
      budgetPath,
      JSON.stringify({
        version: 1,
        date: new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date()),
        attendanceCalls: 35,
        correctionCalls: 35,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/processinstance/listids')) {
        return { data: { errcode: 0, result: { list: [] } } };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      client.listCorrectionApprovals({
        start: '2026-09-08 00:00:00',
        end: '2026-09-08 23:59:59',
      }),
    ).rejects.toThrow('70');
    expect(
      post.mock.calls.filter(([url]) =>
        url.includes('/processinstance/listids'),
      ),
    ).toHaveLength(0);
  });

  it('fails closed before HTTP when the daily API budget ledger is invalid', async () => {
    writeFileSync(
      join(stateDir, 'dingtalk-attendance-api-budget.json'),
      JSON.stringify({
        version: 1,
        date: new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date()),
        attendanceCalls: -1,
        correctionCalls: 0,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/attendance/listRecord')) {
        return { data: { errcode: 0, recordresult: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      client.listAttendanceDetails({
        start: '2026-08-30 00:00:00',
        end: '2026-08-30 23:59:59',
        userIds: ['u1'],
      }),
    ).rejects.toThrow('预算台账损坏');
    expect(
      post.mock.calls.filter(([url]) => url.includes('/attendance/listRecord')),
    ).toHaveLength(0);
  });

  it('loads correction approvals and extracts the correction photo evidence', async () => {
    const correctionTime = Date.parse('2026-08-28T10:00:00.000Z');
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/processinstance/listids')) {
        return {
          data: {
            errcode: 0,
            result: { list: ['process-1'], next_cursor: 1 },
          },
        };
      }
      if (url.includes('/processinstance/get')) {
        return {
          data: {
            errcode: 0,
            process_instance: {
              process_instance_id: 'process-1',
              originator_userid: 'u1',
              status: 'COMPLETED',
              result: 'agree',
              form_component_values: [
                {
                  name: '补卡时间',
                  component_type: 'DDDateField',
                  value: '2026-08-28 18:00',
                  ext_value: JSON.stringify({
                    userCheckTime: correctionTime,
                    workDate: correctionTime,
                    planText: '周五下班(08.28 18:00) 缺卡',
                  }),
                },
                {
                  name: '补卡理由',
                  component_type: 'TextareaField',
                  value: '忘记打卡',
                },
                {
                  name: '图片',
                  component_type: 'DDPhotoField',
                  value: JSON.stringify([
                    'https://static.dingtalk.com/media/evidence.jpg',
                  ]),
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      client.listCorrectionApprovals({
        start: '2026-08-28 00:00:00',
        end: '2026-08-28 23:59:59',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        processInstanceId: 'process-1',
        userId: 'u1',
        status: 'COMPLETED',
        result: 'agree',
        correctionTime,
        reason: '忘记打卡',
        photoUrls: ['https://static.dingtalk.com/media/evidence.jpg'],
      }),
    ]);
  });

  it('loads only correction instances referenced by attendance results without scanning approval history', async () => {
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/processinstance/get')) {
        return {
          data: {
            errcode: 0,
            process_instance: {
              process_instance_id: 'process-1',
              originator_userid: 'u1',
              status: 'COMPLETED',
              result: 'agree',
              form_component_values: [
                {
                  name: 'repairCheckTime',
                  value: String(Date.parse('2026-09-08T10:00:00.000Z')),
                  ext_value: JSON.stringify({
                    userCheckTime: Date.parse('2026-09-08T10:00:00.000Z'),
                    workDate: Date.parse('2026-09-08T10:00:00.000Z'),
                  }),
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      client.getCorrectionApprovalsByInstanceIds([
        'process-1',
        'process-1',
        '',
      ]),
    ).resolves.toHaveLength(1);
    expect(
      post.mock.calls.filter(([url]) => url.includes('/processinstance/get')),
    ).toHaveLength(1);
    expect(
      post.mock.calls.some(([url]) => url.includes('/processinstance/listids')),
    ).toBe(false);
  });

  it('parses the real repairCheckTime form field even without a component type', async () => {
    const correctionTime = Date.parse('2026-09-08T10:00:00.000Z');
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/processinstance/get')) {
        return {
          data: {
            errcode: 0,
            process_instance: {
              process_instance_id: 'process-repair',
              originator_userid: 'u1',
              status: 'COMPLETED',
              result: 'agree',
              form_component_values: [
                {
                  name: 'repairCheckTime',
                  value: String(correctionTime),
                  ext_value: JSON.stringify({
                    timeStamp: correctionTime,
                    workDate: correctionTime,
                    planText: 'Off duty missing card',
                    userCheckTime: correctionTime,
                  }),
                },
                {
                  component_type: 'DDPhotoField',
                  value: JSON.stringify([
                    'https://static.dingtalk.com/media/evidence-1.jpg',
                    'https://static.dingtalk.com/media/evidence-2.jpg',
                  ]),
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      client.getCorrectionApprovalsByInstanceIds(['process-repair']),
    ).resolves.toEqual([
      expect.objectContaining({
        correctionTime,
        workDate: correctionTime,
        planText: 'Off duty missing card',
        photoUrls: [
          'https://static.dingtalk.com/media/evidence-1.jpg',
          'https://static.dingtalk.com/media/evidence-2.jpg',
        ],
      }),
    ]);
  });

  it('refuses a completed approval with no usable correction date', async () => {
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/processinstance/get')) {
        return {
          data: {
            errcode: 0,
            process_instance: {
              process_instance_id: 'process-no-date',
              originator_userid: 'u1',
              status: 'COMPLETED',
              result: 'agree',
              form_component_values: [],
            },
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      client.getCorrectionApprovalsByInstanceIds(['process-no-date']),
    ).rejects.toThrow('补卡时间');
  });

  it('reuses completed correction details across daily discovery runs', async () => {
    const correctionTime = Date.parse('2026-09-08T10:00:00.000Z');
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/processinstance/listids')) {
        return { data: { errcode: 0, result: { list: ['process-1'] } } };
      }
      if (url.includes('/processinstance/get')) {
        return {
          data: {
            errcode: 0,
            process_instance: {
              process_instance_id: 'process-1',
              originator_userid: 'u1',
              status: 'COMPLETED',
              result: 'agree',
              form_component_values: [
                {
                  name: 'repairCheckTime',
                  value: String(correctionTime),
                  ext_value: JSON.stringify({
                    userCheckTime: correctionTime,
                    workDate: correctionTime,
                  }),
                },
                {
                  component_type: 'DDPhotoField',
                  value: JSON.stringify([
                    'https://static.dingtalk.com/media/evidence.jpg',
                  ]),
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const http = { axiosRef: { post } } as unknown as HttpService;
    const query = {
      start: '2026-09-08 00:00:00',
      end: '2026-09-08 23:59:59',
    };

    const first = await new DingTalkAttendanceClient(
      http,
    ).listCorrectionApprovals(query);
    const second = await new DingTalkAttendanceClient(
      http,
    ).listCorrectionApprovals(query);

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(
      post.mock.calls.filter(([url]) =>
        url.includes('/processinstance/listids'),
      ),
    ).toHaveLength(2);
    expect(
      post.mock.calls.filter(([url]) => url.includes('/processinstance/get')),
    ).toHaveLength(1);
  });

  it('refetches a cached approved correction when its photo evidence is missing', async () => {
    const correctionTime = Date.parse('2026-09-08T10:00:00.000Z');
    writeFileSync(
      join(stateDir, 'dingtalk-attendance-correction-approval-cache.json'),
      `${JSON.stringify({
        version: 1,
        entries: {
          'process-stale': {
            capturedAt: new Date().toISOString(),
            instance: {
              process_instance_id: 'process-stale',
              originator_userid: 'u1',
              status: 'COMPLETED',
              result: 'agree',
              form_component_values: [
                {
                  name: 'repairCheckTime',
                  value: String(correctionTime),
                  ext_value: JSON.stringify({
                    userCheckTime: correctionTime,
                    workDate: correctionTime,
                  }),
                },
              ],
            },
          },
        },
      })}\n`,
      'utf8',
    );
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/processinstance/get')) {
        return {
          data: {
            errcode: 0,
            process_instance: {
              process_instance_id: 'process-stale',
              originator_userid: 'u1',
              status: 'COMPLETED',
              result: 'agree',
              form_component_values: [
                {
                  name: 'repairCheckTime',
                  value: String(correctionTime),
                  ext_value: JSON.stringify({
                    userCheckTime: correctionTime,
                    workDate: correctionTime,
                  }),
                },
                {
                  component_type: 'DDPhotoField',
                  value: JSON.stringify([
                    'https://static.dingtalk.com/media/recovered-evidence.jpg',
                  ]),
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const http = { axiosRef: { post } } as unknown as HttpService;

    const first = await new DingTalkAttendanceClient(
      http,
    ).getCorrectionApprovalsByInstanceIds(['process-stale']);
    const second = await new DingTalkAttendanceClient(
      http,
    ).getCorrectionApprovalsByInstanceIds(['process-stale']);

    expect(first[0]?.photoUrls).toEqual([
      'https://static.dingtalk.com/media/recovered-evidence.jpg',
    ]);
    expect(second).toEqual(first);
    expect(
      post.mock.calls.filter(([url]) => url.includes('/processinstance/get')),
    ).toHaveLength(1);
  });

  it('caches 20 terminal approval details and completes 21 on the next discovery', async () => {
    const ids = Array.from(
      { length: 21 },
      (_, index) => `process-${index + 1}`,
    );
    const correctionTime = Date.parse('2026-09-08T10:00:00.000Z');
    const post = jest.fn(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/processinstance/listids')) {
        return {
          data: {
            errcode: 0,
            result:
              body.cursor === 0
                ? { list: ids.slice(0, 20), next_cursor: 20 }
                : { list: ids.slice(20) },
          },
        };
      }
      if (url.includes('/processinstance/get')) {
        return {
          data: {
            errcode: 0,
            process_instance: {
              process_instance_id: body.process_instance_id,
              originator_userid: 'u1',
              status: 'COMPLETED',
              result: 'agree',
              form_component_values: [
                {
                  name: 'repairCheckTime',
                  value: String(correctionTime),
                  ext_value: JSON.stringify({
                    userCheckTime: correctionTime,
                    workDate: correctionTime,
                  }),
                },
                {
                  component_type: 'DDPhotoField',
                  value: JSON.stringify([
                    `https://static.dingtalk.com/media/${body.process_instance_id}.jpg`,
                  ]),
                },
              ],
            },
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const http = { axiosRef: { post } } as unknown as HttpService;
    const query = {
      start: '2026-09-01 00:00:00',
      end: '2026-09-14 23:59:59',
    };
    const cachePath = join(
      stateDir,
      'dingtalk-attendance-correction-approval-cache.json',
    );

    await expect(
      new DingTalkAttendanceClient(http).listCorrectionApprovals(query),
    ).rejects.toThrow('剩余 1 条');
    expect(
      post.mock.calls.filter(([url]) => url.includes('/processinstance/get')),
    ).toHaveLength(20);
    expect(
      Object.keys(JSON.parse(readFileSync(cachePath, 'utf8')).entries),
    ).toHaveLength(20);

    await expect(
      new DingTalkAttendanceClient(http).listCorrectionApprovals(query),
    ).resolves.toEqual(
      ids.map((processInstanceId) =>
        expect.objectContaining({ processInstanceId }),
      ),
    );
    expect(
      post.mock.calls.filter(([url]) => url.includes('/processinstance/get')),
    ).toHaveLength(21);
    expect(
      Object.keys(JSON.parse(readFileSync(cachePath, 'utf8')).entries),
    ).toHaveLength(21);
    expect(
      JSON.parse(
        readFileSync(
          join(stateDir, 'dingtalk-attendance-api-budget.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ attendanceCalls: 0, correctionCalls: 25 });
  });

  it('accepts more than 20 discovered approvals when terminal details are already cached', async () => {
    const correctionTime = Date.parse('2026-09-08T10:00:00.000Z');
    const ids = Array.from(
      { length: 21 },
      (_, index) => `cached-process-${index + 1}`,
    );
    writeFileSync(
      join(stateDir, 'dingtalk-attendance-correction-approval-cache.json'),
      JSON.stringify({
        version: 1,
        entries: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              capturedAt: new Date().toISOString(),
              instance: {
                process_instance_id: id,
                originator_userid: 'u1',
                status: 'COMPLETED',
                result: 'agree',
                form_component_values: [
                  {
                    name: 'repairCheckTime',
                    value: String(correctionTime),
                    ext_value: JSON.stringify({
                      userCheckTime: correctionTime,
                      workDate: correctionTime,
                    }),
                  },
                  {
                    component_type: 'DDPhotoField',
                    value: JSON.stringify([
                      `https://static.dingtalk.com/media/${id}.jpg`,
                    ]),
                  },
                ],
              },
            },
          ]),
        ),
      }),
      'utf8',
    );
    const post = jest.fn();
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      client.getCorrectionApprovalsByInstanceIds(ids),
    ).resolves.toHaveLength(21);
    expect(post).not.toHaveBeenCalled();
  });

  it('fails closed when a full correction ID page has no usable next cursor', async () => {
    const post = jest.fn(async (url: string) => {
      if (url.endsWith('/v1.0/oauth2/accessToken')) {
        return { data: { accessToken: 'access-token', expireIn: 7200 } };
      }
      if (url.includes('/processinstance/listids')) {
        return {
          data: {
            errcode: 0,
            result: {
              list: Array.from(
                { length: 20 },
                (_, index) => `process-${index}`,
              ),
            },
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const client = new DingTalkAttendanceClient({
      axiosRef: { post },
    } as unknown as HttpService);

    await expect(
      client.listCorrectionApprovals({
        start: '2026-09-01 00:00:00',
        end: '2026-09-16 23:59:59',
      }),
    ).rejects.toThrow('分页游标');
    expect(
      post.mock.calls.filter(([url]) => url.includes('/processinstance/get')),
    ).toHaveLength(0);
  });
});
