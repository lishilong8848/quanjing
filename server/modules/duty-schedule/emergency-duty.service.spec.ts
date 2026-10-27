import type { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { GuestReadableMetadataKey } from '@server/common/access/unified-access.decorators';
import {
  fetchBitableRecords,
  invalidateBitableRecordCache,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
  type BitableRecordItem,
  type PersistedBitableRecordSnapshot,
} from '@server/common/feishu/bitable-direct-read';
import type { ActivePersonnelDirectory } from '@server/modules/bitable-sync/active-personnel-directory';
import type { BitableSyncService } from '@server/modules/bitable-sync/bitable-sync.service';
import { EmergencyDutyController } from './emergency-duty.controller';
import {
  DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS,
  EmergencyDutyService,
} from './emergency-duty.service';

jest.mock('@server/common/feishu/bitable-direct-read', () => {
  const actual = jest.requireActual(
    '@server/common/feishu/bitable-direct-read',
  );
  return {
    ...actual,
    fetchBitableRecords: jest.fn(),
    invalidateBitableRecordCache: jest.fn(),
    readLatestPersistedBitableRecordSnapshot: jest.fn(),
    resolveBitableAppToken: jest.fn(),
  };
});

jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const classDecorator = () => (target: unknown) => target;
  const methodDecorator = () => () => undefined;
  const parameterDecorator = () => () => undefined;
  return {
    ...actual,
    Body: parameterDecorator,
    Controller: classDecorator,
    Get: methodDecorator,
    Post: methodDecorator,
    Query: parameterDecorator,
  };
});

const mockedFetchBitableRecords = jest.mocked(fetchBitableRecords);
const mockedInvalidateBitableRecordCache = jest.mocked(
  invalidateBitableRecordCache,
);
const mockedReadLatestSnapshot = jest.mocked(
  readLatestPersistedBitableRecordSnapshot,
);
const mockedResolveBitableAppToken = jest.mocked(resolveBitableAppToken);

const ACTIVE_PERSON = {
  recordId: 'rec-person-active',
  name: '张三',
  openId: 'ou_active_private',
  employeeNo: 'N001',
  position: '设施运维经理',
  systemPosition: '运维经理',
  buildings: ['A'] as const,
};
const SECOND_ACTIVE_PERSON = {
  recordId: 'rec-person-second',
  name: '李四',
  openId: 'ou_second_private',
  employeeNo: 'N002',
  position: '设施运维工程师',
  systemPosition: '运维工程师',
  buildings: ['B'] as const,
};
const TARGET_DATE = '2026-08-09';
const TARGET_DATE_TIMESTAMP = Date.parse('2026-08-09T00:00:00+08:00');
const CLIENT_MUTATION_ID =
  'emergency-duty-123e4567-e89b-42d3-a456-426614174000';
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function getWriteDisposition(error: unknown): unknown {
  if (
    !error ||
    typeof error !== 'object' ||
    !('getResponse' in error) ||
    typeof error.getResponse !== 'function'
  ) {
    return undefined;
  }
  const response = error.getResponse();
  return response && typeof response === 'object'
    ? (response as { writeDisposition?: unknown }).writeDisposition
    : undefined;
}

