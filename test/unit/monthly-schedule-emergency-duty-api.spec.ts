jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn(), warn: jest.fn() } }),
  { virtual: true },
);

jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({ axiosForBackend: jest.fn() }),
  { virtual: true },
);

jest.mock('../../client/src/access/access-events', () => ({
  dispatchAccessInvalidated: jest.fn(),
}));

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { upsertEmergencyDutySchedule } from '../../client/src/api';
import {
  beginEmergencyDutyMutation,
  classifyEmergencyDutyMutationError,
  getEmergencyDutyByDate,
  resolveEmergencyDutyMutationFailure,
  resolveEmergencyDutyMutationSuccess,
} from '../../client/src/pages/MonthlySchedule/emergency-duty-state';
import type {
  EmergencyDutyPersonOption,
  EmergencyDutyUpsertRequest,
  EmergencyDutyUpsertResponse,
} from '../../shared/emergency-duty.interface';

const request: EmergencyDutyUpsertRequest = {
  date: '2026-08-10',
  personKeys: ['person-a'],
  clientMutationId: 'mutation-emergency-api-a',
};

const person: EmergencyDutyPersonOption = {
  key: 'person-a',
  name: '示例人员016',
  role: '运维值班员',
};

const otherPerson: EmergencyDutyPersonOption = {
  key: 'person-b',
  name: '示例人员004员',
  role: '运维值班员',
};

const successResponse: EmergencyDutyUpsertResponse = {
  clientMutationId: request.clientMutationId,
  syncStatus: 'synced',
  record: {
    recordId: 'rec-emergency-a',
    date: request.date,
    people: [person],
    building: null,
  },
};

describe('monthly schedule emergency-duty client API', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a minimally valid 2xx upsert response', async () => {
    const transportResponse = { status: 200, data: successResponse };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce(transportResponse);

    await expect(upsertEmergencyDutySchedule(request)).resolves.toBe(
      successResponse,
    );
    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/duty-schedules/emergency-duty',
      method: 'POST',
      data: request,
      signal: undefined,
      timeout: 60_000,
    });
  });

  it('compares canonical people against the deduplicated request key set', async () => {
    const duplicatedRequest = {
      ...request,
      personKeys: [person.key, person.key],
    };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: successResponse,
    });

    await expect(upsertEmergencyDutySchedule(duplicatedRequest)).resolves.toBe(
      successResponse,
    );
  });

  it('rejects a toolkit-fulfilled 403 and preserves its definite response contract', async () => {
    const transportResponse = {
      status: 403,
      data: {
        success: false,
        message: '无权调整应急值班',
        writeDisposition: 'definitely-not-written',
      },
    };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce(transportResponse);

    const error = await upsertEmergencyDutySchedule(request).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      message: 'HTTP 403',
      response: transportResponse,
    });
    expect(classifyEmergencyDutyMutationError(error)).toBe(
      'definitely-not-written',
    );
  });

  it.each([
    ['missing record', { ...successResponse, record: undefined }],
    ['invalid mutation id', { ...successResponse, clientMutationId: '' }],
    ['invalid sync status', { ...successResponse, syncStatus: 'completed' }],
    [
      'wrong people',
      {
        ...successResponse,
        record: { ...successResponse.record, people: [otherPerson] },
      },
    ],
    [
      'missing people',
      {
        ...successResponse,
        record: { ...successResponse.record, people: [] },
      },
    ],
    [
      'duplicate people',
      {
        ...successResponse,
        record: { ...successResponse.record, people: [person, { ...person }] },
      },
    ],
    [
      'extra people',
      {
        ...successResponse,
        record: { ...successResponse.record, people: [person, otherPerson] },
      },
    ],
    [
      'empty person key',
      {
        ...successResponse,
        record: {
          ...successResponse.record,
          people: [{ ...person, key: ' ' }],
        },
      },
    ],
    [
      'empty person name or role',
      {
        ...successResponse,
        record: {
          ...successResponse.record,
          people: [{ ...person, name: '', role: ' ' }],
        },
      },
    ],
    [
      'non-null building',
      {
        ...successResponse,
        record: { ...successResponse.record, building: 'A楼' },
      },
    ],
  ])(
    'rejects a malformed 2xx response with unknown-result: %s',
    async (_label, malformedData) => {
      const transportResponse = { status: 200, data: malformedData };
      (axiosForBackend as jest.Mock).mockResolvedValueOnce(transportResponse);

      const error = await upsertEmergencyDutySchedule(request).catch(
        (cause: unknown) => cause,
      );

      expect(error).toMatchObject({
        response: transportResponse,
        writeDisposition: 'unknown-result',
      });
      expect(classifyEmergencyDutyMutationError(error)).toBe('unknown-result');
    },
  );

  it('routes a malformed 2xx through failure recovery without clearing retry binding or showing success', async () => {
    const transportResponse = {
      status: 200,
      data: {
        ...successResponse,
        record: { ...successResponse.record, people: [otherPerson] },
      },
    };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce(transportResponse);
    const started = beginEmergencyDutyMutation(new Map(), {
      date: request.date,
      people: [person],
      clientMutationId: request.clientMutationId,
    });
    const bindings = new Map([[request.date, started.binding]]);
    const successToast = jest.fn();
    let index = started.index;

    try {
      const response = await upsertEmergencyDutySchedule(request);
      index = resolveEmergencyDutyMutationSuccess(
        index,
        started.binding,
        response,
      );
      bindings.delete(request.date);
      successToast();
    } catch (error) {
      const resolved = resolveEmergencyDutyMutationFailure(
        index,
        started.binding,
        classifyEmergencyDutyMutationError(error),
      );
      index = resolved.index;
      if (resolved.restoreDraft) bindings.delete(request.date);
    }

    expect(successToast).not.toHaveBeenCalled();
    expect(bindings.get(request.date)).toBe(started.binding);
    expect(getEmergencyDutyByDate(index, request.date)).toMatchObject({
      syncState: 'unknown-result',
      people: [person],
    });
  });
});
