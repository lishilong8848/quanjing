import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  WeatherGuardRegistrationRequest,
  WeatherWarningGuardLevel,
  WeatherWarningSnapshot,
} from '../../shared/api.interface';

const mockRegistrationFields = {
  date: '日期',
  checker: '检查人',
  manager: '机房经理',
  guard: '重保戒备等级',
  device: '检查设备安全项',
  deviceImage: '设备安全检查纸质图片',
  deviceIssue: '设备异常描述',
  disaster: '检查灾害专项',
  disasterImage: '灾害专项检查纸质图片',
  disasterIssue: '灾害异常描述',
  environment: '检查环境安全项',
  environmentImage: '环境安全检查纸质图片',
  environmentIssue: '环境异常描述',
  materials: '检查重保物资清单正常',
  materialsIssue: '重保物资异常描述',
  contacts: '检查重保联络清单人员齐备',
  contactsIssue: '联络清单异常描述',
  building: '楼栋',
  tag: '重保标签',
  managerConfirmation: '机房经理确认',
} as const;

jest.mock(
  '../../server/modules/weather-warning/weather-warning-registration.config',
  () => ({
    loadWeatherWarningRegistrationRuntimeConfig: () => ({
      appToken: 'app-weather',
      wikiToken: '',
      registrationTableId: 'tblRegistrations',
      registrationFields: mockRegistrationFields,
    }),
  }),
);

import {
  WeatherWarningRegistrationService,
  type WeatherWarningRegistrationSubmitFiles,
} from '../../server/modules/weather-warning/weather-warning-registration.service';
import { createWeatherWarningTestSimulationContext } from '../../server/modules/weather-warning/weather-warning-test-simulation';

const MUTATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const SIMULATION_SECRET =
  'weather-warning-registration-test-simulation-secret-32-bytes';
const ORIGINAL_SIMULATION_SECRET =
  process.env.WEATHER_WARNING_TEST_SIMULATION_SECRET;
const CHECKER_KEY = opaqueCheckerKey('ou_checker_a');
const SECOND_CHECKER_KEY = opaqueCheckerKey('ou_checker_b');

const READBACK_TAMPER_CASES: Array<
  [string, (fields: Record<string, unknown>) => Record<string, unknown>]
> = [
  ['戒备等级', (fields) => ({ ...fields, 重保戒备等级: '一级戒备' })],
  ['重保标签', (fields) => ({ ...fields, 重保标签: '台风红色' })],
  ['设备状态', (fields) => ({ ...fields, 检查设备安全项: '异常' })],
  ['灾害状态', (fields) => ({ ...fields, 检查灾害专项: '异常' })],
  ['环境状态', (fields) => ({ ...fields, 检查环境安全项: '异常' })],
  ['物资状态', (fields) => ({ ...fields, 检查重保物资清单正常: '异常' })],
  ['联络人状态', (fields) => ({ ...fields, 检查重保联络清单人员齐备: '异常' })],
  [
    '设备附件数量',
    (fields) => ({
      ...fields,
      设备安全检查纸质图片: [
        { file_token: 'file-device' },
        { file_token: 'file-device' },
      ],
    }),
  ],
  [
    '灾害附件数量',
    (fields) => ({
      ...fields,
      灾害专项检查纸质图片: [
        { file_token: 'file-disaster' },
        { file_token: 'file-disaster' },
      ],
    }),
  ],
  [
    '环境附件数量',
    (fields) => ({
      ...fields,
      环境安全检查纸质图片: [
        { file_token: 'file-environment' },
        { file_token: 'file-environment' },
      ],
    }),
  ],
  ['经理确认', (fields) => ({ ...fields, 机房经理确认: '未确认' })],
];

