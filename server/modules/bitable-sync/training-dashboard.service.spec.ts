jest.mock('../../common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn(),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecords: jest.fn(),
}));

jest.mock('./training-dashboard.snapshot-store', () => ({
  readTrainingDashboardSourceSnapshot: jest.fn(),
  writeTrainingDashboardSourceSnapshot: jest.fn(),
}));

import {
  type BitableRecordItem,
  type FetchBitableRecordsOptions,
  fetchBitableRecords,
  readLatestPersistedBitableRecords,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import {
  DEFAULT_TRAINING_WIKI_TOKEN,
  TRAINING_DASHBOARD_TABLE_CONFIGS,
  TRAINING_TABLE_CONFIGS,
  getTrainingTableId,
  type TrainingSourceKey,
} from './training-dashboard.fields';
import { TrainingDashboardService } from './training-dashboard.service';
import {
  readTrainingDashboardSourceSnapshot,
  writeTrainingDashboardSourceSnapshot,
} from './training-dashboard.snapshot-store';

const STALE_ERROR_MESSAGE = '源数据同步失败，已展示上次成功结果';
const ENV_KEYS = [
  'FEISHU_TRAINING_APP_TOKEN',
  'FEISHU_TRAINING_WIKI_TOKEN',
  'FEISHU_TRAINING_PASS_SCORE',
  ...TRAINING_TABLE_CONFIGS.map(({ envKey }) => envKey),
];

type TrainingSourcesFixture = Record<TrainingSourceKey, BitableRecordItem[]>;

function sourceRecord(
  key: TrainingSourceKey,
  fields: Record<string, unknown>,
): BitableRecordItem {
  return {
    record_id: `rec-${key}`,
    fields,
    last_modified_time: Date.parse('2026-07-18T00:00:00.000Z'),
  };
}

function validSources(): TrainingSourcesFixture {
  return {
    activeStats: [
      sourceRecord('activeStats', {
        年份: '2026',
        月份: '07',
        楼栋: 'A楼',
        本月培训课程数量: 1,
      }),
    ],
    activeScores: [
      sourceRecord('activeScores', {
        员工: [{ id: 'ou-active', name: '在岗员工' }],
        楼栋: 'A楼',
        月份: '07',
        '月份（计划）': '2026-07',
      }),
    ],
    activePlans: [
      sourceRecord('activePlans', {
        培训课程名称: '安全培训',
        培训年份: '2026',
        培训月份: '07',
        '楼栋/专业': 'A楼',
      }),
    ],
    newHireScores: [
      sourceRecord('newHireScores', {
        人员: [{ id: 'ou-new', name: '新员工' }],
        入职日期: '2026-07-01',
      }),
    ],
    newHireCourses: [
      sourceRecord('newHireCourses', {
        培训课程名称: '消防系统',
        课程大类: '专业课',
      }),
    ],
    newHirePlans: [
      sourceRecord('newHirePlans', {
        学员: [{ id: 'ou-new', name: '新员工' }],
        培训课程: '消防系统',
        流程状态: '已通过',
      }),
    ],
    sharingSessions: [
      sourceRecord('sharingSessions', {
        分享主题: '七月分享',
        分享类型: '技术交流',
        '会议进度（勿动）': '已结束',
        开始时间: '2026-07-10T09:00:00+08:00',
        结束时间: '2026-07-10T10:00:00+08:00',
        月度: '07',
      }),
    ],
    sharingScores: [
      sourceRecord('sharingScores', {
        评分员: [{ id: 'ou-rater', name: '评分员' }],
        评分: 8,
        主题名: '七月分享',
      }),
    ],
    sharingInterests: [],
  };
}

function configForTableId(tableId: string) {
  const config = TRAINING_TABLE_CONFIGS.find(
    (item) => getTrainingTableId(item) === tableId,
  );
  if (!config) throw new Error(`Unknown training table: ${tableId}`);
  return config;
}

function installLiveSources(sources = validSources()): void {
  jest
    .mocked(fetchBitableRecords)
    .mockImplementation(
      async (_httpService, options: FetchBitableRecordsOptions) => {
        const config = configForTableId(options.tableId);
        const records = sources[config.key];
        options.validateRecords?.(records);
        return records;
      },
    );
}

function installStoredSources(sources = validSources()): void {
  jest.mocked(readTrainingDashboardSourceSnapshot).mockResolvedValue(sources);
}

describe('TrainingDashboardService', () => {
  const originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    jest.clearAllMocks();
    ENV_KEYS.forEach((key) => delete process.env[key]);
    jest
      .mocked(resolveBitableAppToken)
      .mockResolvedValue('resolved-training-app-token');
    jest.mocked(readLatestPersistedBitableRecords).mockResolvedValue(null);
    jest.mocked(readTrainingDashboardSourceSnapshot).mockResolvedValue(null);
    jest.mocked(writeTrainingDashboardSourceSnapshot).mockResolvedValue();
    installLiveSources();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('strictly reads only the seven visible-dashboard tables and caches both latest and resolved-month keys', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T03:00:00.000Z'));

    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);

    const first = await service.getDashboard(undefined, true);
    const cachedLatest = await service.getDashboard(undefined, false);
    const cachedResolvedMonth = await service.getDashboard('2026-07', false);

    expect(resolveBitableAppToken).toHaveBeenCalledTimes(1);
    expect(resolveBitableAppToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ wikiToken: DEFAULT_TRAINING_WIKI_TOKEN }),
    );
    expect(fetchBitableRecords).toHaveBeenCalledTimes(7);
    for (const config of TRAINING_DASHBOARD_TABLE_CONFIGS) {
      const matchingCall = jest
        .mocked(fetchBitableRecords)
        .mock.calls.find(
          ([, options]) => options.tableId === config.defaultTableId,
        );
      expect(matchingCall).toBeDefined();
      expect(matchingCall?.[1]).toEqual(
        expect.objectContaining({
          appToken: 'resolved-training-app-token',
          tableId: config.defaultTableId,
          tableName: config.tableName,
          fieldNames: [...config.fieldNames],
          cacheTtlMs: 3_600_000,
          forceRefresh: true,
          strict: true,
          validateRecords: expect.any(Function),
        }),
      );
    }
    expect(
      jest
        .mocked(fetchBitableRecords)
        .mock.calls.some(([, options]) =>
          ['tbl17386849dd95c', 'tbl94bd80a843445'].includes(options.tableId),
        ),
    ).toBe(false);
    expect(first.month).toBe('2026-07');
    expect(first.sourceStatus).toBe('fresh');
    expect(first.dataStatus).toBe('ready');
    expect(first.sharing.categories).toEqual([
      expect.objectContaining({
        label: '技术交流',
        sessions: 1,
        percentage: 100,
      }),
    ]);
    expect(cachedLatest).toBe(first);
    expect(cachedResolvedMonth).toBe(first);
    expect(writeTrainingDashboardSourceSnapshot).toHaveBeenCalledTimes(1);
    expect(writeTrainingDashboardSourceSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        activeStats: expect.any(Array),
        activeScores: expect.any(Array),
        activePlans: expect.any(Array),
        newHireScores: expect.any(Array),
        newHireCourses: expect.any(Array),
        newHirePlans: expect.any(Array),
        sharingSessions: expect.any(Array),
        sharingScores: expect.any(Array),
        sharingInterests: expect.any(Array),
      }),
    );
    expect(readLatestPersistedBitableRecords).not.toHaveBeenCalled();
  });

  it('monthly patrol training reads only current-month active stats with dashboard percentages', async () => {
    installLiveSources({
      ...validSources(),
      activeStats: [
        sourceRecord('activeStats', {
          年份: '2026',
          月份: '09',
          楼栋: 'A楼',
          培训完成率: 1,
          考核达标率: 1,
        }),
        sourceRecord('activeStats', {
          年份: '2026',
          月份: '09',
          楼栋: 'B楼',
          培训完成率: 0.75,
          考核达标率: 0,
        }),
        sourceRecord('activeStats', {
          年份: '2026',
          月份: '09',
          楼栋: 'D楼',
          培训完成率: 0.583,
          考核达标率: 0,
        }),
        sourceRecord('activeStats', {
          年份: '2026',
          月份: '08',
          楼栋: 'E楼',
          培训完成率: 0,
          考核达标率: 0,
        }),
      ],
    });
    const service = new TrainingDashboardService({ axiosRef: {} } as never);

    const rows = await service.getMonthlyPatrolParticipation('2026-09');

    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
    expect(jest.mocked(fetchBitableRecords).mock.calls[0][1]).toEqual(
      expect.objectContaining({
        tableId: getTrainingTableId(
          TRAINING_TABLE_CONFIGS.find(({ key }) => key === 'activeStats')!,
        ),
        forceRefresh: true,
        strict: true,
      }),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        building: 'A楼',
        trainingCompletionRate: 100,
        assessmentPassRate: 100,
      }),
      expect.objectContaining({
        building: 'B楼',
        trainingCompletionRate: 75,
        assessmentPassRate: 0,
      }),
      expect.objectContaining({
        building: 'D楼',
        trainingCompletionRate: 58.3,
        assessmentPassRate: 0,
      }),
    ]);
  });

  it('does not substitute last month when current-month training stats are missing', async () => {
    installLiveSources({
      ...validSources(),
      activeStats: [
        sourceRecord('activeStats', {
          年份: '2026',
          月份: '08',
          楼栋: 'B楼',
          培训完成率: 0.75,
          考核达标率: 0,
        }),
      ],
    });
    const service = new TrainingDashboardService({ axiosRef: {} } as never);

    await expect(
      service.getMonthlyPatrolParticipation('2026-09'),
    ).rejects.toThrow('月度培训统计缺少 2026-09 楼栋数据');
  });

  it('projects the current legacy final-score field from the new-hire score table', () => {
    const newHireScoreConfig = TRAINING_DASHBOARD_TABLE_CONFIGS.find(
      ({ key }) => key === 'newHireScores',
    );

    expect(newHireScoreConfig?.fieldNames).toContain('最终考核成绩（旧）');
    expect(newHireScoreConfig?.fieldNames).not.toContain('最终考核成绩');
  });

  it('uses a finite configured assessment pass score and rejects out-of-range values', async () => {
    const sources = validSources();
    sources.activeScores[0] = sourceRecord('activeScores', {
      员工: [{ id: 'ou-active', name: '在岗员工' }],
      课程: '安全培训',
      考试分数: 85,
      签到: true,
      楼栋: 'A楼',
      月份: '07',
      '月份（计划）': '2026-07',
    });
    installLiveSources(sources);

    const missing = await new TrainingDashboardService({
      axiosRef: {},
    } as never).getDashboard('2026-07', true);
    expect(missing.details.assessmentPassScore).toBe(80);

    process.env.FEISHU_TRAINING_PASS_SCORE = '   ';
    const blank = await new TrainingDashboardService({
      axiosRef: {},
    } as never).getDashboard('2026-07', true);
    expect(blank.details.assessmentPassScore).toBe(80);

    process.env.FEISHU_TRAINING_PASS_SCORE = '90';

    const configured = await new TrainingDashboardService({
      axiosRef: {},
    } as never).getDashboard('2026-07', true);

    expect(configured.details.assessmentPassScore).toBe(90);
    expect(configured.details.participants[0]?.assessments[0]?.status).toBe(
      'failed',
    );

    process.env.FEISHU_TRAINING_PASS_SCORE = '101';
    const invalid = await new TrainingDashboardService({
      axiosRef: {},
    } as never).getDashboard('2026-07', true);

    expect(invalid.details.assessmentPassScore).toBe(80);
    expect(invalid.details.participants[0]?.assessments[0]?.status).toBe(
      'passed',
    );

    process.env.FEISHU_TRAINING_PASS_SCORE = 'Infinity';
    const nonFinite = await new TrainingDashboardService({
      axiosRef: {},
    } as never).getDashboard('2026-07', true);

    expect(nonFinite.details.assessmentPassScore).toBe(80);
  });

  it('projects the current sharing-session category field name', () => {
    const sharingConfig = TRAINING_DASHBOARD_TABLE_CONFIGS.find(
      ({ key }) => key === 'sharingSessions',
    );

    expect(sharingConfig?.fieldNames).toContain('分享类型');
    expect(sharingConfig?.fieldNames).not.toContain('类型');
  });

  it('projects the current active assessment and training summary fields', () => {
    const activeStatsConfig = TRAINING_DASHBOARD_TABLE_CONFIGS.find(
      ({ key }) => key === 'activeStats',
    );

    expect(activeStatsConfig?.fieldNames).toEqual(
      expect.arrayContaining([
        '本月需考核课程数量',
        '已完成考核的课程数量',
        '考试人数（2026）',
        '考核达标率',
        '已完成培训课程数量',
        '培训人数（2026）',
        '培训完成率',
      ]),
    );
  });

  it('reuses the synchronized source bundle for the daily window and refreshes it after expiry', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const service = new TrainingDashboardService({
        axiosRef: {},
      } as never);

      const first = await service.getDashboard('2026-07', true);
      now.mockReturnValue(1_000_000 + 60_000);
      const cached = await service.getDashboard('2026-07', false);

      expect(cached).not.toBe(first);
      expect(fetchBitableRecords).toHaveBeenCalledTimes(7);

      now.mockReturnValue(1_000_000 + 24 * 60 * 60 * 1000);
      const refreshed = await service.getDashboard('2026-07', false);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(refreshed).not.toBe(first);
      expect(fetchBitableRecords).toHaveBeenCalledTimes(14);
    } finally {
      now.mockRestore();
    }
  });

  it('uses a configured app token without resolving the Wiki node', async () => {
    process.env.FEISHU_TRAINING_APP_TOKEN = 'configured-training-app-token';
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);

    await service.getDashboard('2026-07', true);

    expect(resolveBitableAppToken).not.toHaveBeenCalled();
    expect(fetchBitableRecords).toHaveBeenCalledTimes(7);
    for (const [, options] of jest.mocked(fetchBitableRecords).mock.calls) {
      expect(options.appToken).toBe('configured-training-app-token');
    }
  });

  it('keeps a successful live response fresh when the whole-bundle write fails', async () => {
    jest
      .mocked(writeTrainingDashboardSourceSnapshot)
      .mockRejectedValueOnce(new Error('disk path=secret'));
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);

    const fresh = await service.getDashboard('2026-07', true);

    expect(fresh.sourceStatus).toBe('fresh');
    expect(fresh.errorMessage).toBeUndefined();
    expect(writeTrainingDashboardSourceSnapshot).toHaveBeenCalledTimes(1);
  });

  it('returns a renderable cold-start response before the Feishu refresh completes', async () => {
    const sources = validSources();
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    jest
      .mocked(fetchBitableRecords)
      .mockImplementation(
        async (_httpService, options: FetchBitableRecordsOptions) => {
          await fetchGate;
          const config = configForTableId(options.tableId);
          const records = sources[config.key];
          options.validateRecords?.(records);
          return records;
        },
      );
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);
    let settled = false;
    const request = service.getDashboard('2026-07', false).then((result) => {
      settled = true;
      return result;
    });

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(settled).toBe(true);
      const response = await request;
      expect(response.month).toBe('2026-07');
      expect(response.sourceStatus).toBe('stale');
      expect(response.dataStatus).toBe('empty');
      expect(readTrainingDashboardSourceSnapshot).toHaveBeenCalledTimes(1);
      expect(fetchBitableRecords).toHaveBeenCalledTimes(7);
    } finally {
      releaseFetch();
      await Promise.allSettled([request]);
    }
  });

  it('shares one in-flight seven-table source load across different requested months', async () => {
    const sources = validSources();
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    jest
      .mocked(fetchBitableRecords)
      .mockImplementation(
        async (_httpService, options: FetchBitableRecordsOptions) => {
          await fetchGate;
          const config = configForTableId(options.tableId);
          const records = sources[config.key];
          options.validateRecords?.(records);
          return records;
        },
      );
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);

    const first = service.getDashboard('2026-07', false);
    const concurrent = service.getDashboard('2026-06', false);
    await Promise.resolve();
    await Promise.resolve();
    releaseFetch();

    const [firstResult, concurrentResult] = await Promise.all([
      first,
      concurrent,
    ]);
    expect(firstResult.month).toBe('2026-07');
    expect(concurrentResult.month).toBe('2026-06');
    expect(fetchBitableRecords).toHaveBeenCalledTimes(7);
    expect(
      jest
        .mocked(fetchBitableRecords)
        .mock.calls.every(([, options]) => options.forceRefresh === true),
    ).toBe(true);
  });

  it('reuses one background-refreshed source bundle for month switching and only bypasses it on forced refresh', async () => {
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);

    await service.getDashboard('2026-07', false);
    await service.getDashboard('2026-06', false);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fetchBitableRecords).toHaveBeenCalledTimes(7);
    expect(
      jest
        .mocked(fetchBitableRecords)
        .mock.calls.every(([, options]) => options.forceRefresh === true),
    ).toBe(true);

    await service.getDashboard('2026-06', true);

    expect(fetchBitableRecords).toHaveBeenCalledTimes(14);
    expect(
      jest
        .mocked(fetchBitableRecords)
        .mock.calls.slice(7)
        .every(([, options]) => options.forceRefresh === true),
    ).toBe(true);
  });

  it('exposes freshly synchronized data on the next normal request', async () => {
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);

    const initial = await service.getDashboard('2026-07', false);
    expect(initial.sourceStatus).toBe('stale');
    expect(initial.dataStatus).toBe('empty');

    await new Promise<void>((resolve) => setImmediate(resolve));
    const synchronized = await service.getDashboard('2026-07', false);

    expect(synchronized.sourceStatus).toBe('fresh');
    expect(synchronized.dataStatus).toBe('ready');
    expect(synchronized.summary.monthlyPlannedCourses).toBeGreaterThan(0);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(7);
  });

  it('returns an immutable whole stale snapshot with redacted errors when any live table fails', async () => {
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);
    const fresh = await service.getDashboard(undefined, true);
    const untouchedFresh = JSON.parse(JSON.stringify(fresh)) as typeof fresh;
    const sources = validSources();
    jest
      .mocked(fetchBitableRecords)
      .mockImplementation(
        async (_httpService, options: FetchBitableRecordsOptions) => {
          const config = configForTableId(options.tableId);
          if (config.key === 'activePlans') {
            throw new Error('upstream token=secret');
          }
          const records = sources[config.key];
          options.validateRecords?.(records);
          return records;
        },
      );

    const stale = await service.getDashboard(undefined, true);
    const {
      sourceStatus: _freshStatus,
      errorMessage: _freshError,
      ...freshPayload
    } = fresh;
    const {
      sourceStatus: _staleStatus,
      errorMessage: _staleError,
      ...stalePayload
    } = stale;

    const cachedLatest = await service.getDashboard(undefined, false);
    const cachedResolvedMonth = await service.getDashboard(stale.month, false);

    expect(stale).not.toBe(fresh);
    expect(stalePayload).toEqual(freshPayload);
    expect(stale.syncedAt).toBe(fresh.syncedAt);
    expect(stale.sourceStatus).toBe('stale');
    expect(stale.errorMessage).toBe(STALE_ERROR_MESSAGE);
    expect(JSON.stringify(stale)).not.toContain('secret');
    expect(fresh).toEqual(untouchedFresh);
    expect(fresh.sourceStatus).toBe('fresh');
    expect(fresh.errorMessage).toBeUndefined();
    expect(cachedLatest).toBe(stale);
    expect(cachedResolvedMonth).toBe(stale);
    expect(writeTrainingDashboardSourceSnapshot).toHaveBeenCalledTimes(1);
  });

  it('loads one complete stored source bundle as a stale snapshot after a cold live failure', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockRejectedValue(new Error('live token=secret'));
    installStoredSources();
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);

    const stale = await service.getDashboard('2026-07', false);

    expect(readTrainingDashboardSourceSnapshot).toHaveBeenCalledTimes(1);
    expect(readLatestPersistedBitableRecords).not.toHaveBeenCalled();
    expect(writeTrainingDashboardSourceSnapshot).not.toHaveBeenCalled();
    expect(stale.month).toBe('2026-07');
    expect(stale.sourceStatus).toBe('stale');
    expect(stale.errorMessage).toBe(STALE_ERROR_MESSAGE);
    expect(stale.sharing.interests).toEqual([]);
    expect(JSON.stringify(stale)).not.toContain('secret');
  });

  it('returns one redacted empty fallback when a cold bundle is missing, incomplete, or dirty', async () => {
    const invalidCases = ['missing', 'incomplete', 'dirty'] as const;

    for (const invalidCase of invalidCases) {
      jest.clearAllMocks();
      jest
        .mocked(resolveBitableAppToken)
        .mockResolvedValue('resolved-training-app-token');
      jest
        .mocked(fetchBitableRecords)
        .mockRejectedValue(new Error('upstream token=secret'));
      const sources = validSources();
      if (invalidCase === 'missing') {
        jest
          .mocked(readTrainingDashboardSourceSnapshot)
          .mockResolvedValue(null);
      } else if (invalidCase === 'incomplete') {
        const { activeStats: _missing, ...incomplete } = sources;
        jest
          .mocked(readTrainingDashboardSourceSnapshot)
          .mockResolvedValue(incomplete as unknown as TrainingSourcesFixture);
      } else {
        sources.activeStats = [
          sourceRecord('activeStats', {
            年份: '2026',
          }),
        ];
        jest
          .mocked(readTrainingDashboardSourceSnapshot)
          .mockResolvedValue(sources);
      }
      const service = new TrainingDashboardService({
        axiosRef: {},
      } as never);

      const fallback = await service.getDashboard('2026-07', true);

      expect(fallback.sourceStatus).toBe('stale');
      expect(fallback.dataStatus).toBe('empty');
      expect(fallback.errorMessage).toContain('后台同步');
      expect(JSON.stringify(fallback)).not.toContain('secret');
      expect(readTrainingDashboardSourceSnapshot).toHaveBeenCalledTimes(1);
      expect(readLatestPersistedBitableRecords).not.toHaveBeenCalled();
      expect(writeTrainingDashboardSourceSnapshot).not.toHaveBeenCalled();
    }
  });

  it('accepts an empty interest table as fresh but rejects an empty core table without replacing last good', async () => {
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);

    const fresh = await service.getDashboard('2026-07', true);
    expect(fresh.sourceStatus).toBe('fresh');
    expect(fresh.sharing.interests).toEqual([]);

    const sources = validSources();
    jest
      .mocked(fetchBitableRecords)
      .mockImplementation(
        async (_httpService, options: FetchBitableRecordsOptions) => {
          const config = configForTableId(options.tableId);
          const records =
            config.key === 'activeStats' ? [] : sources[config.key];
          options.validateRecords?.(records);
          return records;
        },
      );

    const stale = await service.getDashboard('2026-07', true);

    expect(stale.sourceStatus).toBe('stale');
    expect(stale.errorMessage).toBe(STALE_ERROR_MESSAGE);
    expect(stale.syncedAt).toBe(fresh.syncedAt);
    expect(stale.summary).toEqual(fresh.summary);
    expect(stale.progress).toEqual(fresh.progress);
    expect(stale.participation).toEqual(fresh.participation);
    expect(stale.newHirePlans).toEqual(fresh.newHirePlans);
    expect(stale.sharing).toEqual(fresh.sharing);
    expect(stale.courses).toEqual(fresh.courses);
    expect(writeTrainingDashboardSourceSnapshot).toHaveBeenCalledTimes(1);
  });

  it('rejects a partially projected live core record and keeps the whole baseline stale', async () => {
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);
    const fresh = await service.getDashboard('2026-07', true);
    const sources = validSources();
    sources.activeStats = [
      sourceRecord('activeStats', {
        年份: '2026',
      }),
    ];
    installLiveSources(sources);

    const stale = await service.getDashboard('2026-07', true);

    expect(stale.sourceStatus).toBe('stale');
    expect(stale.errorMessage).toBe(STALE_ERROR_MESSAGE);
    expect(stale.syncedAt).toBe(fresh.syncedAt);
    expect(stale.summary).toEqual(fresh.summary);
    expect(writeTrainingDashboardSourceSnapshot).toHaveBeenCalledTimes(1);
  });

  it('returns the redacted empty fallback for a cold partially projected core record', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockRejectedValue(new Error('upstream token=secret'));
    const sources = validSources();
    sources.activeStats = [
      sourceRecord('activeStats', {
        年份: '2026',
      }),
    ];
    installStoredSources(sources);
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);

    const fallback = await service.getDashboard('2026-07', true);

    expect(fallback.sourceStatus).toBe('stale');
    expect(fallback.dataStatus).toBe('empty');
    expect(fallback.errorMessage).toContain('后台同步');
    expect(JSON.stringify(fallback)).not.toContain('secret');
    expect(readLatestPersistedBitableRecords).not.toHaveBeenCalled();
    expect(writeTrainingDashboardSourceSnapshot).not.toHaveBeenCalled();
  });

  it('rejects non-empty live interests without any projected field and keeps the baseline stale', async () => {
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);
    const fresh = await service.getDashboard('2026-07', true);
    const sources = validSources();
    sources.sharingInterests = [
      sourceRecord('sharingInterests', {
        unknownProjection: 'must not pass quality validation',
      }),
    ];
    installLiveSources(sources);

    const stale = await service.getDashboard('2026-07', true);

    expect(stale.sourceStatus).toBe('stale');
    expect(stale.errorMessage).toBe(STALE_ERROR_MESSAGE);
    expect(stale.syncedAt).toBe(fresh.syncedAt);
    expect(stale.sharing).toEqual(fresh.sharing);
    expect(writeTrainingDashboardSourceSnapshot).toHaveBeenCalledTimes(1);
  });

  it('returns the redacted empty fallback for stored interests without any projected field', async () => {
    jest
      .mocked(fetchBitableRecords)
      .mockRejectedValue(new Error('upstream token=secret'));
    const sources = validSources();
    sources.sharingInterests = [
      sourceRecord('sharingInterests', {
        unknownProjection: 'must not pass quality validation',
      }),
    ];
    installStoredSources(sources);
    const service = new TrainingDashboardService({
      axiosRef: {},
    } as never);

    const fallback = await service.getDashboard('2026-07', true);

    expect(fallback.sourceStatus).toBe('stale');
    expect(fallback.dataStatus).toBe('empty');
    expect(fallback.errorMessage).toContain('后台同步');
    expect(JSON.stringify(fallback)).not.toContain('secret');
    expect(readLatestPersistedBitableRecords).not.toHaveBeenCalled();
    expect(writeTrainingDashboardSourceSnapshot).not.toHaveBeenCalled();
  });
});
