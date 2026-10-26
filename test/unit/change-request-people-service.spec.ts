import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';
import { listChangeRequestSubmitters } from '../../server/modules/bitable-sync/change-request-submitter-directory';

const record = (id: number) => ({
  record_id: `rec${id}`,
  fields: {
    姓名: `示例人员016${id}`,
    员工姓名: [{ id: `ou_test${id}`, name: `示例人员016${id}` }],
  },
});

describe('change request people service', () => {
  function fixture() {
    const service = Object.create(
      DutyScheduleService.prototype,
    ) as DutyScheduleService;
    const internals = service as unknown as {
      readChangeRequestSubmitterRecords: jest.Mock;
      readActiveChangeRequestUserIds: jest.Mock;
      resolveChangeRequestSubmitter: (
        name: string,
        id?: string,
      ) => Promise<{ userId: string }>;
      normalizeChangeRequest: (request: unknown) => unknown;
      buildChangeRequestMutationFingerprint: (
        request: unknown,
        files: unknown[],
      ) => string;
    };
    const records = Array.from({ length: 120 }, (_, id) => record(id));
    internals.readChangeRequestSubmitterRecords = jest
      .fn()
      .mockResolvedValue(records);
    internals.readActiveChangeRequestUserIds = jest
      .fn()
      .mockResolvedValue(new Set(records.map((_, id) => `ou_test${id}`)));
    return { service, internals, records };
  }

  it('does not read or return the full directory for an empty query', async () => {
    const { service, internals } = fixture();
    expect((await service.searchChangeRequestPeople(' ')).people).toEqual([]);
    expect(internals.readChangeRequestSubmitterRecords).not.toHaveBeenCalled();
  });

  it('caps results at twenty and excludes inactive accounts', async () => {
    const { service, internals } = fixture();
    expect(
      (await service.searchChangeRequestPeople('测试')).people,
    ).toHaveLength(20);
    internals.readActiveChangeRequestUserIds.mockResolvedValue(
      new Set(['ou_test1']),
    );
    expect(
      (await service.searchChangeRequestPeople('测试')).people.map(
        (person) => person.name,
      ),
    ).toEqual(['示例人员0161']);
    await expect(
      service.searchChangeRequestPeople('张'.repeat(65)),
    ).rejects.toThrow('最多');
  });

  it('uses the stable ID and rechecks name and active status when submitting', async () => {
    const { internals, records } = fixture();
    const id = listChangeRequestSubmitters([records[1]])[0].id;
    await expect(
      internals.resolveChangeRequestSubmitter('示例人员0161', id),
    ).resolves.toEqual({ userId: 'ou_test1' });
    await expect(
      internals.resolveChangeRequestSubmitter('示例人员0162', id),
    ).rejects.toThrow('身份');
    internals.readActiveChangeRequestUserIds.mockResolvedValue(new Set());
    await expect(
      internals.resolveChangeRequestSubmitter('示例人员0161', id),
    ).rejects.toThrow('在职');
  });

  it('does not accept a person if the authoritative cache is unavailable', async () => {
    const { service, internals } = fixture();
    internals.readActiveChangeRequestUserIds.mockRejectedValue(
      new Error('cache unavailable'),
    );
    await expect(service.searchChangeRequestPeople('测试')).rejects.toThrow(
      'cache unavailable',
    );
  });

  it('binds the selected stable person ID into the durable mutation fingerprint', () => {
    const { internals, records } = fixture();
    const request = {
      clientMutationId: 'change-request-123e4567-e89b-42d3-a456-426614174000',
      submitterName: '示例人员0161',
      submitterId: listChangeRequestSubmitters([records[1]])[0].id,
      nature: '标准变更',
      summary: 'TEST',
      riskSummary: 'TEST',
      buildings: ['A楼'],
      plannedStartAt: '2026-09-20T09:00',
      plannedEndAt: '2026-09-20T10:00',
    };
    const normalized = internals.normalizeChangeRequest(request);
    expect(normalized).toMatchObject({ submitterId: request.submitterId });
    expect(
      internals.buildChangeRequestMutationFingerprint(normalized, []),
    ).not.toBe(
      internals.buildChangeRequestMutationFingerprint(
        {
          ...request,
          submitterId: listChangeRequestSubmitters([records[2]])[0].id,
        },
        [],
      ),
    );
  });
});