describe('EmergencyDutyService', () => {
  let service: EmergencyDutyService;
  let axiosPost: jest.Mock;
  let axiosPut: jest.Mock;
  let getCachedActivePersonnelDirectory: jest.Mock;
  let createService: () => EmergencyDutyService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetchBitableRecords.mockReset();
    mockedInvalidateBitableRecordCache.mockReset();
    mockedReadLatestSnapshot.mockReset();
    mockedResolveBitableAppToken.mockReset();
    mockedResolveBitableAppToken.mockResolvedValue('app-emergency-actual');
    mockedReadLatestSnapshot.mockResolvedValue(snapshot([]));
    mockedFetchBitableRecords.mockResolvedValue([]);

    axiosPost = jest.fn(async (url: string, body: Record<string, unknown>) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return {
          status: 200,
          data: {
            code: 0,
            tenant_access_token: 'tenant-token-private',
            expire: 7200,
          },
        };
      }
      if (url.endsWith('/records')) {
        return {
          status: 200,
          data: {
            code: 0,
            data: {
              record: {
                record_id: 'rec-created',
                fields: body.fields,
              },
            },
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });
    axiosPut = jest.fn(async (_url: string, body: Record<string, unknown>) => ({
      status: 200,
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'rec-existing',
            fields: body.fields,
          },
        },
      },
    }));
    getCachedActivePersonnelDirectory = jest
      .fn()
      .mockResolvedValue(
        activeDirectory([ACTIVE_PERSON, SECOND_ACTIVE_PERSON]),
      );

    createService = () =>
      new EmergencyDutyService(
        {
          axiosRef: {
            post: axiosPost,
            put: axiosPut,
          },
        } as unknown as HttpService,
        {
          getCachedActivePersonnelDirectory,
        } as unknown as BitableSyncService,
      );
    service = createService();
  });

  it('maps the date, people, building, and record id without exposing open_id', async () => {
    const options = await service.getOptions();
    const activeKey = options.options.find(
      (option) => option.name === ACTIVE_PERSON.name,
    )?.key;
    mockedReadLatestSnapshot.mockResolvedValue(
      snapshot([
        emergencyRecord('rec-duty-1', TARGET_DATE_TIMESTAMP, {
          值班人员: [
            { id: ACTIVE_PERSON.openId, name: ACTIVE_PERSON.name },
            { open_id: 'ou_unknown_private', name: '历史人员' },
          ],
          值守机楼: 'A楼',
        }),
      ]),
    );

    const result = await service.getSchedules();

    expect(result.schedules).toEqual([
      {
        recordId: 'rec-duty-1',
        date: TARGET_DATE,
        people: [
          {
            key: activeKey,
            name: ACTIVE_PERSON.name,
            role: ACTIVE_PERSON.position,
          },
          {
            key: expect.any(String),
            name: '历史人员',
            role: '值班人员',
          },
        ],
        building: 'A楼',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(ACTIVE_PERSON.openId);
    expect(JSON.stringify(result)).not.toContain('ou_unknown_private');
  });

  it('does not remap a historical user with a different id to an active namesake', async () => {
    const activeKey = await getPersonKey(service, ACTIVE_PERSON.name);
    mockedReadLatestSnapshot.mockResolvedValue(
      snapshot([
        emergencyRecord('rec-duty-namesake', TARGET_DATE_TIMESTAMP, {
          值班人员: [
            {
              id: 'ou_departed_namesake_private',
              name: ACTIVE_PERSON.name,
            },
          ],
        }),
      ]),
    );

    const result = await service.getSchedules();

    expect(result.schedules[0].people).toEqual([
      {
        key: expect.any(String),
        name: ACTIVE_PERSON.name,
        role: '值班人员',
      },
    ]);
    expect(result.schedules[0].people[0].key).not.toBe(activeKey);
    expect(JSON.stringify(result)).not.toContain(
      'ou_departed_namesake_private',
    );
  });

  it('serves normal schedule reads only from the latest persisted snapshot', async () => {
    mockedReadLatestSnapshot.mockResolvedValue({
      records: [emergencyRecord('rec-duty-1', TARGET_DATE_TIMESTAMP)],
      fetchedAt: Date.now(),
      expiresAt: Date.now() + DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS,
    });

    await service.getSchedules(TARGET_DATE, TARGET_DATE);

    expect(mockedReadLatestSnapshot).toHaveBeenCalledWith({
      tableId: 'tblnGg3s3lgn6Plq',
      viewId: 'vewgzik2Nv',
      tableName: '应急值班',
      fieldNames: ['值守机楼', '值班人员', '排班日期'],
    });
    expect(mockedFetchBitableRecords).not.toHaveBeenCalled();
    expect(mockedResolveBitableAppToken).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
    expect(axiosPut).not.toHaveBeenCalled();
  });

  it('returns an expired persisted snapshot without waiting for the background refresh', async () => {
    let resolveRefresh!: (records: BitableRecordItem[]) => void;
    const pendingRefresh = new Promise<BitableRecordItem[]>((resolve) => {
      resolveRefresh = resolve;
    });
    mockedReadLatestSnapshot.mockResolvedValue({
      records: [emergencyRecord('rec-duty-stale', TARGET_DATE_TIMESTAMP)],
      fetchedAt: Date.now() - DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS - 1,
      expiresAt: Date.now() - 1,
    });
    mockedFetchBitableRecords.mockReturnValue(pendingRefresh);

    const result = await service.getSchedules(TARGET_DATE, TARGET_DATE);

    expect(result).toMatchObject({
      schedules: [{ recordId: 'rec-duty-stale' }],
      snapshot: { stale: true },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(1);

    resolveRefresh([]);
    await pendingRefresh;
  });

  it('deduplicates background refreshes from concurrent expired snapshot reads', async () => {
    let resolveRefresh!: (records: BitableRecordItem[]) => void;
    const pendingRefresh = new Promise<BitableRecordItem[]>((resolve) => {
      resolveRefresh = resolve;
    });
    mockedReadLatestSnapshot.mockResolvedValue({
      records: [emergencyRecord('rec-duty-stale', TARGET_DATE_TIMESTAMP)],
      fetchedAt: Date.now() - DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS - 1,
      expiresAt: Date.now() - 1,
    });
    mockedFetchBitableRecords.mockReturnValue(pendingRefresh);

    await Promise.all([
      service.getSchedules(TARGET_DATE, TARGET_DATE),
      service.getSchedules(TARGET_DATE, TARGET_DATE),
      service.getSchedules(TARGET_DATE, TARGET_DATE),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(1);

    resolveRefresh([]);
    await pendingRefresh;
  });

  it('handles an expired snapshot background refresh failure without rejecting the read', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    mockedReadLatestSnapshot.mockResolvedValue({
      records: [emergencyRecord('rec-duty-stale', TARGET_DATE_TIMESTAMP)],
      fetchedAt: Date.now() - DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS - 1,
      expiresAt: Date.now() - 1,
    });
    mockedFetchBitableRecords.mockRejectedValue(
      new Error('temporary Feishu refresh failure'),
    );

    try {
      await expect(
        service.getSchedules(TARGET_DATE, TARGET_DATE),
      ).resolves.toMatchObject({
        schedules: [{ recordId: 'rec-duty-stale' }],
        snapshot: { stale: true },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('过期快照后台刷新失败'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps the persisted snapshot valid beyond one refresh interval', async () => {
    await service.refreshCache();

    const cacheTtlMs = mockedFetchBitableRecords.mock.calls[0]?.[1]?.cacheTtlMs;
    expect(cacheTtlMs).toBeGreaterThan(DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS);
  });

  it('rejects repeated date query parameters as bad requests', async () => {
    await expect(service.getSchedules([TARGET_DATE])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.getSchedules(undefined, [TARGET_DATE]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockedReadLatestSnapshot).not.toHaveBeenCalled();
  });

  it('filters inclusively by date, keeps the latest duplicate date, and sorts ascending', async () => {
    mockedReadLatestSnapshot.mockResolvedValue(
      snapshot([
        emergencyRecord('rec-10', Date.parse('2026-08-10T00:00:00+08:00')),
        emergencyRecord('rec-09-old', TARGET_DATE_TIMESTAMP, {}, 100),
        emergencyRecord('rec-08', Date.parse('2026-08-08T00:00:00+08:00')),
        emergencyRecord('rec-09-new', TARGET_DATE_TIMESTAMP, {}, 200),
      ]),
    );

    const result = await service.getSchedules('2026-08-09', '2026-08-10');

    expect(result.schedules.map((item) => [item.date, item.recordId])).toEqual([
      ['2026-08-09', 'rec-09-new'],
      ['2026-08-10', 'rec-10'],
    ]);
  });

  it('returns active personnel options with stable opaque keys and roles', async () => {
    const first = await service.getOptions();
    const second = await service.getOptions();

    expect(getCachedActivePersonnelDirectory).toHaveBeenCalledTimes(2);
    expect(first).toEqual(second);
    expect(first.options).toEqual([
      {
        key: expect.any(String),
        name: ACTIVE_PERSON.name,
        role: ACTIVE_PERSON.position,
      },
      {
        key: expect.any(String),
        name: SECOND_ACTIVE_PERSON.name,
        role: SECOND_ACTIVE_PERSON.position,
      },
    ]);
    expect(JSON.stringify(first)).not.toContain(ACTIVE_PERSON.openId);
    expect(first.options[0].key).not.toBe(ACTIVE_PERSON.recordId);
  });

  it('creates with Feishu user objects and the mutation id as client_token', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    const confirmedRecord = emergencyRecordWithPeople(
      'rec-created',
      TARGET_DATE_TIMESTAMP,
      [ACTIVE_PERSON.openId],
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([confirmedRecord]);
    mockedReadLatestSnapshot.mockResolvedValue(snapshot([confirmedRecord]));

    const result = await service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: CLIENT_MUTATION_ID,
    });

    const writeCall = axiosPost.mock.calls.find(([url]) =>
      String(url).endsWith('/records'),
    );
    expect(writeCall).toBeDefined();
    expect(writeCall?.[2]).toEqual(
      expect.objectContaining({
        params: {
          client_token: expect.stringMatching(UUID_V4_PATTERN),
          user_id_type: 'open_id',
        },
        headers: { Authorization: 'Bearer tenant-token-private' },
      }),
    );
    expect(writeCall?.[1]).toEqual({
      fields: {
        排班日期: TARGET_DATE_TIMESTAMP,
        值班人员: [{ id: ACTIVE_PERSON.openId }],
      },
    });
    expect(result).toEqual({
      record: {
        recordId: 'rec-created',
        date: TARGET_DATE,
        people: [
          {
            key: personKey,
            name: ACTIVE_PERSON.name,
            role: ACTIVE_PERSON.position,
          },
        ],
        building: null,
      },
      syncStatus: 'synced',
      clientMutationId: CLIENT_MUTATION_ID,
    });
    expect(mockedInvalidateBitableRecordCache).toHaveBeenCalledWith({
      appToken: 'app-emergency-actual',
      tableId: 'tblnGg3s3lgn6Plq',
    });
  });

  it('derives stable and distinct UUIDv4 client tokens from public mutation ids', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    const request = {
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: CLIENT_MUTATION_ID,
    };

    await service.upsertSchedule(request);
    await createService().upsertSchedule(request);
    await createService().upsertSchedule({
      ...request,
      clientMutationId: 'another-safe-public-mutation-id',
    });

    const clientTokens = axiosPost.mock.calls
      .filter(([url]) => String(url).endsWith('/records'))
      .map((call) => call[2]?.params?.client_token);
    expect(clientTokens).toHaveLength(3);
    expect(clientTokens[0]).toMatch(UUID_V4_PATTERN);
    expect(clientTokens[1]).toBe(clientTokens[0]);
    expect(clientTokens[2]).toMatch(UUID_V4_PATTERN);
    expect(clientTokens[2]).not.toBe(clientTokens[0]);
  });

  it('updates the single record matching the requested date', async () => {
    const personKey = await getPersonKey(service, SECOND_ACTIVE_PERSON.name);
    const confirmedRecord = emergencyRecordWithPeople(
      'rec-existing',
      TARGET_DATE_TIMESTAMP,
      [SECOND_ACTIVE_PERSON.openId],
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([
        emergencyRecord('rec-existing', TARGET_DATE_TIMESTAMP),
      ])
      .mockResolvedValueOnce([confirmedRecord]);
    mockedReadLatestSnapshot.mockResolvedValue(snapshot([confirmedRecord]));

    const result = await service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: CLIENT_MUTATION_ID,
    });

    expect(axiosPut).toHaveBeenCalledWith(
      expect.stringMatching(/\/records\/rec-existing$/),
      {
        fields: {
          排班日期: TARGET_DATE_TIMESTAMP,
          值班人员: [{ id: SECOND_ACTIVE_PERSON.openId }],
          值守机楼: null,
        },
      },
      expect.objectContaining({
        params: {
          client_token: expect.stringMatching(UUID_V4_PATTERN),
          user_id_type: 'open_id',
        },
      }),
    );
    expect(result.record.recordId).toBe('rec-existing');
    expect(result.syncStatus).toBe('synced');
  });

  it.each([
    ['remote refresh', true],
    ['persisted snapshot', false],
  ])(
    'does not confirm an update while the %s still has a non-empty building',
    async (_label, remoteHasBuilding) => {
      const personKey = await getPersonKey(service, SECOND_ACTIVE_PERSON.name);
      const canonicalRecord = emergencyRecordWithPeople(
        'rec-existing',
        TARGET_DATE_TIMESTAMP,
        [SECOND_ACTIVE_PERSON.openId],
      );
      const staleBuildingRecord = emergencyRecord(
        'rec-existing',
        TARGET_DATE_TIMESTAMP,
        {
          值班人员: [{ id: SECOND_ACTIVE_PERSON.openId }],
          值守机楼: 'A楼',
        },
      );
      mockedFetchBitableRecords
        .mockResolvedValueOnce([
          emergencyRecord('rec-existing', TARGET_DATE_TIMESTAMP, {
            值守机楼: 'A楼',
          }),
        ])
        .mockResolvedValueOnce([
          remoteHasBuilding ? staleBuildingRecord : canonicalRecord,
        ]);
      mockedReadLatestSnapshot.mockResolvedValue(
        snapshot([remoteHasBuilding ? canonicalRecord : staleBuildingRecord]),
      );

      const result = await service.upsertSchedule({
        date: TARGET_DATE,
        personKeys: [personKey],
        clientMutationId: `${CLIENT_MUTATION_ID}-${remoteHasBuilding ? 'remote' : 'persisted'}-building`,
      });

      expect(result.syncStatus).toBe('cache_refresh_pending');
    },
  );

  it('rejects a date that already has more than one remote record', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    mockedFetchBitableRecords.mockResolvedValue([
      emergencyRecord('rec-duplicate-1', TARGET_DATE_TIMESTAMP),
      emergencyRecord('rec-duplicate-2', TARGET_DATE_TIMESTAMP),
    ]);

    const error = await service
      .upsertSchedule({
        date: TARGET_DATE,
        personKeys: [personKey],
        clientMutationId: CLIENT_MUTATION_ID,
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictException);
    expect(getWriteDisposition(error)).toBe('definitely-not-written');
    expect(axiosPut).not.toHaveBeenCalled();
    expect(
      axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/records')),
    ).toHaveLength(0);
  });

  it('re-resolves opaque person keys against the current active directory before writing', async () => {
    const formerlyActiveKey = await getPersonKey(service, ACTIVE_PERSON.name);
    getCachedActivePersonnelDirectory.mockResolvedValue(activeDirectory([]));

    const error = await service
      .upsertSchedule({
        date: TARGET_DATE,
        personKeys: [formerlyActiveKey],
        clientMutationId: CLIENT_MUTATION_ID,
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(getWriteDisposition(error)).toBe('definitely-not-written');
    expect(mockedFetchBitableRecords).not.toHaveBeenCalled();
  });

  it('rejects an empty personnel selection before any remote request', async () => {
    const error = await service
      .upsertSchedule({
        date: TARGET_DATE,
        personKeys: [],
        clientMutationId: CLIENT_MUTATION_ID,
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(getWriteDisposition(error)).toBe('definitely-not-written');
    expect(getCachedActivePersonnelDirectory).not.toHaveBeenCalled();
    expect(mockedResolveBitableAppToken).not.toHaveBeenCalled();
    expect(mockedFetchBitableRecords).not.toHaveBeenCalled();
  });

  it('returns cache_refresh_pending when the remote write succeeds but snapshot refresh fails', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('snapshot refresh unavailable'));

    await expect(
      service.upsertSchedule({
        date: TARGET_DATE,
        personKeys: [personKey],
        clientMutationId: CLIENT_MUTATION_ID,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        syncStatus: 'cache_refresh_pending',
        clientMutationId: CLIENT_MUTATION_ID,
        record: expect.objectContaining({ recordId: 'rec-created' }),
      }),
    );
  });

  it('does not expose an upstream Feishu message or open_id in BadGatewayException', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    axiosPost
      .mockResolvedValueOnce({
        status: 200,
        data: {
          code: 0,
          tenant_access_token: 'tenant-token-private',
          expire: 7200,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          code: 1254060,
          msg: 'upstream-secret invalid open_id ou_sensitive_private',
        },
      });
    mockedFetchBitableRecords.mockResolvedValueOnce([]);

    const error = await service
      .upsertSchedule({
        date: TARGET_DATE,
        personKeys: [personKey],
        clientMutationId: CLIENT_MUTATION_ID,
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BadGatewayException);
    expect(getWriteDisposition(error)).toBe('definitely-not-written');
    const publicError = JSON.stringify({
      message: (error as BadGatewayException).message,
      response: (error as BadGatewayException).getResponse(),
    });
    expect(publicError).toContain('写入应急值班记录失败');
    expect(publicError).not.toContain('upstream-secret');
    expect(publicError).not.toContain('open_id');
    expect(publicError).not.toContain('ou_sensitive_private');
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(1);
    expect(
      axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/records')),
    ).toHaveLength(1);
  });

  it.each([
    ['active personnel cache', 'directory'],
    ['Base app token lookup', 'app-token'],
    ['remote schedule read', 'schedule-read'],
    ['tenant access token', 'tenant-token'],
  ] as const)(
    'marks a %s failure before the write as definitely-not-written',
    async (_label, stage) => {
      const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
      if (stage === 'directory') {
        getCachedActivePersonnelDirectory.mockRejectedValueOnce(
          new Error('directory unavailable'),
        );
      } else if (stage === 'app-token') {
        mockedResolveBitableAppToken.mockRejectedValueOnce(
          new Error('wiki lookup unavailable'),
        );
      } else if (stage === 'schedule-read') {
        mockedFetchBitableRecords.mockRejectedValueOnce(
          new Error('Base read unavailable'),
        );
      } else {
        axiosPost.mockRejectedValueOnce(new Error('auth unavailable'));
      }

      const error = await service
        .upsertSchedule({
          date: TARGET_DATE,
          personKeys: [personKey],
          clientMutationId: `${CLIENT_MUTATION_ID}-${stage}`,
        })
        .catch((cause: unknown) => cause);

      expect(getWriteDisposition(error)).toBe('definitely-not-written');
      expect(
        axiosPost.mock.calls.filter(([url]) =>
          String(url).endsWith('/records'),
        ),
      ).toHaveLength(0);
      expect(axiosPut).not.toHaveBeenCalled();
    },
  );

  it.each([400, 422])(
    'marks an explicit Feishu HTTP %i rejection as definitely-not-written',
    async (status) => {
      const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
      mockedFetchBitableRecords.mockResolvedValueOnce([]);
      axiosPost
        .mockResolvedValueOnce({
          status: 200,
          data: {
            code: 0,
            tenant_access_token: 'tenant-token-private',
            expire: 7200,
          },
        })
        .mockRejectedValueOnce({
          response: {
            status,
            data: { code: 1254060, msg: 'private upstream details' },
          },
        });

      const error = await service
        .upsertSchedule({
          date: TARGET_DATE,
          personKeys: [personKey],
          clientMutationId: `${CLIENT_MUTATION_ID}-explicit-rejection`,
        })
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(BadGatewayException);
      expect(getWriteDisposition(error)).toBe('definitely-not-written');
      expect(
        JSON.stringify((error as BadGatewayException).getResponse()),
      ).not.toContain('private upstream details');
    },
  );

  it.each([425, 429])(
    'keeps Feishu HTTP %i as unknown-result when forced readback cannot confirm the write',
    async (status) => {
      const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
      mockedFetchBitableRecords
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      axiosPost
        .mockResolvedValueOnce({
          status: 200,
          data: {
            code: 0,
            tenant_access_token: 'tenant-token-private',
            expire: 7200,
          },
        })
        .mockRejectedValueOnce({
          response: {
            status,
            data: { code: 1254060, msg: 'private upstream details' },
          },
        });

      const error = await service
        .upsertSchedule({
          date: TARGET_DATE,
          personKeys: [personKey],
          clientMutationId: `${CLIENT_MUTATION_ID}-ambiguous-${status}`,
        })
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(getWriteDisposition(error)).toBe('unknown-result');
      expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(2);
      expect(
        JSON.stringify((error as ServiceUnavailableException).getResponse()),
      ).not.toContain('private upstream details');
    },
  );

  it('reconciles Feishu code 1255006 as an accepted write without writing twice', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    const confirmedRecord = emergencyRecordWithPeople(
      'rec-accepted-pending',
      TARGET_DATE_TIMESTAMP,
      [ACTIVE_PERSON.openId],
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([confirmedRecord]);
    mockedReadLatestSnapshot.mockResolvedValue(snapshot([confirmedRecord]));
    axiosPost.mockImplementation(
      async (url: string, body: Record<string, unknown>) => {
        if (url.includes('/auth/v3/tenant_access_token/internal')) {
          return {
            status: 200,
            data: {
              code: 0,
              tenant_access_token: 'tenant-token-private',
              expire: 7200,
            },
          };
        }
        if (url.endsWith('/records')) {
          return {
            status: 200,
            data: {
              code: 1255006,
              msg: 'accepted pending open_id=ou_sensitive_private',
            },
          };
        }
        throw new Error(`Unexpected POST ${url}: ${JSON.stringify(body)}`);
      },
    );

    await expect(
      service.upsertSchedule({
        date: TARGET_DATE,
        personKeys: [personKey],
        clientMutationId: `${CLIENT_MUTATION_ID}-accepted-pending`,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          recordId: 'rec-accepted-pending',
        }),
        syncStatus: 'synced',
      }),
    );
    expect(
      axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/records')),
    ).toHaveLength(1);
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(2);
  });

  it('reconciles a successful create response missing record_id without writing twice', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    const confirmedRecord = emergencyRecordWithPeople(
      'rec-response-missing-id',
      TARGET_DATE_TIMESTAMP,
      [ACTIVE_PERSON.openId],
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([confirmedRecord]);
    mockedReadLatestSnapshot.mockResolvedValue(snapshot([confirmedRecord]));
    axiosPost.mockImplementation(
      async (url: string, body: Record<string, unknown>) => {
        if (url.includes('/auth/v3/tenant_access_token/internal')) {
          return {
            status: 200,
            data: {
              code: 0,
              tenant_access_token: 'tenant-token-private',
              expire: 7200,
            },
          };
        }
        if (url.endsWith('/records')) {
          return {
            status: 200,
            data: { code: 0, data: { record: { fields: body.fields } } },
          };
        }
        throw new Error(`Unexpected POST ${url}`);
      },
    );

    await expect(
      service.upsertSchedule({
        date: TARGET_DATE,
        personKeys: [personKey],
        clientMutationId: `${CLIENT_MUTATION_ID}-missing-record-id`,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          recordId: 'rec-response-missing-id',
        }),
        syncStatus: 'synced',
      }),
    );
    expect(
      axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/records')),
    ).toHaveLength(1);
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(2);
  });

  it('confirms a create that commits before a network timeout without writing twice', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    const confirmedRecord = emergencyRecordWithPeople(
      'rec-created-after-timeout',
      TARGET_DATE_TIMESTAMP,
      [ACTIVE_PERSON.openId],
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([confirmedRecord]);
    mockedReadLatestSnapshot.mockResolvedValue(snapshot([confirmedRecord]));
    axiosPost.mockImplementation(
      async (url: string, body: Record<string, unknown>) => {
        if (url.includes('/auth/v3/tenant_access_token/internal')) {
          return {
            status: 200,
            data: {
              code: 0,
              tenant_access_token: 'tenant-token-private',
              expire: 7200,
            },
          };
        }
        if (url.endsWith('/records')) {
          throw Object.assign(new Error('timeout after upstream commit'), {
            code: 'ECONNABORTED',
          });
        }
        throw new Error(`Unexpected POST ${url}: ${JSON.stringify(body)}`);
      },
    );

    await expect(
      service.upsertSchedule({
        date: TARGET_DATE,
        personKeys: [personKey],
        clientMutationId: `${CLIENT_MUTATION_ID}-create-timeout`,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          recordId: 'rec-created-after-timeout',
          building: null,
        }),
        syncStatus: 'synced',
      }),
    );
    expect(
      axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/records')),
    ).toHaveLength(1);
    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(2);
  });

  it('confirms an update timeout only against the known record id and cleared building', async () => {
    const personKey = await getPersonKey(service, SECOND_ACTIVE_PERSON.name);
    const confirmedRecord = emergencyRecordWithPeople(
      'rec-existing',
      TARGET_DATE_TIMESTAMP,
      [SECOND_ACTIVE_PERSON.openId],
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([
        emergencyRecord('rec-existing', TARGET_DATE_TIMESTAMP, {
          值守机楼: 'A楼',
        }),
      ])
      .mockResolvedValueOnce([confirmedRecord]);
    mockedReadLatestSnapshot.mockResolvedValue(snapshot([confirmedRecord]));
    axiosPut.mockRejectedValue(
      Object.assign(new Error('socket timed out after commit'), {
        code: 'ETIMEDOUT',
      }),
    );

    const result = await service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: `${CLIENT_MUTATION_ID}-update-timeout`,
    });

    expect(result).toEqual(
      expect.objectContaining({
        record: expect.objectContaining({ recordId: 'rec-existing' }),
        syncStatus: 'synced',
      }),
    );
    expect(axiosPut).toHaveBeenCalledTimes(1);
    expect(axiosPut.mock.calls[0]?.[1]).toEqual({
      fields: {
        排班日期: TARGET_DATE_TIMESTAMP,
        值班人员: [{ id: SECOND_ACTIVE_PERSON.openId }],
        值守机楼: null,
      },
    });
  });

  it.each([
    ['does not confirm the record', false],
    ['cannot complete the forced readback', true],
  ])(
    'returns unknown-result when a timed-out create %s',
    async (_label, readbackFails) => {
      const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
      mockedFetchBitableRecords.mockResolvedValueOnce([]);
      if (readbackFails) {
        mockedFetchBitableRecords.mockRejectedValueOnce(
          new Error('private readback detail open_id=ou_sensitive_private'),
        );
      } else {
        mockedFetchBitableRecords.mockResolvedValueOnce([]);
      }
      axiosPost.mockImplementation(
        async (url: string, body: Record<string, unknown>) => {
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            return {
              status: 200,
              data: {
                code: 0,
                tenant_access_token: 'tenant-token-private',
                expire: 7200,
              },
            };
          }
          if (url.endsWith('/records')) {
            throw Object.assign(new Error('network timeout'), {
              code: 'ETIMEDOUT',
            });
          }
          throw new Error(`Unexpected POST ${url}: ${JSON.stringify(body)}`);
        },
      );

      const error = await service
        .upsertSchedule({
          date: TARGET_DATE,
          personKeys: [personKey],
          clientMutationId: `${CLIENT_MUTATION_ID}-${readbackFails ? 'failed' : 'missing'}-readback`,
        })
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toEqual({
        message: '应急值班写入结果暂未确认，请使用原调整标识安全重试',
        writeDisposition: 'unknown-result',
      });
      expect(
        JSON.stringify((error as ServiceUnavailableException).getResponse()),
      ).not.toContain('open_id');
      expect(
        axiosPost.mock.calls.filter(([url]) =>
          String(url).endsWith('/records'),
        ),
      ).toHaveLength(1);
      expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(2);
    },
  );

  it('returns unknown-result when an update timeout readback still has a building', async () => {
    const personKey = await getPersonKey(service, SECOND_ACTIVE_PERSON.name);
    const staleBuildingRecord = emergencyRecord(
      'rec-existing',
      TARGET_DATE_TIMESTAMP,
      {
        值班人员: [{ id: SECOND_ACTIVE_PERSON.openId }],
        值守机楼: 'A楼',
      },
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([
        emergencyRecord('rec-existing', TARGET_DATE_TIMESTAMP, {
          值守机楼: 'A楼',
        }),
      ])
      .mockResolvedValueOnce([staleBuildingRecord]);
    axiosPut.mockRejectedValue(
      Object.assign(new Error('timeout after update commit'), {
        code: 'ECONNRESET',
      }),
    );

    const error = await service
      .upsertSchedule({
        date: TARGET_DATE,
        personKeys: [personKey],
        clientMutationId: `${CLIENT_MUTATION_ID}-uncleared-building`,
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      message: '应急值班写入结果暂未确认，请使用原调整标识安全重试',
      writeDisposition: 'unknown-result',
    });
    expect(axiosPut).toHaveBeenCalledTimes(1);
  });

  it('reconciles a canonical record on retry without issuing a second write', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    const canonicalRecord = emergencyRecordWithPeople(
      'rec-visible-on-retry',
      TARGET_DATE_TIMESTAMP,
      [ACTIVE_PERSON.openId],
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([canonicalRecord]);
    mockedReadLatestSnapshot.mockResolvedValue(snapshot([canonicalRecord]));
    axiosPost.mockImplementation(
      async (url: string, body: Record<string, unknown>) => {
        if (url.includes('/auth/v3/tenant_access_token/internal')) {
          return {
            status: 200,
            data: {
              code: 0,
              tenant_access_token: 'tenant-token-private',
              expire: 7200,
            },
          };
        }
        if (url.endsWith('/records')) {
          throw Object.assign(new Error('network timeout'), {
            code: 'ETIMEDOUT',
          });
        }
        throw new Error(`Unexpected POST ${url}: ${JSON.stringify(body)}`);
      },
    );
    const request = {
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: `${CLIENT_MUTATION_ID}-retry-reconcile`,
    };

    await expect(service.upsertSchedule(request)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.upsertSchedule(request)).resolves.toEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          recordId: 'rec-visible-on-retry',
        }),
        syncStatus: 'synced',
      }),
    );
    expect(
      axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/records')),
    ).toHaveLength(1);
    expect(axiosPut).not.toHaveBeenCalled();
  });

  it('does not log a raw upstream payload when post-write refresh fails', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
      mockedFetchBitableRecords
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(
          new Error('upstream-secret open_id=ou_sensitive_private'),
        );

      const result = await service.upsertSchedule({
        date: TARGET_DATE,
        personKeys: [personKey],
        clientMutationId: CLIENT_MUTATION_ID,
      });

      expect(result.syncStatus).toBe('cache_refresh_pending');
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain('upstream-secret');
      expect(logged).not.toContain('open_id');
      expect(logged).not.toContain('ou_sensitive_private');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns cache_refresh_pending when the resolved refresh omits the written record', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockedReadLatestSnapshot.mockResolvedValue(
      snapshot([
        emergencyRecordWithPeople('rec-created', TARGET_DATE_TIMESTAMP, [
          ACTIVE_PERSON.openId,
        ]),
      ]),
    );

    const result = await service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: CLIENT_MUTATION_ID,
    });

    expect(result.syncStatus).toBe('cache_refresh_pending');
  });

  it('returns cache_refresh_pending when refreshed personnel do not match the write', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        emergencyRecordWithPeople('rec-created', TARGET_DATE_TIMESTAMP, [
          SECOND_ACTIVE_PERSON.openId,
        ]),
      ]);

    const result = await service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: CLIENT_MUTATION_ID,
    });

    expect(result.syncStatus).toBe('cache_refresh_pending');
  });

  it('returns cache_refresh_pending when the persisted snapshot omits the written record id', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    const confirmedRemote = emergencyRecordWithPeople(
      'rec-created',
      TARGET_DATE_TIMESTAMP,
      [ACTIVE_PERSON.openId],
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([confirmedRemote]);
    mockedReadLatestSnapshot.mockResolvedValue(
      snapshot([
        emergencyRecordWithPeople('rec-other', TARGET_DATE_TIMESTAMP, [
          ACTIVE_PERSON.openId,
        ]),
      ]),
    );

    const result = await service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: CLIENT_MUTATION_ID,
    });

    expect(result.syncStatus).toBe('cache_refresh_pending');
  });

  it('returns synced only after remote and persisted snapshots confirm the canonical write', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    const confirmedRecord = emergencyRecordWithPeople(
      'rec-created',
      TARGET_DATE_TIMESTAMP,
      [ACTIVE_PERSON.openId],
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([confirmedRecord]);
    mockedReadLatestSnapshot.mockResolvedValue(snapshot([confirmedRecord]));

    const result = await service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: CLIENT_MUTATION_ID,
    });

    expect(result.syncStatus).toBe('synced');
    expect(mockedReadLatestSnapshot).toHaveBeenCalledWith({
      tableId: 'tblnGg3s3lgn6Plq',
      viewId: 'vewgzik2Nv',
      tableName: '应急值班',
      fieldNames: ['值守机楼', '值班人员', '排班日期'],
    });
  });

  it('coalesces duplicate in-flight client mutation ids into one remote write', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    let releaseLookup: ((records: BitableRecordItem[]) => void) | undefined;
    let markLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    mockedFetchBitableRecords
      .mockImplementationOnce(() => {
        markLookupStarted?.();
        return new Promise<BitableRecordItem[]>((resolve) => {
          releaseLookup = resolve;
        });
      })
      .mockResolvedValueOnce([
        emergencyRecord('rec-created', TARGET_DATE_TIMESTAMP),
      ]);
    const request = {
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: CLIENT_MUTATION_ID,
    };

    const first = service.upsertSchedule(request);
    const duplicate = service.upsertSchedule(request);
    await lookupStarted;
    releaseLookup?.([]);

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ clientMutationId: CLIENT_MUTATION_ID }),
      expect.objectContaining({ clientMutationId: CLIENT_MUTATION_ID }),
    ]);
    expect(
      axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/records')),
    ).toHaveLength(1);
  });

  it('serializes different mutations for the same date', async () => {
    const firstPersonKey = await getPersonKey(service, ACTIVE_PERSON.name);
    const secondPersonKey = await getPersonKey(
      service,
      SECOND_ACTIVE_PERSON.name,
    );
    const createdRecord = emergencyRecordWithPeople(
      'rec-created',
      TARGET_DATE_TIMESTAMP,
      [ACTIVE_PERSON.openId],
    );
    const updatedRecord = emergencyRecordWithPeople(
      'rec-created',
      TARGET_DATE_TIMESTAMP,
      [SECOND_ACTIVE_PERSON.openId],
    );
    let releaseFirstLookup:
      | ((records: BitableRecordItem[]) => void)
      | undefined;
    let markFirstLookupStarted: (() => void) | undefined;
    const firstLookupStarted = new Promise<void>((resolve) => {
      markFirstLookupStarted = resolve;
    });
    mockedFetchBitableRecords
      .mockImplementationOnce(() => {
        markFirstLookupStarted?.();
        return new Promise<BitableRecordItem[]>((resolve) => {
          releaseFirstLookup = resolve;
        });
      })
      .mockResolvedValueOnce([createdRecord])
      .mockResolvedValueOnce([createdRecord])
      .mockResolvedValueOnce([updatedRecord]);
    mockedReadLatestSnapshot
      .mockResolvedValueOnce(snapshot([createdRecord]))
      .mockResolvedValueOnce(snapshot([updatedRecord]));

    const first = service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [firstPersonKey],
      clientMutationId: `${CLIENT_MUTATION_ID}-first`,
    });
    const second = service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [secondPersonKey],
      clientMutationId: `${CLIENT_MUTATION_ID}-second`,
    });
    await firstLookupStarted;

    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(1);
    expect(axiosPut).not.toHaveBeenCalled();
    releaseFirstLookup?.([]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        record: expect.objectContaining({ recordId: 'rec-created' }),
        syncStatus: 'synced',
      }),
      expect.objectContaining({
        record: expect.objectContaining({ recordId: 'rec-created' }),
        syncStatus: 'synced',
      }),
    ]);
    expect(
      axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/records')),
    ).toHaveLength(1);
    expect(axiosPut).toHaveBeenCalledTimes(1);
  });

  it('serializes mutations across different dates on the same Base table', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    let releaseFirstLookup:
      | ((records: BitableRecordItem[]) => void)
      | undefined;
    let markFirstLookupStarted: (() => void) | undefined;
    const firstLookupStarted = new Promise<void>((resolve) => {
      markFirstLookupStarted = resolve;
    });
    mockedFetchBitableRecords
      .mockImplementationOnce(() => {
        markFirstLookupStarted?.();
        return new Promise<BitableRecordItem[]>((resolve) => {
          releaseFirstLookup = resolve;
        });
      })
      .mockResolvedValue([]);

    const first = service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: `${CLIENT_MUTATION_ID}-table-first`,
    });
    const second = service.upsertSchedule({
      date: '2026-08-10',
      personKeys: [personKey],
      clientMutationId: `${CLIENT_MUTATION_ID}-table-second`,
    });
    await firstLookupStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(1);
    expect(
      axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/records')),
    ).toHaveLength(0);
    releaseFirstLookup?.([]);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(
      axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/records')),
    ).toHaveLength(2);
  });

  it('releases the table mutation queue after a failed operation', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    let rejectFirstLookup: ((error: Error) => void) | undefined;
    let markFirstLookupStarted: (() => void) | undefined;
    const firstLookupStarted = new Promise<void>((resolve) => {
      markFirstLookupStarted = resolve;
    });
    mockedFetchBitableRecords
      .mockImplementationOnce(() => {
        markFirstLookupStarted?.();
        return new Promise<BitableRecordItem[]>((_resolve, reject) => {
          rejectFirstLookup = reject;
        });
      })
      .mockResolvedValue([]);

    const first = service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: `${CLIENT_MUTATION_ID}-table-failed`,
    });
    const second = service.upsertSchedule({
      date: '2026-08-10',
      personKeys: [personKey],
      clientMutationId: `${CLIENT_MUTATION_ID}-table-after-failure`,
    });
    await firstLookupStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockedFetchBitableRecords).toHaveBeenCalledTimes(1);
    rejectFirstLookup?.(new Error('first lookup failed'));

    const firstError = await first.catch((cause: unknown) => cause);
    expect(firstError).toBeInstanceOf(ServiceUnavailableException);
    expect((firstError as Error).message).toBe(
      '应急值班远端记录读取失败，本次未写入',
    );
    expect(getWriteDisposition(firstError)).toBe('definitely-not-written');
    await expect(second).resolves.toEqual(
      expect.objectContaining({
        clientMutationId: `${CLIENT_MUTATION_ID}-table-after-failure`,
      }),
    );
    expect(
      axiosPost.mock.calls.filter(([url]) => String(url).endsWith('/records')),
    ).toHaveLength(1);
  });

  it('replays a completed mutation without repeating external work', async () => {
    const personKey = await getPersonKey(service, ACTIVE_PERSON.name);
    const confirmedRecord = emergencyRecordWithPeople(
      'rec-created',
      TARGET_DATE_TIMESTAMP,
      [ACTIVE_PERSON.openId],
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([confirmedRecord]);
    mockedReadLatestSnapshot.mockResolvedValue(snapshot([confirmedRecord]));
    const request = {
      date: TARGET_DATE,
      personKeys: [personKey],
      clientMutationId: CLIENT_MUTATION_ID,
    };

    const first = await service.upsertSchedule(request);
    const externalCallCounts = {
      directory: getCachedActivePersonnelDirectory.mock.calls.length,
      fetch: mockedFetchBitableRecords.mock.calls.length,
      persistedRead: mockedReadLatestSnapshot.mock.calls.length,
      post: axiosPost.mock.calls.length,
      put: axiosPut.mock.calls.length,
      resolveApp: mockedResolveBitableAppToken.mock.calls.length,
    };
    const replay = await service.upsertSchedule(request);

    expect(replay).toEqual(first);
    expect({
      directory: getCachedActivePersonnelDirectory.mock.calls.length,
      fetch: mockedFetchBitableRecords.mock.calls.length,
      persistedRead: mockedReadLatestSnapshot.mock.calls.length,
      post: axiosPost.mock.calls.length,
      put: axiosPut.mock.calls.length,
      resolveApp: mockedResolveBitableAppToken.mock.calls.length,
    }).toEqual(externalCallCounts);
  });

  it('rejects a completed mutation id reused with a different payload before external work', async () => {
    const firstPersonKey = await getPersonKey(service, ACTIVE_PERSON.name);
    const secondPersonKey = await getPersonKey(
      service,
      SECOND_ACTIVE_PERSON.name,
    );
    const confirmedRecord = emergencyRecordWithPeople(
      'rec-created',
      TARGET_DATE_TIMESTAMP,
      [ACTIVE_PERSON.openId],
    );
    mockedFetchBitableRecords
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([confirmedRecord]);
    mockedReadLatestSnapshot.mockResolvedValue(snapshot([confirmedRecord]));
    await service.upsertSchedule({
      date: TARGET_DATE,
      personKeys: [firstPersonKey],
      clientMutationId: CLIENT_MUTATION_ID,
    });
    const externalCallCounts = {
      directory: getCachedActivePersonnelDirectory.mock.calls.length,
      fetch: mockedFetchBitableRecords.mock.calls.length,
      post: axiosPost.mock.calls.length,
      put: axiosPut.mock.calls.length,
    };

    const error = await service
      .upsertSchedule({
        date: TARGET_DATE,
        personKeys: [secondPersonKey],
        clientMutationId: CLIENT_MUTATION_ID,
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictException);
    expect(getWriteDisposition(error)).toBe('definitely-not-written');
    expect({
      directory: getCachedActivePersonnelDirectory.mock.calls.length,
      fetch: mockedFetchBitableRecords.mock.calls.length,
      post: axiosPost.mock.calls.length,
      put: axiosPut.mock.calls.length,
    }).toEqual(externalCallCounts);
  });

  it('prewarms immediately, refreshes every configured 15 minutes, and clears the timer', async () => {
    const previousRefreshMs =
      process.env.FEISHU_EMERGENCY_DUTY_CACHE_REFRESH_MS;
    process.env.FEISHU_EMERGENCY_DUTY_CACHE_REFRESH_MS = String(
      DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS,
    );
    const lifecycleService = createService();
    jest.useFakeTimers();
    const refreshSpy = jest
      .spyOn(lifecycleService, 'refreshCache')
      .mockResolvedValue([]);

    try {
      lifecycleService.onModuleInit();
      lifecycleService.onModuleInit();
      expect(refreshSpy).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(
        DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS - 1,
      );
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(refreshSpy).toHaveBeenCalledTimes(2);

      lifecycleService.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(
        DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS * 2,
      );
      expect(refreshSpy).toHaveBeenCalledTimes(2);
    } finally {
      lifecycleService.onModuleDestroy();
      jest.useRealTimers();
      if (previousRefreshMs === undefined) {
        delete process.env.FEISHU_EMERGENCY_DUTY_CACHE_REFRESH_MS;
      } else {
        process.env.FEISHU_EMERGENCY_DUTY_CACHE_REFRESH_MS = previousRefreshMs;
      }
    }
  });

  it.each(['invalid', '59999', '2147483648'])(
    'falls back to the default refresh interval for invalid or unsafe value %s',
    (configuredValue) => {
      const previousRefreshMs =
        process.env.FEISHU_EMERGENCY_DUTY_CACHE_REFRESH_MS;
      process.env.FEISHU_EMERGENCY_DUTY_CACHE_REFRESH_MS = configuredValue;
      jest.useFakeTimers();
      const intervalSpy = jest.spyOn(global, 'setInterval');
      const lifecycleService = createService();
      const refreshSpy = jest
        .spyOn(lifecycleService, 'refreshCache')
        .mockResolvedValue([]);

      try {
        lifecycleService.onModuleInit();

        expect(intervalSpy).toHaveBeenCalledWith(
          expect.any(Function),
          DEFAULT_EMERGENCY_DUTY_CACHE_REFRESH_MS,
        );
      } finally {
        lifecycleService.onModuleDestroy();
        intervalSpy.mockRestore();
        jest.useRealTimers();
        refreshSpy.mockRestore();
        if (previousRefreshMs === undefined) {
          delete process.env.FEISHU_EMERGENCY_DUTY_CACHE_REFRESH_MS;
        } else {
          process.env.FEISHU_EMERGENCY_DUTY_CACHE_REFRESH_MS =
            previousRefreshMs;
        }
      }
    },
  );
});