describe('WeatherWarningRegistrationService', () => {
  beforeEach(() => {
    process.env.WEATHER_WARNING_TEST_SIMULATION_SECRET = SIMULATION_SECRET;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreEnvironment(
      'WEATHER_WARNING_TEST_SIMULATION_SECRET',
      ORIGINAL_SIMULATION_SECRET,
    );
  });

  it('uses only the cached active-personnel directory for checkers and automatic managers', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const service = serviceWith(snapshotService, gateway);

    const options = await service.getOptions('warning-primary');

    expect(snapshotService.getSnapshot).toHaveBeenCalledWith({
      forceRefresh: true,
    });
    expect(options).toEqual(
      expect.objectContaining({
        dataUpdatedAt: '2026-08-08T01:00:00.000Z',
        guardLevel: '三级戒备',
        environmentRequired: true,
        buildings: ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'],
        checkers: [
          {
            key: CHECKER_KEY,
            name: '检查员甲',
            position: '设施运维工程师',
            buildings: ['A楼', 'H楼'],
          },
          {
            key: SECOND_CHECKER_KEY,
            name: '检查员乙',
            position: '设施运维工程师',
            buildings: ['A楼', 'H楼'],
          },
        ],
        personnelSyncedAt: '2026-08-09T04:24:00.000Z',
        personnelStale: false,
        acceptedImageTypes: [
          'image/png',
          'image/jpeg',
          'image/webp',
          'application/pdf',
        ],
        maxImageBytes: 10 * 1024 * 1024,
      }),
    );
    const serialized = JSON.stringify(options);
    expect(serialized).not.toContain('ou_');
    expect(serialized).not.toContain('token');
    expect(gateway.listCandidateRecords).not.toHaveBeenCalled();
    expect(gateway.listManagerCandidateRecords).not.toHaveBeenCalled();
  });

  it('includes cached active personnel without building metadata in checker options', async () => {
    const directory = activePersonnelDirectory();
    directory.personnel.push({
      recordId: 'rec-checker-no-building',
      name: '检查员无楼栋',
      openId: 'ou_checker_no_building',
      employeeNo: '1003',
      position: '暖通工程师',
      systemPosition: '运维工程师',
      buildings: [],
    });
    const service = serviceWith(
      { getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()) },
      successfulGateway(),
      directory,
    );

    const options = await service.getOptions('warning-primary');

    expect(options.checkers).toContainEqual({
      key: opaqueCheckerKey('ou_checker_no_building'),
      name: '检查员无楼栋',
      position: '暖通工程师',
      buildings: [],
    });
  });

  it('omits cached personnel with an invalid name or open_id from checker options', async () => {
    const directory = activePersonnelDirectory();
    directory.personnel.push(
      {
        ...directory.personnel[0],
        recordId: 'rec-checker-empty-name',
        name: '   ',
        openId: 'ou_checker_empty_name',
      },
      {
        ...directory.personnel[0],
        recordId: 'rec-checker-invalid-open-id',
        name: '检查员无账号',
        openId: 'checker-without-open-id-prefix',
      },
    );
    const service = serviceWith(
      { getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()) },
      successfulGateway(),
      directory,
    );

    const options = await service.getOptions('warning-primary');

    expect(options.checkers.map(({ name }) => name)).toEqual([
      '检查员甲',
      '检查员乙',
    ]);
  });

  it('loads signed full-flow simulation options without reading the live snapshot', async () => {
    const context = createSimulationContext();
    const snapshotService = {
      getSnapshot: jest.fn().mockRejectedValue(new Error('must not be called')),
    };
    const gateway = gatewayWithCandidates(candidateRecords());
    const service = serviceWith(snapshotService, gateway);

    const options = await service.getOptions(context.warningId);

    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(options).toEqual(
      expect.objectContaining({
        dataUpdatedAt: context.openedAt,
        guardLevel: context.snapshot.guardLevel,
        environmentRequired: false,
      }),
    );
    expect(options.warning).toEqual(
      expect.objectContaining({ id: context.warningId }),
    );
    expect(gateway.listCandidateRecords).not.toHaveBeenCalled();
  });

  it('writes both cached machine-room managers without a client selection', async () => {
    const gateway = successfulGateway();
    const service = serviceWith(
      { getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()) },
      gateway,
    );

    await service.submit({
      payload: validPayload(),
      files: evidenceFiles(true),
    });

    expect(gateway.persistedFields[mockRegistrationFields.manager]).toEqual([
      { id: 'ou_manager_a' },
      { id: 'ou_manager_b' },
    ]);
  });

  it('fails closed when the cached directory does not contain both manager roles', async () => {
    const gateway = successfulGateway();
    const directory = activePersonnelDirectory();
    directory.managers = directory.managers.slice(0, 1);
    const service = serviceWith(
      { getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()) },
      gateway,
      directory,
    );

    await expect(service.getOptions('warning-primary')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(gateway.uploadImage).not.toHaveBeenCalled();
  });

  it.each([
    ['more than two', 'extra'],
    ['duplicate open_id', 'duplicate'],
    ['invalid open_id', 'invalid'],
  ] as const)(
    'fails closed when automatic machine-room managers contain %s',
    async (_, scenario) => {
      const gateway = successfulGateway();
      const directory = activePersonnelDirectory();
      if (scenario === 'extra') {
        directory.managers.push({
          ...directory.managers[0],
          recordId: 'rec-manager-c',
          name: '经理丙',
          openId: 'ou_manager_c',
        });
      } else if (scenario === 'duplicate') {
        directory.managers[1].openId = directory.managers[0].openId;
      } else {
        directory.managers[1].openId = 'manager-without-open-id-prefix';
      }
      const service = serviceWith(
        { getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()) },
        gateway,
        directory,
      );

      await expect(
        service.getOptions('warning-primary'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(gateway.uploadImage).not.toHaveBeenCalled();
      expect(gateway.createRecord).not.toHaveBeenCalled();
    },
  );

  it('uploads a PDF scan through the same attachment-token fields', async () => {
    const gateway = successfulGateway();
    const service = serviceWith(
      { getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()) },
      gateway,
    );
    const pdfBuffer = Buffer.from('%PDF-1.7\nscan', 'ascii');

    await service.submit({
      payload: validPayload(),
      files: {
        ...evidenceFiles(true),
        deviceEvidence: {
          originalname: 'device.pdf',
          mimetype: 'application/pdf',
          size: pdfBuffer.length,
          buffer: pdfBuffer,
        },
      },
    });

    expect(gateway.uploadImage).toHaveBeenCalledWith(
      expect.objectContaining({
        originalname: 'device.pdf',
        mimetype: 'application/pdf',
      }),
      expect.any(Object),
    );
    expect(gateway.persistedFields[mockRegistrationFields.deviceImage]).toEqual(
      [{ file_token: 'file-device' }],
    );
  });

  it('rejects a tampered full-flow simulation warning before external work', async () => {
    const context = createSimulationContext();
    const tamperedWarningId = `${context.warningId.slice(0, -1)}${
      context.warningId.endsWith('a') ? 'b' : 'a'
    }`;
    const snapshotService = {
      getSnapshot: jest.fn().mockRejectedValue(new Error('must not be called')),
    };
    const gateway = gatewayWithCandidates(candidateRecords());
    const service = serviceWith(snapshotService, gateway);

    await expect(service.getOptions(tamperedWarningId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(gateway.listCandidateRecords).not.toHaveBeenCalled();
  });

  it('persists an isolated simulation tag, then deletes the exact test record and confirms no residue', async () => {
    const context = createSimulationContext();
    const snapshotService = {
      getSnapshot: jest.fn().mockRejectedValue(new Error('must not be called')),
    };
    const gateway = successfulGateway();
    const service = serviceWith(snapshotService, gateway);

    const result = await service.submit({
      payload: validPayload({ warningId: context.warningId }),
      files: evidenceFiles(true),
    });

    expect(result).toEqual(
      expect.objectContaining({ guardLevel: context.snapshot.guardLevel }),
    );
    expect(gateway.persistedFields[mockRegistrationFields.tag]).toBe(
      context.tag,
    );
    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledTimes(1);
    expect(gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledWith(
      'rec-created',
      expect.objectContaining({
        deadlineAt: expect.any(Number),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(gateway.invalidateRegistrationCache).toHaveBeenCalledTimes(1);
  });

  it('accepts a simulation record when Base automation rewrites only its test tag before cleanup', async () => {
    const context = createSimulationContext();
    const snapshotService = {
      getSnapshot: jest.fn().mockRejectedValue(new Error('must not be called')),
    };
    const gateway = successfulGateway();
    gateway.getRecord.mockImplementation(async () => ({
      record_id: 'rec-created',
      fields: {
        ...gateway.persistedFields,
        [mockRegistrationFields.tag]: '暴雨黄色',
      },
    }));
    const service = serviceWith(snapshotService, gateway);

    await expect(
      service.submit({
        payload: validPayload({ warningId: context.warningId }),
        files: evidenceFiles(true),
      }),
    ).resolves.toEqual(
      expect.objectContaining({ success: true, recordId: 'rec-created' }),
    );

    expect(gateway.persistedFields[mockRegistrationFields.tag]).toBe(
      context.tag,
    );
    expect(gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledWith(
      'rec-created',
      expect.any(Object),
    );
    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
  });

  it.each(['', '任意改写标签'])(
    'still rejects a simulation record with an invalid rewritten tag: %s',
    async (rewrittenTag) => {
      const context = createSimulationContext();
      const snapshotService = {
        getSnapshot: jest
          .fn()
          .mockRejectedValue(new Error('must not be called')),
      };
      const gateway = successfulGateway();
      gateway.getRecord.mockImplementation(async () => ({
        record_id: 'rec-created',
        fields: {
          ...gateway.persistedFields,
          [mockRegistrationFields.tag]: rewrittenTag,
        },
      }));
      const service = serviceWith(snapshotService, gateway);

      await expect(
        service.submit({
          payload: validPayload({ warningId: context.warningId }),
          files: evidenceFiles(true),
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);

      expect(gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    },
  );

  it('does not report a simulation registration as successful until exact cleanup succeeds', async () => {
    const context = createSimulationContext();
    const snapshotService = {
      getSnapshot: jest.fn().mockRejectedValue(new Error('must not be called')),
    };
    const gateway = successfulGateway();
    gateway.deleteRecordAndConfirmAbsent
      .mockRejectedValueOnce(new BadGatewayException('test residue remains'))
      .mockResolvedValueOnce(undefined);
    const service = serviceWith(snapshotService, gateway);
    const input = {
      payload: validPayload({ warningId: context.warningId }),
      files: evidenceFiles(true),
    };

    await expect(service.submit(input)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    await expect(service.submit(input)).resolves.toEqual(
      expect.objectContaining({ success: true, recordId: 'rec-created' }),
    );

    expect(gateway.uploadImage).toHaveBeenCalledTimes(2);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.getRecord).toHaveBeenCalledTimes(1);
    expect(gateway.deleteRecordAndConfirmAbsent).toHaveBeenCalledTimes(2);
    expect(
      gateway.deleteRecordAndConfirmAbsent.mock.calls.map(
        ([recordId]) => recordId,
      ),
    ).toEqual(['rec-created', 'rec-created']);
    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
  });

  it('accepts a cached active checker for a different selected building', async () => {
    const gateway = successfulGateway();
    const service = serviceWith(
      { getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()) },
      gateway,
    );

    await expect(
      service.submit({
        payload: validPayload({ building: 'E楼' }),
        files: evidenceFiles(true),
      }),
    ).resolves.toEqual(expect.objectContaining({ building: 'E楼' }));
    expect(gateway.persistedFields[mockRegistrationFields.checker]).toEqual([
      { id: 'ou_checker_a' },
      { id: 'ou_checker_b' },
    ]);
  });

  it('rejects duplicate opaque checker keys before uploading', async () => {
    const gateway = successfulGateway();
    const service = serviceWith(
      { getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()) },
      gateway,
    );

    await expect(
      service.submit({
        payload: validPayload({ checkerKeys: [CHECKER_KEY, CHECKER_KEY] }),
        files: evidenceFiles(true),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.uploadImage).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('rejects stale, unavailable, and non-primary warning options with 409', async () => {
    const cases: WeatherWarningSnapshot[] = [
      activeSnapshot({ status: 'clear' }),
      activeSnapshot({ sourceState: 'stale' }),
      activeSnapshot({ guardDecisionState: 'stale' }),
      activeSnapshot({ guardLevel: null }),
      activeSnapshot({
        matchedWarnings: [
          warning({ id: 'warning-other' }),
          warning({ id: 'warning-primary' }),
        ],
      }),
    ];

    for (const snapshot of cases) {
      const gateway = gatewayWithCandidates(candidateRecords());
      const service = serviceWith(
        { getSnapshot: jest.fn().mockResolvedValue(snapshot) },
        gateway,
      );

      await expect(
        service.getOptions('warning-primary'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(gateway.listCandidateRecords).not.toHaveBeenCalled();
    }
  });

  it('rejects a whitespace-padded warning ID when loading options', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = gatewayWithCandidates(candidateRecords());
    const service = serviceWith(snapshotService, gateway);

    await expect(
      service.getOptions(' warning-primary '),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(gateway.listCandidateRecords).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-padded submitted warning ID before side effects', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const service = serviceWith(snapshotService, gateway);

    await expect(
      service.submit({
        payload: validPayload({ warningId: 'warning-primary ' }),
        files: evidenceFiles(true),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(gateway.uploadImage).not.toHaveBeenCalled();
  });

  it('stops getOptions before external work when its signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const service = controlledService(serviceWith(snapshotService, gateway));

    await expect(
      service.getOptions('warning-primary', controller.signal),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(gateway.listCandidateRecords).not.toHaveBeenCalled();
  });

  it('passes one bounded internal deadline and signal through every submission gateway stage', async () => {
    const controller = new AbortController();
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const service = controlledService(serviceWith(snapshotService, gateway));
    const startedAt = Date.now();

    await service.submit(
      { payload: validPayload(), files: evidenceFiles(true) },
      controller.signal,
    );
    const finishedAt = Date.now();

    const controls = [
      ...gateway.uploadImage.mock.calls.map((call) => call[1]),
      gateway.createRecord.mock.calls[0][2],
      gateway.getRecord.mock.calls[0][1],
      gateway.invalidateRegistrationCache.mock.calls[0][0],
    ];
    expect(controls).toHaveLength(6);
    const internalSignal = controls[0].signal;
    expect(internalSignal).toBeDefined();
    expect(internalSignal).not.toBe(controller.signal);
    for (const control of controls) {
      expect(control.signal).toBe(internalSignal);
      const deadlineStartedAt = control.deadlineAt - 50_000;
      expect(deadlineStartedAt).toBeGreaterThanOrEqual(startedAt);
      expect(deadlineStartedAt).toBeLessThanOrEqual(finishedAt);
      expect(control.deadlineAt).toBe(controls[0].deadlineAt);
    }
  });

  it('keeps shared mutation work alive when its first caller aborts', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
    const firstController = new AbortController();
    const snapshotDeferred = deferred<WeatherWarningSnapshot>();
    const snapshotService = {
      getSnapshot: jest
        .fn()
        .mockImplementationOnce(() => snapshotDeferred.promise)
        .mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const service = controlledService(serviceWith(snapshotService, gateway));
    const input = { payload: validPayload(), files: evidenceFiles(true) };

    const first = service.submit(input, firstController.signal);
    const secondOutcome = service.submit(input).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    expect(snapshotService.getSnapshot).toHaveBeenCalledTimes(1);

    firstController.abort();
    await expect(first).rejects.toBeInstanceOf(ServiceUnavailableException);
    snapshotDeferred.resolve(activeSnapshot());

    const outcome = await secondOutcome;
    expect(outcome).toEqual({
      status: 'fulfilled',
      value: expect.objectContaining({
        success: true,
        recordId: 'rec-created',
      }),
    });
    expect(gateway.uploadImage).toHaveBeenCalledTimes(3);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fails explicitly when a required candidate role is empty', async () => {
    const gateway = successfulGateway();
    const directory = activePersonnelDirectory();
    directory.personnel = [];
    const service = serviceWith(
      { getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()) },
      gateway,
      directory,
    );

    await expect(service.getOptions('warning-primary')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it.each(['一级戒备', '三级戒备'] as const)(
    'derives server fields and uploads environment evidence for %s',
    async (guardLevel) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-08T02:03:04.567Z'));
      const snapshotService = {
        getSnapshot: jest
          .fn()
          .mockResolvedValue(activeSnapshot({ guardLevel })),
      };
      const gateway = successfulGateway();
      const service = serviceWith(snapshotService, gateway);
      const payload = validPayload({
        building: 'H楼',
        deviceStatus: '异常',
        deviceAbnormalDescription: ' UPS 电池告警 ',
        contactsStatus: '异常',
        contactsAbnormalDescription: ' 联系人未接通 ',
      });

      const response = await service.submit({
        payload,
        files: evidenceFiles(true),
      });

      expect(gateway.uploadImage).toHaveBeenCalledTimes(3);
      expect(gateway.createRecord).toHaveBeenCalledWith(
        {
          日期: new Date('2026-08-08T02:03:04.567Z').getTime(),
          检查人: [{ id: 'ou_checker_a' }, { id: 'ou_checker_b' }],
          机房经理: [{ id: 'ou_manager_a' }, { id: 'ou_manager_b' }],
          重保戒备等级: guardLevel,
          检查设备安全项: '异常',
          设备安全检查纸质图片: [{ file_token: 'file-device' }],
          设备异常描述: 'UPS 电池告警',
          检查灾害专项: '正常',
          灾害专项检查纸质图片: [{ file_token: 'file-disaster' }],
          灾害异常描述: '',
          检查环境安全项: '正常',
          环境安全检查纸质图片: [{ file_token: 'file-environment' }],
          环境异常描述: '',
          检查重保物资清单正常: '正常',
          重保物资异常描述: '',
          检查重保联络清单人员齐备: '异常',
          联络清单异常描述: '联系人未接通',
          楼栋: 'H楼',
          重保标签: '台风橙色',
          机房经理确认: '已确认',
        },
        MUTATION_ID,
        expect.objectContaining({
          deadlineAt: expect.any(Number),
          signal: expect.anything(),
        }),
      );
      expect(response).toEqual({
        success: true,
        clientMutationId: MUTATION_ID,
        syncStatus: 'confirmed',
        recordId: 'rec-created',
        createdAt: '2026-08-08T02:03:04.567Z',
        building: 'H楼',
        guardLevel,
      });
      expect(snapshotService.getSnapshot).toHaveBeenCalledTimes(2);
      expect(snapshotService.getSnapshot).toHaveBeenNthCalledWith(2, {
        forceRefresh: true,
      });
      expect(gateway.invalidateRegistrationCache).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(response)).not.toContain('ou_');
    },
  );

  it('omits and does not upload environment evidence for level two', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(
        activeSnapshot({
          guardLevel: '二级戒备',
          requiredCheckKeys: undefined,
          matchedWarnings: [
            warning({
              type: '暴雨',
              color: 'orange',
              guardLevel: '二级戒备',
            }),
          ],
        }),
      ),
    };
    const gateway = successfulGateway();
    const service = serviceWith(snapshotService, gateway);
    const payload = validPayload();

    await expect(service.getOptions('warning-primary')).resolves.toEqual(
      expect.objectContaining({ environmentRequired: false }),
    );

    await service.submit({ payload, files: evidenceFiles(true) });

    expect(gateway.uploadImage).toHaveBeenCalledTimes(2);
    expect(gateway.uploadImage).not.toHaveBeenCalledWith(
      expect.objectContaining({ originalname: 'environment.png' }),
    );
    const fields = gateway.createRecord.mock.calls[0][0];
    expect(fields).toEqual(
      expect.objectContaining({
        重保戒备等级: '二级戒备',
        重保标签: '暴雨橙色',
      }),
    );
    expect(fields).not.toHaveProperty('检查环境安全项');
    expect(fields).not.toHaveProperty('环境安全检查纸质图片');
    expect(fields).not.toHaveProperty('环境异常描述');
  });

  it('infers omitted check keys from a level-three yellow warning in a mixed-version snapshot', async () => {
    const snapshot = activeSnapshot({
      guardLevel: '三级戒备',
      requiredCheckKeys: undefined,
      matchedWarnings: [
        warning({
          title: '南通市气象台发布暴雨黄色预警',
          type: '暴雨',
          color: 'yellow',
          guardLevel: '三级戒备',
        }),
      ],
    });
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(snapshot),
    };
    const gateway = successfulGateway();
    const service = serviceWith(snapshotService, gateway);
    const payload = validPayload();
    delete payload.environmentStatus;
    delete payload.environmentAbnormalDescription;

    await expect(service.getOptions('warning-primary')).resolves.toEqual(
      expect.objectContaining({
        guardLevel: '三级戒备',
        environmentRequired: false,
      }),
    );
    await service.submit({ payload, files: evidenceFiles(false) });

    expect(gateway.uploadImage).toHaveBeenCalledTimes(2);
    const fields = gateway.createRecord.mock.calls[0][0];
    expect(fields).toEqual(
      expect.objectContaining({
        重保戒备等级: '三级戒备',
        重保标签: '暴雨黄色',
      }),
    );
    expect(fields).not.toHaveProperty('检查环境安全项');
    expect(fields).not.toHaveProperty('环境安全检查纸质图片');
    expect(fields).not.toHaveProperty('环境异常描述');
  });

  it('rejects an expired checker key before uploading', async () => {
    const gateway = successfulGateway();
    const service = serviceWith(
      { getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()) },
      gateway,
    );

    await expect(
      service.submit({
        payload: validPayload({ checkerKeys: ['expired-checker-key'] }),
        files: evidenceFiles(true),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(gateway.uploadImage).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('strictly validates payload and exactly-one evidence counts before refresh', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const service = serviceWith(snapshotService, gateway);

    await expect(
      service.submit({
        payload: validPayload({ deviceStatus: 'normal' as never }),
        files: evidenceFiles(true),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.submit({
        payload: validPayload({
          clientMutationId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
        }),
        files: {
          ...evidenceFiles(true),
          deviceEvidence: [imageFile('device.png'), imageFile('device-2.png')],
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(snapshotService.getSnapshot).not.toHaveBeenCalled();
    expect(gateway.uploadImage).not.toHaveBeenCalled();
  });

  it('validates every required image before starting any upload', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const service = serviceWith(snapshotService, gateway);
    const files = evidenceFiles(true);
    files.environmentEvidence = {
      ...imageFile('environment.webp'),
      mimetype: 'image/png',
    };

    await expect(
      service.submit({ payload: validPayload(), files }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(gateway.uploadImage).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('single-flights concurrent identical mutations and reuses the bounded result cache', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const service = serviceWith(snapshotService, gateway);
    const input = { payload: validPayload(), files: evidenceFiles(true) };

    const [first, second] = await Promise.all([
      service.submit(input),
      service.submit(input),
    ]);
    const third = await service.submit(input);

    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(gateway.uploadImage).toHaveBeenCalledTimes(3);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.getRecord).toHaveBeenCalledTimes(1);
    expect(gateway.invalidateRegistrationCache).toHaveBeenCalledTimes(1);
    expect(snapshotService.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('re-enters the flow with the same client token after the completed cache TTL', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const service = serviceWith(snapshotService, gateway);
    const input = { payload: validPayload(), files: evidenceFiles(true) };

    await service.submit(input);
    jest.advanceTimersByTime(10 * 60 * 1000 + 1);
    await service.submit(input);

    expect(gateway.createRecord).toHaveBeenCalledTimes(2);
    expect(gateway.createRecord.mock.calls.map((call) => call[1])).toEqual([
      MUTATION_ID,
      MUTATION_ID,
    ]);
    expect(gateway.invalidateRegistrationCache).toHaveBeenCalledTimes(2);
  });

  it('re-enters the flow after the oldest completed result exceeds capacity', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const service = serviceWith(snapshotService, gateway);
    const oldestMutationId = mutationIdFor(0);

    for (let index = 0; index <= 256; index += 1) {
      await service.submit({
        payload: validPayload({ clientMutationId: mutationIdFor(index) }),
        files: evidenceFiles(true),
      });
    }
    await service.submit({
      payload: validPayload({ clientMutationId: oldestMutationId }),
      files: evidenceFiles(true),
    });

    expect(gateway.createRecord).toHaveBeenCalledTimes(258);
    expect(gateway.createRecord.mock.calls[0][1]).toBe(oldestMutationId);
    expect(gateway.createRecord.mock.calls[257][1]).toBe(oldestMutationId);
    expect(gateway.invalidateRegistrationCache).toHaveBeenCalledTimes(258);
  });

  it('immediately rejects a reused mutation ID with different payload or file content', async () => {
    const snapshotDeferred = deferred<WeatherWarningSnapshot>();
    const snapshotService = {
      getSnapshot: jest
        .fn()
        .mockImplementationOnce(() => snapshotDeferred.promise)
        .mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const service = serviceWith(snapshotService, gateway);
    const firstInput = { payload: validPayload(), files: evidenceFiles(true) };
    const first = service.submit(firstInput);

    await expect(
      service.submit({
        payload: validPayload({ building: 'B楼' }),
        files: evidenceFiles(true),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const changedFiles = evidenceFiles(true);
    changedFiles.deviceEvidence = imageFile('device.png', 'DIFFERENT-CONTENT');
    await expect(
      service.submit({ payload: validPayload(), files: changedFiles }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(snapshotService.getSnapshot).toHaveBeenCalledTimes(1);

    snapshotDeferred.resolve(activeSnapshot());
    await first;
  });

  it('clears a failed in-flight entry so the same mutation can safely retry', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    gateway.createRecord
      .mockRejectedValueOnce(new ServiceUnavailableException('unknown result'))
      .mockImplementationOnce(async (fields: Record<string, unknown>) => {
        gateway.persistedFields = fields;
        return 'rec-created';
      });
    const service = serviceWith(snapshotService, gateway);
    const input = { payload: validPayload(), files: evidenceFiles(true) };

    await expect(service.submit(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.submit(input)).resolves.toEqual(
      expect.objectContaining({ success: true, recordId: 'rec-created' }),
    );

    expect(gateway.createRecord).toHaveBeenCalledTimes(2);
    expect(gateway.createRecord.mock.calls[0][1]).toBe(MUTATION_ID);
    expect(gateway.createRecord.mock.calls[1][1]).toBe(MUTATION_ID);
  });

  it('reuses pending category uploads across an immediate retry and preserves recoverable fields', async () => {
    const deviceFirst = deferred<string>();
    const disasterFirst = deferred<string>();
    const environmentFirst = deferred<string>();
    const uploadCounts = { device: 0, disaster: 0, environment: 0 };
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    gateway.uploadImage.mockImplementation(
      async (file: { originalname: string }) => {
        const category = file.originalname.startsWith('device')
          ? 'device'
          : file.originalname.startsWith('disaster')
            ? 'disaster'
            : 'environment';
        uploadCounts[category] += 1;
        if (category === 'device') {
          return uploadCounts.device === 1
            ? deviceFirst.promise
            : 'file-device-retry';
        }
        if (category === 'disaster') {
          return uploadCounts.disaster === 1
            ? disasterFirst.promise
            : 'file-disaster-duplicate';
        }
        return uploadCounts.environment === 1
          ? environmentFirst.promise
          : 'file-environment-duplicate';
      },
    );
    gateway.getRecord
      .mockRejectedValueOnce(new ServiceUnavailableException('readback failed'))
      .mockImplementationOnce(async () => ({
        record_id: 'rec-created',
        fields: gateway.persistedFields,
      }));
    const service = serviceWith(snapshotService, gateway);
    const input = { payload: validPayload(), files: evidenceFiles(true) };

    const first = service.submit(input);
    await waitForCondition(() => gateway.uploadImage.mock.calls.length === 3);
    deviceFirst.reject(new ServiceUnavailableException('device upload failed'));
    await expect(first).rejects.toBeInstanceOf(ServiceUnavailableException);

    const secondOutcome = service.submit(input).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await waitForCondition(() => uploadCounts.device === 2);
    environmentFirst.resolve('file-environment-kept');
    await Promise.resolve();
    expect(gateway.createRecord).not.toHaveBeenCalled();
    disasterFirst.resolve('file-disaster-kept');

    const second = await secondOutcome;
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') {
      expect(second.error).toBeInstanceOf(ServiceUnavailableException);
    }
    await expect(service.submit(input)).resolves.toEqual(
      expect.objectContaining({ success: true, recordId: 'rec-created' }),
    );

    expect(uploadCounts).toEqual({ device: 2, disaster: 1, environment: 1 });
    expect(gateway.persistedFields).toEqual(
      expect.objectContaining({
        设备安全检查纸质图片: [{ file_token: 'file-device-retry' }],
        灾害专项检查纸质图片: [{ file_token: 'file-disaster-kept' }],
        环境安全检查纸质图片: [{ file_token: 'file-environment-kept' }],
      }),
    );
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.getRecord).toHaveBeenCalledTimes(2);
  });

  it('resumes readback after create succeeded without uploading or creating again', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    gateway.getRecord
      .mockRejectedValueOnce(new ServiceUnavailableException('readback failed'))
      .mockImplementationOnce(async () => ({
        record_id: 'rec-created',
        fields: gateway.persistedFields,
      }));
    const service = serviceWith(snapshotService, gateway);
    const input = { payload: validPayload(), files: evidenceFiles(true) };

    await expect(service.submit(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.submit(input)).resolves.toEqual(
      expect.objectContaining({ success: true, recordId: 'rec-created' }),
    );

    expect(gateway.uploadImage).toHaveBeenCalledTimes(3);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.getRecord).toHaveBeenCalledTimes(2);
    expect(gateway.invalidateRegistrationCache).toHaveBeenCalledTimes(1);
  });

  it('expires a post-create attempt ten minutes after the first create without extending on failed readback', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    gateway.getRecord
      .mockRejectedValueOnce(new ServiceUnavailableException('readback failed'))
      .mockRejectedValueOnce(
        new ServiceUnavailableException('still unreadable'),
      )
      .mockImplementationOnce(async () => ({
        record_id: 'rec-created',
        fields: gateway.persistedFields,
      }));
    const service = serviceWith(snapshotService, gateway);
    const input = { payload: validPayload(), files: evidenceFiles(true) };

    await expect(service.submit(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    jest.advanceTimersByTime(9 * 60 * 1000);
    await expect(service.submit(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    jest.advanceTimersByTime(60 * 1000 + 1);
    await expect(service.submit(input)).resolves.toEqual(
      expect.objectContaining({ success: true, recordId: 'rec-created' }),
    );

    expect(gateway.uploadImage).toHaveBeenCalledTimes(6);
    expect(gateway.createRecord).toHaveBeenCalledTimes(2);
    expect(gateway.getRecord).toHaveBeenCalledTimes(3);
  });

  it('bounds post-create attempts to 256 entries and retains the newest attempt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    const fieldsByRecord = new Map<string, Record<string, unknown>>();
    const readableRecordIds = new Set<string>();
    gateway.createRecord.mockImplementation(
      async (fields: Record<string, unknown>, mutationId: string) => {
        const recordId = `rec-${mutationId}`;
        fieldsByRecord.set(recordId, fields);
        return recordId;
      },
    );
    gateway.getRecord.mockImplementation(async (recordId: string) => {
      if (!readableRecordIds.has(recordId)) {
        throw new ServiceUnavailableException('readback failed');
      }
      return {
        record_id: recordId,
        fields: fieldsByRecord.get(recordId),
      };
    });
    const service = serviceWith(snapshotService, gateway);

    for (let index = 0; index <= 256; index += 1) {
      await expect(
        service.submit({
          payload: validPayload({ clientMutationId: mutationIdFor(index) }),
          files: evidenceFiles(true),
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    }

    const oldestMutationId = mutationIdFor(0);
    const newestMutationId = mutationIdFor(256);
    readableRecordIds.add(`rec-${oldestMutationId}`);
    readableRecordIds.add(`rec-${newestMutationId}`);
    await service.submit({
      payload: validPayload({ clientMutationId: oldestMutationId }),
      files: evidenceFiles(true),
    });
    await service.submit({
      payload: validPayload({ clientMutationId: newestMutationId }),
      files: evidenceFiles(true),
    });

    expect(gateway.uploadImage).toHaveBeenCalledTimes(258 * 3);
    expect(gateway.createRecord).toHaveBeenCalledTimes(258);
    expect(gateway.getRecord).toHaveBeenCalledTimes(259);
  });

  it('does not report success when the readback differs from submitted fields', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    gateway.getRecord.mockImplementation(async () => ({
      record_id: 'rec-created',
      fields: { ...gateway.persistedFields, 楼栋: 'B楼' },
    }));
    const service = serviceWith(snapshotService, gateway);

    await expect(
      service.submit({ payload: validPayload(), files: evidenceFiles(true) }),
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(snapshotService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(gateway.invalidateRegistrationCache).not.toHaveBeenCalled();
  });

  it('rejects a readback date that is not the exact submitted millisecond timestamp', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-08T02:03:04.567Z'));
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    gateway.getRecord.mockImplementation(async () => ({
      record_id: 'rec-created',
      fields: {
        ...gateway.persistedFields,
        日期: Math.trunc(new Date('2026-08-08T02:03:04.567Z').getTime() / 1000),
      },
    }));
    const service = serviceWith(snapshotService, gateway);

    await expect(
      service.submit({ payload: validPayload(), files: evidenceFiles(true) }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(gateway.invalidateRegistrationCache).not.toHaveBeenCalled();
  });

  it.each([
    ['设备异常描述', '设备异常描述'],
    ['灾害异常描述', '灾害异常描述'],
    ['环境异常描述', '环境异常描述'],
    ['重保物资异常描述', '重保物资异常描述'],
    ['联络清单异常描述', '联络清单异常描述'],
  ] as const)(
    'rejects a readback with tampered %s without invalidating cache',
    async (_label, fieldName) => {
      const snapshotService = {
        getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
      };
      const gateway = successfulGateway();
      gateway.getRecord.mockImplementation(async () => ({
        record_id: 'rec-created',
        fields: { ...gateway.persistedFields, [fieldName]: '' },
      }));
      const service = serviceWith(snapshotService, gateway);
      const payload = validPayload({
        deviceStatus: '异常',
        deviceAbnormalDescription: '设备异常',
        disasterStatus: '异常',
        disasterAbnormalDescription: '灾害异常',
        environmentStatus: '异常',
        environmentAbnormalDescription: '环境异常',
        materialsStatus: '异常',
        materialsAbnormalDescription: '物资异常',
        contactsStatus: '异常',
        contactsAbnormalDescription: '联络异常',
      });

      await expect(
        service.submit({ payload, files: evidenceFiles(true) }),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(gateway.invalidateRegistrationCache).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['环境状态', '检查环境安全项', '正常'],
    ['环境附件', '环境安全检查纸质图片', [{ file_token: 'file-environment' }]],
    ['环境异常描述', '环境异常描述', '不应存在'],
  ] as const)(
    'rejects level-two readback with an unexpected %s field',
    async (_label, fieldName, value) => {
      const snapshotService = {
        getSnapshot: jest.fn().mockResolvedValue(
          activeSnapshot({
            guardLevel: '二级戒备',
            requiredCheckKeys: undefined,
            matchedWarnings: [
              warning({
                type: '暴雨',
                color: 'orange',
                guardLevel: '二级戒备',
              }),
            ],
          }),
        ),
      };
      const gateway = successfulGateway();
      gateway.getRecord.mockImplementation(async () => ({
        record_id: 'rec-created',
        fields: { ...gateway.persistedFields, [fieldName]: value },
      }));
      const service = serviceWith(snapshotService, gateway);

      await expect(
        service.submit({ payload: validPayload(), files: evidenceFiles(true) }),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(gateway.invalidateRegistrationCache).not.toHaveBeenCalled();
    },
  );

  it('does not accept a different record ID in the readback response', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    gateway.getRecord.mockImplementation(async () => ({
      record_id: 'rec-other',
      fields: gateway.persistedFields,
    }));
    const service = serviceWith(snapshotService, gateway);

    await expect(
      service.submit({ payload: validPayload(), files: evidenceFiles(true) }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(snapshotService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(gateway.invalidateRegistrationCache).not.toHaveBeenCalled();
  });

  it.each(READBACK_TAMPER_CASES)(
    'rejects a readback with tampered %s without invalidating cache',
    async (_label, tamper) => {
      const snapshotService = {
        getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
      };
      const gateway = successfulGateway();
      gateway.getRecord.mockImplementation(async () => ({
        record_id: 'rec-created',
        fields: tamper(gateway.persistedFields),
      }));
      const service = serviceWith(snapshotService, gateway);

      await expect(
        service.submit({ payload: validPayload(), files: evidenceFiles(true) }),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(gateway.invalidateRegistrationCache).not.toHaveBeenCalled();
    },
  );

  it('rejects duplicate or malformed people cells in the readback', async () => {
    const snapshotService = {
      getSnapshot: jest.fn().mockResolvedValue(activeSnapshot()),
    };
    const gateway = successfulGateway();
    gateway.getRecord.mockImplementation(async () => ({
      record_id: 'rec-created',
      fields: {
        ...gateway.persistedFields,
        检查人: [
          { id: 'ou_checker_a' },
          { id: 'ou_checker_b' },
          { id: 'ou_checker_b' },
        ],
      },
    }));
    const service = serviceWith(snapshotService, gateway);

    await expect(
      service.submit({ payload: validPayload(), files: evidenceFiles(true) }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(snapshotService.getSnapshot).toHaveBeenCalledTimes(1);
    expect(gateway.invalidateRegistrationCache).not.toHaveBeenCalled();
  });

  it('returns and caches a confirmed success when the post-write refresh fails', async () => {
    const snapshotService = {
      getSnapshot: jest
        .fn()
        .mockResolvedValueOnce(activeSnapshot())
        .mockRejectedValueOnce(new Error('sensitive upstream failure')),
    };
    const gateway = successfulGateway();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = serviceWith(snapshotService, gateway);
    const input = { payload: validPayload(), files: evidenceFiles(true) };

    const first = await service.submit(input);
    const cached = await service.submit(input);

    expect(first).toEqual(
      expect.objectContaining({ success: true, recordId: 'rec-created' }),
    );
    expect(cached).toEqual(first);
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.deleteRecordAndConfirmAbsent).not.toHaveBeenCalled();
    expect(gateway.invalidateRegistrationCache).toHaveBeenCalledTimes(1);
    expect(snapshotService.getSnapshot).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      '登记记录已确认，但登记后预警快照刷新失败',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive');
  });

  it('returns a confirmed success without waiting for the post-write snapshot refresh', async () => {
    const refresh = deferred<ReturnType<typeof activeSnapshot>>();
    const snapshotService = {
      getSnapshot: jest
        .fn()
        .mockResolvedValueOnce(activeSnapshot())
        .mockReturnValueOnce(refresh.promise),
    };
    const service = serviceWith(snapshotService, successfulGateway());
    let settled = false;

    const submission = service
      .submit({ payload: validPayload(), files: evidenceFiles(true) })
      .then((result) => {
        settled = true;
        return result;
    });
    await waitForCondition(() => snapshotService.getSnapshot.mock.calls.length === 2);
    for (let turn = 0; turn < 20 && !settled; turn += 1) {
      await Promise.resolve();
    }
    const settledBeforeRefresh = settled;

    refresh.resolve(activeSnapshot());
    const result = await submission;

    expect(settledBeforeRefresh).toBe(true);
    expect(result).toEqual(
      expect.objectContaining({ success: true, syncStatus: 'confirmed' }),
    );
  });

  it('registers gateway and service providers without replacing existing ones', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/weather-warning/weather-warning.module.ts',
      ),
      'utf8',
    );

    expect(source).toContain('WeatherWarningRegistrationGateway');
    expect(source).toContain('WeatherWarningRegistrationService');
    expect(source).toContain('WeatherWarningBitableService');
    expect(source).toContain('WeatherWarningScheduler');
  });
});

function serviceWith(
  snapshotService: { getSnapshot: jest.Mock },
  gateway: ReturnType<typeof successfulGateway>,
  personnelDirectory = activePersonnelDirectory(),
) {
  return new WeatherWarningRegistrationService(
    snapshotService as never,
    gateway as never,
    {
      getCachedActivePersonnelDirectory: jest
        .fn()
        .mockResolvedValue(personnelDirectory),
    } as never,
  );
}

function controlledService(service: WeatherWarningRegistrationService) {
  return service as unknown as WeatherWarningRegistrationService & {
    getOptions(
      warningId: string,
      signal?: AbortSignal,
    ): ReturnType<WeatherWarningRegistrationService['getOptions']>;
    submit(
      input: Parameters<WeatherWarningRegistrationService['submit']>[0],
      signal?: AbortSignal,
    ): ReturnType<WeatherWarningRegistrationService['submit']>;
  };
}

function gatewayWithCandidates(records: unknown[]) {
  return successfulGateway(records);
}

function successfulGateway(records: unknown[] = candidateRecords()) {
  const gateway = {
    persistedFields: {} as Record<string, unknown>,
    listCandidateRecords: jest.fn().mockResolvedValue(records),
    listManagerCandidateRecords: jest
      .fn()
      .mockResolvedValue([
        organizationManagerRecord(
          'rec-manager-a',
          '设施运维经理',
          'ou_manager_a',
          '经理甲',
        ),
      ]),
    uploadImage: jest.fn(async (file: { originalname: string }) => {
      if (file.originalname.startsWith('device')) return 'file-device';
      if (file.originalname.startsWith('disaster')) return 'file-disaster';
      return 'file-environment';
    }),
    createRecord: jest.fn(
      async (fields: Record<string, unknown>, _mutationId: string) => {
        gateway.persistedFields = fields;
        return 'rec-created';
      },
    ),
    getRecord: jest.fn(async () => ({
      record_id: 'rec-created',
      fields: gateway.persistedFields,
    })),
    deleteRecordAndConfirmAbsent: jest.fn(async () => undefined),
    invalidateRegistrationCache: jest.fn(async () => undefined),
  };
  return gateway;
}

function organizationManagerRecord(
  recordId: string,
  position: string,
  openId: string,
  name: string,
) {
  return {
    record_id: recordId,
    fields: {
      职位: position,
      主管: [{ id: openId, name }],
      '主管（文本）': name,
    },
  };
}

function candidateRecords() {
  return [
    {
      record_id: 'rec-candidates',
      fields: {
        检查人: [
          { id: 'ou_checker_a', name: '检查员甲' },
          { id: 'ou_checker_b', name: '检查员乙' },
        ],
        机房经理: [{ id: 'ou_manager_a', name: '经理甲' }],
      },
    },
  ];
}

function validPayload(
  patch: Partial<WeatherGuardRegistrationRequest> = {},
): WeatherGuardRegistrationRequest {
  return {
    clientMutationId: MUTATION_ID,
    warningId: 'warning-primary',
    building: 'A楼',
    checkerKeys: [CHECKER_KEY, SECOND_CHECKER_KEY],
    deviceStatus: '正常',
    deviceAbnormalDescription: '',
    disasterStatus: '正常',
    disasterAbnormalDescription: '',
    environmentStatus: '正常',
    environmentAbnormalDescription: '',
    materialsStatus: '正常',
    materialsAbnormalDescription: '',
    contactsStatus: '正常',
    contactsAbnormalDescription: '',
    ...patch,
  };
}

function evidenceFiles(
  includeEnvironment: boolean,
): WeatherWarningRegistrationSubmitFiles {
  return {
    deviceEvidence: [imageFile('device.png')],
    disasterEvidence: imageFile('disaster.jpg'),
    ...(includeEnvironment
      ? { environmentEvidence: [imageFile('environment.webp')] }
      : {}),
  };
}

function imageFile(originalname: string, content = `image:${originalname}`) {
  const extension = originalname.split('.').pop()?.toLowerCase();
  const mimetype =
    extension === 'jpg' || extension === 'jpeg'
      ? 'image/jpeg'
      : extension === 'webp'
        ? 'image/webp'
        : 'image/png';
  const signature =
    mimetype === 'image/jpeg'
      ? Buffer.from('ffd8ff', 'hex')
      : mimetype === 'image/webp'
        ? Buffer.from('524946460000000057454250', 'hex')
        : Buffer.from('89504e470d0a1a0a', 'hex');
  const buffer = Buffer.concat([signature, Buffer.from(content)]);
  return {
    originalname,
    mimetype,
    size: buffer.length,
    buffer,
  };
}

function activeSnapshot(
  patch: Partial<WeatherWarningSnapshot> = {},
): WeatherWarningSnapshot {
  const guardLevel = Object.prototype.hasOwnProperty.call(patch, 'guardLevel')
    ? patch.guardLevel!
    : '三级戒备';
  return {
    status: 'active',
    sourceState: 'fresh',
    guardDecisionState: 'fresh',
    checkSyncState: 'fresh',
    snapshotAt: '2026-08-08T01:00:00.000Z',
    guardLevel,
    matchedWarnings: [warning({ guardLevel })],
    unmatchedWarnings: [],
    actions: [],
    weather: null,
    checkSummary: {
      device: 'not_started',
      environment: 'not_started',
      disaster: 'not_started',
      materials: 'not_started',
      contacts: 'not_started',
      managerConfirmation: 'not_started',
      abnormalSummaries: [],
    },
    requiredCheckKeys: [
      'device',
      'environment',
      'disaster',
      'materials',
      'contacts',
      'managerConfirmation',
    ],
    canSendTest: false,
    ...patch,
  };
}

function warning(
  patch: Partial<WeatherWarningSnapshot['matchedWarnings'][number]> = {},
) {
  return {
    id: 'warning-primary',
    title: '南通市气象台发布台风橙色预警',
    type: '台风',
    color: 'orange' as const,
    guardLevel: '三级戒备' as WeatherWarningGuardLevel,
    ...patch,
  };
}

function opaqueCheckerKey(openId: string): string {
  return createHash('sha256')
    .update(`weather-registration:v2:checker:${openId}`)
    .digest('base64url');
}

function activePersonnelDirectory() {
  return {
    personnel: [
      {
        recordId: 'rec-checker-a',
        name: '检查员甲',
        openId: 'ou_checker_a',
        employeeNo: '1001',
        position: '设施运维工程师',
        systemPosition: '运维工程师',
        buildings: ['A', 'H'],
      },
      {
        recordId: 'rec-checker-b',
        name: '检查员乙',
        openId: 'ou_checker_b',
        employeeNo: '1002',
        position: '设施运维工程师',
        systemPosition: '运维工程师',
        buildings: ['A', 'H'],
      },
    ],
    managers: [
      {
        recordId: 'rec-manager-a',
        name: '梅冰冰',
        openId: 'ou_manager_a',
        employeeNo: null,
        position: '设施运维经理',
        systemPosition: '运维经理',
        buildings: ['A'],
      },
      {
        recordId: 'rec-manager-b',
        name: '马进宇',
        openId: 'ou_manager_b',
        employeeNo: null,
        position: '设施运维副经理',
        systemPosition: '运维经理',
        buildings: ['A'],
      },
    ],
    snapshot: {
      fetchedAt: Date.parse('2026-08-09T04:24:00.000Z'),
      expiresAt: Date.parse('2026-08-09T08:24:00.000Z'),
      stale: false,
    },
    quality: {
      sourceRecordCount: 4,
      activeRecordCount: 4,
      inactiveRecordCount: 0,
      usablePersonnelCount: 4,
      managerCount: 2,
      missingNameCount: 0,
      missingOpenIdCount: 0,
      duplicateOpenIdCount: 0,
      missingBuildingCount: 0,
    },
  };
}

function mutationIdFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function createSimulationContext() {
  const now = Date.now();
  return createWeatherWarningTestSimulationContext(
    `weather-e2e-${now}-a1b2c3d4e5f60708`,
    now,
  );
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(
  condition: () => boolean,
  maxMicrotaskTurns = 50,
): Promise<void> {
  for (let turn = 0; turn < maxMicrotaskTurns; turn += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not reached within the microtask limit');
}
