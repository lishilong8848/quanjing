import type {
  WeatherGuardRegistrationOptions,
  WeatherGuardRegistrationPersonOption,
  WeatherGuardRegistrationRequest,
  WeatherGuardRegistrationResponse,
} from '../../shared/api.interface';
import {
  WEATHER_GUARD_BUILDINGS,
  buildWeatherGuardRegistrationFields,
  validateWeatherGuardRegistration,
  type WeatherGuardRegistrationBuildContext,
  type WeatherGuardRegistrationValidationContext,
} from '../../server/modules/weather-warning/weather-warning-registration.rules';

const VALID_MUTATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const SUBMITTED_AT = new Date('2026-08-08T02:03:04.567Z');

type IsExact<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;
const PERSON_OPTION_KEYS_ARE_EXACT: Assert<
  IsExact<
    keyof WeatherGuardRegistrationPersonOption,
    'key' | 'name' | 'position' | 'buildings'
  >
> = true;

function validRequest(
  patch: Partial<WeatherGuardRegistrationRequest> = {},
): WeatherGuardRegistrationRequest {
  return {
    clientMutationId: VALID_MUTATION_ID,
    warningId: 'warning-typhoon-orange-20260808',
    building: 'A楼',
    checkerKeys: ['checker-key-a', 'checker-key-b'],
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

function validationContext(
  patch: Partial<WeatherGuardRegistrationValidationContext> = {},
): WeatherGuardRegistrationValidationContext {
  return {
    guardLevel: '三级戒备',
    environmentRequired: true,
    attachmentCounts: {
      device: 1,
      disaster: 1,
      environment: 1,
    },
    ...patch,
  };
}

function buildContext(
  patch: Partial<WeatherGuardRegistrationBuildContext> = {},
): WeatherGuardRegistrationBuildContext {
  return {
    submittedAt: SUBMITTED_AT,
    guardLevel: '三级戒备',
    tag: '台风橙色预警',
    checkerOpenIds: ['ou_checker_a', 'ou_checker_b'],
    managerOpenIds: ['ou_manager_a', 'ou_manager_b'],
    environmentRequired: true,
    attachmentTokens: {
      device: 'file_device',
      disaster: 'file_disaster',
      environment: 'file_environment',
    },
    ...patch,
  };
}

function errorFields(
  request: unknown,
  context = validationContext(),
): string[] {
  return validateWeatherGuardRegistration(request, context).map(
    ({ field }) => field,
  );
}

describe('weather guard registration shared contract', () => {
  it('exposes options and success response without exposing open_id values', () => {
    const options: WeatherGuardRegistrationOptions = {
      warning: {
        id: 'warning-1',
        title: '南通市气象台发布台风橙色预警',
        type: '台风',
        color: 'orange',
        guardLevel: '三级戒备',
      },
      guardLevel: '三级戒备',
      dataUpdatedAt: '2026-08-09T04:24:00.000Z',
      environmentRequired: false,
      buildings: ['A楼', '110站'],
      checkers: [
        {
          key: 'checker-key-a',
          name: '检查员甲',
          position: '设施运维工程师',
          buildings: ['A楼'],
        },
      ],
      personnelSyncedAt: '2026-08-09T04:24:00.000Z',
      personnelStale: false,
      acceptedImageTypes: ['image/jpeg', 'image/png'],
      maxImageBytes: 10 * 1024 * 1024,
    };
    const response: WeatherGuardRegistrationResponse = {
      success: true,
      recordId: 'rec_registration',
      createdAt: '2026-08-08T02:03:04.567Z',
      building: 'A楼',
      guardLevel: '三级戒备',
    };

    expect(options.checkers[0]).toEqual({
      key: 'checker-key-a',
      name: '检查员甲',
      position: '设施运维工程师',
      buildings: ['A楼'],
    });
    expect(options.checkers[0]).not.toHaveProperty('openId');
    expect(PERSON_OPTION_KEYS_ARE_EXACT).toBe(true);
    expect(response.success).toBe(true);
  });
});

describe('weather guard registration rules', () => {
  it('maps a complete level-three registration to the exact Base fields', () => {
    const request = validRequest({
      building: 'H楼',
      deviceStatus: '异常',
      deviceAbnormalDescription: ' UPS 电池告警 ',
      disasterStatus: '正常',
      environmentStatus: '异常',
      environmentAbnormalDescription: ' 屋面排水口有杂物 ',
      materialsStatus: '正常',
      contactsStatus: '异常',
      contactsAbnormalDescription: ' 供应商联系人未接通 ',
    });

    expect(
      buildWeatherGuardRegistrationFields(request, buildContext()),
    ).toEqual({
      日期: SUBMITTED_AT.getTime(),
      检查人: [{ id: 'ou_checker_a' }, { id: 'ou_checker_b' }],
      机房经理: [{ id: 'ou_manager_a' }, { id: 'ou_manager_b' }],
      重保戒备等级: '三级戒备',
      检查设备安全项: '异常',
      设备安全检查纸质图片: [{ file_token: 'file_device' }],
      设备异常描述: 'UPS 电池告警',
      检查灾害专项: '正常',
      灾害专项检查纸质图片: [{ file_token: 'file_disaster' }],
      灾害异常描述: '',
      检查环境安全项: '异常',
      环境安全检查纸质图片: [{ file_token: 'file_environment' }],
      环境异常描述: '屋面排水口有杂物',
      检查重保物资清单正常: '正常',
      重保物资异常描述: '',
      检查重保联络清单人员齐备: '异常',
      联络清单异常描述: '供应商联系人未接通',
      楼栋: 'H楼',
      重保标签: '台风橙色预警',
      机房经理确认: '已确认',
    });
  });

  it.each([
    [['ou_manager_a'], 'one manager'],
    [['ou_manager_a', 'ou_manager_b', 'ou_manager_c'], 'three managers'],
    [['ou_manager_a', 'ou_manager_a'], 'duplicate open_id'],
    [['ou_manager_a', 'manager_b'], 'invalid open_id'],
  ] as const)('rejects automatic manager context with %s', (managerOpenIds) => {
    expect(() =>
      buildWeatherGuardRegistrationFields(
        validRequest(),
        buildContext({ managerOpenIds }),
      ),
    ).toThrow('机房经理');
  });

  it('requires the server-resolved environment scope instead of inferring it from guard level', () => {
    const request = validRequest();
    delete request.environmentStatus;
    delete request.environmentAbnormalDescription;

    expect(
      errorFields(
        request,
        validationContext({
          guardLevel: '二级戒备',
          environmentRequired: true,
          attachmentCounts: { device: 1, disaster: 1, environment: 0 },
        }),
      ),
    ).toEqual(
      expect.arrayContaining(['environmentStatus', 'environmentImage']),
    );

    expect(
      errorFields(
        validRequest(),
        validationContext({
          environmentRequired: undefined,
        }),
      ),
    ).toContain('environmentRequired');

    expect(() =>
      buildWeatherGuardRegistrationFields(
        validRequest(),
        buildContext({ environmentRequired: undefined }),
      ),
    ).toThrow('服务端环境检查范围无效');
  });

  it('accepts level two without environment input and omits all environment fields', () => {
    const request = validRequest();
    delete request.environmentStatus;
    delete request.environmentAbnormalDescription;
    const context = validationContext({
      guardLevel: '二级戒备',
      environmentRequired: false,
      attachmentCounts: { device: 1, disaster: 1 },
    });

    expect(validateWeatherGuardRegistration(request, context)).toEqual([]);

    const fields = buildWeatherGuardRegistrationFields(
      request,
      buildContext({
        guardLevel: '二级戒备',
        environmentRequired: false,
        attachmentTokens: {
          device: 'file_device',
          disaster: 'file_disaster',
        },
      }),
    );

    expect(fields).not.toHaveProperty('检查环境安全项');
    expect(fields).not.toHaveProperty('环境安全检查纸质图片');
    expect(fields).not.toHaveProperty('环境异常描述');

    const staleEnvironmentRequest = validRequest({
      environmentStatus: '陈旧非法状态',
      environmentAbnormalDescription: 42,
    } as unknown as Partial<WeatherGuardRegistrationRequest>);
    expect(
      validateWeatherGuardRegistration(
        staleEnvironmentRequest,
        validationContext({
          guardLevel: '二级戒备',
          environmentRequired: false,
          attachmentCounts: { device: 1, disaster: 1, environment: 1 },
        }),
      ),
    ).toEqual([]);

    const staleEnvironmentFields = buildWeatherGuardRegistrationFields(
      staleEnvironmentRequest,
      buildContext({
        guardLevel: '二级戒备',
        environmentRequired: false,
        attachmentTokens: {
          device: 'file_device',
          disaster: 'file_disaster',
          environment: 'file_stale_environment',
        },
      }),
    );
    expect(staleEnvironmentFields).not.toHaveProperty('检查环境安全项');
    expect(staleEnvironmentFields).not.toHaveProperty('环境安全检查纸质图片');
    expect(staleEnvironmentFields).not.toHaveProperty('环境异常描述');
  });

  it('accepts level three without environment input when the warning matrix marks it not required', () => {
    const request = validRequest();
    delete request.environmentStatus;
    delete request.environmentAbnormalDescription;

    const context = validationContext({
      guardLevel: '三级戒备',
      environmentRequired: false,
      attachmentCounts: { device: 1, disaster: 1 },
    });
    expect(validateWeatherGuardRegistration(request, context)).toEqual([]);

    const fields = buildWeatherGuardRegistrationFields(
      request,
      buildContext({
        environmentRequired: false,
        attachmentTokens: {
          device: 'file_device',
          disaster: 'file_disaster',
        },
      }),
    );
    expect(fields).not.toHaveProperty('检查环境安全项');
    expect(fields).not.toHaveProperty('环境安全检查纸质图片');
  });

  it.each([
    ['deviceStatus', 'deviceAbnormalDescription'],
    ['disasterStatus', 'disasterAbnormalDescription'],
    ['environmentStatus', 'environmentAbnormalDescription'],
    ['materialsStatus', 'materialsAbnormalDescription'],
    ['contactsStatus', 'contactsAbnormalDescription'],
  ] as const)(
    'requires %s abnormal details in %s',
    (statusField, descriptionField) => {
      const request = validRequest({
        [statusField]: '异常',
        [descriptionField]: '   ',
      });

      expect(errorFields(request)).toContain(descriptionField);
    },
  );

  it('accepts a canonical RFC 4122 version-one mutation UUID', () => {
    expect(
      errorFields(
        validRequest({
          clientMutationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        }),
      ),
    ).not.toContain('clientMutationId');
  });

  it('strictly validates building, UUID, personnel keys, and statuses', () => {
    expect(WEATHER_GUARD_BUILDINGS).toEqual([
      'A楼',
      'B楼',
      'C楼',
      'D楼',
      'E楼',
      'H楼',
      '110站',
    ]);

    for (const building of ['', 'A', 'F楼', '110 站']) {
      expect(
        errorFields(validRequest({ building: building as never })),
      ).toContain('building');
    }

    for (const clientMutationId of [
      '',
      '123e4567-e89b-42d3-a456-42661417400',
      '123e4567-e89b-02d3-a456-426614174000',
      '123e4567-e89b-72d3-a456-426614174000',
      '123e4567-e89b-42d3-7456-426614174000',
      'not-a-uuid',
    ]) {
      expect(errorFields(validRequest({ clientMutationId }))).toContain(
        'clientMutationId',
      );
    }

    for (const checkerKeys of [[], [''], ['   '], ['checker-key-a', 7]]) {
      expect(
        errorFields(
          validRequest({ checkerKeys: checkerKeys as unknown as string[] }),
        ),
      ).toContain('checkerKeys');
    }

    expect(
      errorFields(
        validRequest({ checkerKeys: ['checker-key-a', 'checker-key-a'] }),
      ),
    ).not.toContain('checkerKeys');

    for (const [statusField, invalidStatus] of [
      ['deviceStatus', 'normal'],
      ['disasterStatus', '正常 '],
      ['environmentStatus', '异常中'],
      ['materialsStatus', true],
      ['contactsStatus', null],
    ] as const) {
      expect(
        errorFields(
          validRequest({
            [statusField]: invalidStatus,
          } as unknown as Partial<WeatherGuardRegistrationRequest>),
        ),
      ).toContain(statusField);
    }
  });

  it('rejects server-owned fields supplied by the client', () => {
    const forgedRequest = {
      ...validRequest(),
      submittedAt: '2000-01-01T00:00:00.000Z',
      guardLevel: '一级戒备',
      tag: '伪造标签',
      checkerOpenIds: ['ou_attacker'],
      managerOpenIds: ['ou_attacker'],
      managerConfirmation: '未确认',
      attachmentTokens: {
        device: 'file_attacker',
        disaster: 'file_attacker',
        environment: 'file_attacker',
      },
    };

    expect(errorFields(forgedRequest)).toEqual(
      expect.arrayContaining([
        'submittedAt',
        'guardLevel',
        'tag',
        'checkerOpenIds',
        'managerOpenIds',
        'managerConfirmation',
        'attachmentTokens',
      ]),
    );
    expect(() =>
      buildWeatherGuardRegistrationFields(
        forgedRequest as unknown as WeatherGuardRegistrationRequest,
        buildContext(),
      ),
    ).toThrow('客户端包含不允许的字段');
  });

  it('rejects missing required attachments during validation', () => {
    expect(
      errorFields(
        validRequest(),
        validationContext({
          attachmentCounts: { device: 0, disaster: 1, environment: 1 },
        }),
      ),
    ).toContain('deviceImage');
    expect(
      errorFields(
        validRequest(),
        validationContext({
          attachmentCounts: { device: 1, disaster: 0, environment: 1 },
        }),
      ),
    ).toContain('disasterImage');
    expect(
      errorFields(
        validRequest(),
        validationContext({
          attachmentCounts: { device: 1, disaster: 1, environment: 0 },
        }),
      ),
    ).toContain('environmentImage');
  });

  it.each([
    [
      'device',
      {
        device: '',
        disaster: 'file_disaster',
        environment: 'file_environment',
      },
    ],
    [
      'disaster',
      { device: 'file_device', disaster: ' ', environment: 'file_environment' },
    ],
    [
      'environment',
      { device: 'file_device', disaster: 'file_disaster', environment: '' },
    ],
  ] as const)(
    'rejects an empty %s attachment token while building fields',
    (_, attachmentTokens) => {
      expect(() =>
        buildWeatherGuardRegistrationFields(
          validRequest(),
          buildContext({ attachmentTokens }),
        ),
      ).toThrow('附件 token');
    },
  );

  it('maps attachment tokens and keeps the two irregular Base field names exact', () => {
    const fields = buildWeatherGuardRegistrationFields(
      validRequest({
        disasterStatus: '异常',
        disasterAbnormalDescription: '防汛挡板破损',
        contactsStatus: '异常',
        contactsAbnormalDescription: '联系人缺失',
      }),
      buildContext(),
    );

    expect(fields['设备安全检查纸质图片']).toEqual([
      { file_token: 'file_device' },
    ]);
    expect(fields['灾害专项检查纸质图片']).toEqual([
      { file_token: 'file_disaster' },
    ]);
    expect(fields['环境安全检查纸质图片']).toEqual([
      { file_token: 'file_environment' },
    ]);
    expect(fields['检查灾害专项']).toBe('异常');
    expect(fields['联络清单异常描述']).toBe('联系人缺失');
    expect(fields).not.toHaveProperty('灾害专项');
    expect(fields).not.toHaveProperty('异常描述');
    expect(fields).not.toHaveProperty('本次戒备等级');
  });
});