describe('EmergencyDutyController', () => {
  it('exposes the exact emergency duty routes', () => {
    const source = readFileSync(
      require.resolve('./emergency-duty.controller'),
      'utf8',
    );
    expect(source).toContain(
      "@Controller('api/duty-schedules/emergency-duty')",
    );
    expect(source).toMatch(/@Get\(\)\s+@GuestReadable\(\)\s+getSchedules\(/);
    expect(source).toMatch(/@Get\('options'\)\s+getOptions\(/);
    expect(source).toMatch(/@Post\(\)\s+upsertSchedule\(/);
  });

  it('marks only the schedule GET as guest-readable', () => {
    expect(
      Reflect.getMetadata(
        GuestReadableMetadataKey,
        EmergencyDutyController.prototype.getSchedules,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        GuestReadableMetadataKey,
        EmergencyDutyController.prototype.getOptions,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        GuestReadableMetadataKey,
        EmergencyDutyController.prototype.upsertSchedule,
      ),
    ).toBeUndefined();
  });

  it('delegates query and mutation payloads to the emergency duty service', async () => {
    const scheduleResponse = {
      schedules: [],
      snapshot: {
        fetchedAt: '2026-08-09T01:00:00.000Z',
        expiresAt: '2026-08-09T01:15:00.000Z',
        stale: false,
      },
    };
    const optionsResponse = { options: [] };
    const upsertRequest = {
      date: TARGET_DATE,
      personKeys: ['opaque-key'],
      clientMutationId: CLIENT_MUTATION_ID,
    };
    const upsertResponse = {
      record: {
        recordId: 'rec-created',
        date: TARGET_DATE,
        people: [],
        building: null,
      },
      syncStatus: 'synced' as const,
      clientMutationId: CLIENT_MUTATION_ID,
    };
    const emergencyDutyService = {
      getSchedules: jest.fn().mockResolvedValue(scheduleResponse),
      getOptions: jest.fn().mockResolvedValue(optionsResponse),
      upsertSchedule: jest.fn().mockResolvedValue(upsertResponse),
    };
    const controller = new EmergencyDutyController(
      emergencyDutyService as unknown as EmergencyDutyService,
    );

    await expect(
      controller.getSchedules('2026-08-01', '2026-08-31'),
    ).resolves.toBe(scheduleResponse);
    await expect(controller.getOptions()).resolves.toBe(optionsResponse);
    await expect(controller.upsertSchedule(upsertRequest)).resolves.toBe(
      upsertResponse,
    );
    expect(emergencyDutyService.getSchedules).toHaveBeenCalledWith(
      '2026-08-01',
      '2026-08-31',
    );
    expect(emergencyDutyService.upsertSchedule).toHaveBeenCalledWith(
      upsertRequest,
    );
  });
});

async function getPersonKey(
  service: EmergencyDutyService,
  name: string,
): Promise<string> {
  const option = (await service.getOptions()).options.find(
    (candidate) => candidate.name === name,
  );
  if (!option) throw new Error(`Missing test person option: ${name}`);
  return option.key;
}

function activeDirectory(
  personnel: ActivePersonnelDirectory['personnel'],
): ActivePersonnelDirectory {
  return {
    personnel: [...personnel],
    managers: personnel.filter(
      (person) => person.systemPosition === '运维经理',
    ),
    snapshot: {
      fetchedAt: Date.parse('2026-08-09T01:00:00.000Z'),
      expiresAt: Date.parse('2026-08-09T01:15:00.000Z'),
      stale: false,
    },
    quality: {
      sourceRecordCount: personnel.length,
      activeRecordCount: personnel.length,
      inactiveRecordCount: 0,
      usablePersonnelCount: personnel.length,
      managerCount: personnel.filter(
        (person) => person.systemPosition === '运维经理',
      ).length,
      missingNameCount: 0,
      missingOpenIdCount: 0,
      duplicateOpenIdCount: 0,
      missingBuildingCount: 0,
    },
  };
}

function snapshot(
  records: BitableRecordItem[],
): PersistedBitableRecordSnapshot {
  return {
    records,
    fetchedAt: Date.parse('2026-08-09T01:00:00.000Z'),
    expiresAt: Date.parse('2026-08-09T01:15:00.000Z'),
  };
}

function emergencyRecord(
  recordId: string,
  date: number,
  fieldOverrides: Record<string, unknown> = {},
  lastModifiedTime = date,
): BitableRecordItem {
  return {
    record_id: recordId,
    last_modified_time: lastModifiedTime,
    fields: {
      排班日期: date,
      值班人员: [],
      值守机楼: null,
      ...fieldOverrides,
    },
  };
}

function emergencyRecordWithPeople(
  recordId: string,
  date: number,
  openIds: string[],
): BitableRecordItem {
  return emergencyRecord(recordId, date, {
    值班人员: openIds.map((id) => ({ id })),
  });
}
