import { ServiceUnavailableException } from '@nestjs/common';
import { loadWeatherWarningRegistrationRuntimeConfig } from '../../server/modules/weather-warning/weather-warning-registration.config';

const SOURCE_URL =
  'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';

describe('weather warning registration runtime config', () => {
  it('uses the existing guard-check table and dedicated registration field defaults', () => {
    const config = loadWeatherWarningRegistrationRuntimeConfig({
      FEISHU_WEATHER_WARNING_SOURCE_URL: SOURCE_URL,
      FEISHU_WEATHER_WARNING_CHECK_TABLE_ID: 'tbl38234f0508b6d',
    });

    expect(config).toEqual({
      appToken: 'appWeatherWarning',
      wikiToken: '',
      registrationTableId: 'tbl38234f0508b6d',
      registrationFields: {
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
      },
    });
  });

  it('allows every registration table and field override without changing progress fields', () => {
    const env = {
      FEISHU_WEATHER_WARNING_SOURCE_URL: SOURCE_URL,
      FEISHU_WEATHER_WARNING_CHECK_TABLE_ID: 'tbl71f0ddbad89cb9',
      FEISHU_WEATHER_WARNING_CHECK_DEVICE_FIELD: '进度设备状态',
      FEISHU_WEATHER_WARNING_REGISTRATION_TABLE_ID: 'tbld85f2e4a48893',
      FEISHU_WEATHER_WARNING_REGISTRATION_DATE_FIELD: '登记时间',
      FEISHU_WEATHER_WARNING_REGISTRATION_CHECKER_FIELD: '登记检查人',
      FEISHU_WEATHER_WARNING_REGISTRATION_MANAGER_FIELD: '登记经理',
      FEISHU_WEATHER_WARNING_REGISTRATION_GUARD_FIELD: '登记戒备等级',
      FEISHU_WEATHER_WARNING_REGISTRATION_DEVICE_FIELD: '登记设备状态',
      FEISHU_WEATHER_WARNING_REGISTRATION_DEVICE_IMAGE_FIELD: '登记设备图片',
      FEISHU_WEATHER_WARNING_REGISTRATION_DEVICE_ISSUE_FIELD: '登记设备异常',
      FEISHU_WEATHER_WARNING_REGISTRATION_DISASTER_FIELD: '登记灾害状态',
      FEISHU_WEATHER_WARNING_REGISTRATION_DISASTER_IMAGE_FIELD: '登记灾害图片',
      FEISHU_WEATHER_WARNING_REGISTRATION_DISASTER_ISSUE_FIELD: '登记灾害异常',
      FEISHU_WEATHER_WARNING_REGISTRATION_ENVIRONMENT_FIELD: '登记环境状态',
      FEISHU_WEATHER_WARNING_REGISTRATION_ENVIRONMENT_IMAGE_FIELD:
        '登记环境图片',
      FEISHU_WEATHER_WARNING_REGISTRATION_ENVIRONMENT_ISSUE_FIELD:
        '登记环境异常',
      FEISHU_WEATHER_WARNING_REGISTRATION_MATERIALS_FIELD: '登记物资状态',
      FEISHU_WEATHER_WARNING_REGISTRATION_MATERIALS_ISSUE_FIELD: '登记物资异常',
      FEISHU_WEATHER_WARNING_REGISTRATION_CONTACTS_FIELD: '登记联络状态',
      FEISHU_WEATHER_WARNING_REGISTRATION_CONTACTS_ISSUE_FIELD: '登记联络异常',
      FEISHU_WEATHER_WARNING_REGISTRATION_BUILDING_FIELD: '登记楼栋',
      FEISHU_WEATHER_WARNING_REGISTRATION_TAG_FIELD: '登记标签',
      FEISHU_WEATHER_WARNING_REGISTRATION_MANAGER_CONFIRMATION_FIELD:
        '登记经理确认',
    } satisfies NodeJS.ProcessEnv;

    const config = loadWeatherWarningRegistrationRuntimeConfig(env);

    expect(config.registrationTableId).toBe('tbld85f2e4a48893');
    expect(config.registrationFields).toEqual({
      date: '登记时间',
      checker: '登记检查人',
      manager: '登记经理',
      guard: '登记戒备等级',
      device: '登记设备状态',
      deviceImage: '登记设备图片',
      deviceIssue: '登记设备异常',
      disaster: '登记灾害状态',
      disasterImage: '登记灾害图片',
      disasterIssue: '登记灾害异常',
      environment: '登记环境状态',
      environmentImage: '登记环境图片',
      environmentIssue: '登记环境异常',
      materials: '登记物资状态',
      materialsIssue: '登记物资异常',
      contacts: '登记联络状态',
      contactsIssue: '登记联络异常',
      building: '登记楼栋',
      tag: '登记标签',
      managerConfirmation: '登记经理确认',
    });
    expect(config.registrationFields.device).not.toBe('进度设备状态');
  });

  it('loads an explicit registration table without validating the progress table config', () => {
    const config = loadWeatherWarningRegistrationRuntimeConfig({
      FEISHU_WEATHER_WARNING_SOURCE_URL: SOURCE_URL,
      FEISHU_WEATHER_WARNING_CHECK_TABLE_ID:
        'invalid-progress-table-PRIVATE_VALUE_SHOULD_NOT_LEAK',
      FEISHU_WEATHER_WARNING_REGISTRATION_TABLE_ID: 'tbld85f2e4a48893',
    });

    expect(config).toEqual(
      expect.objectContaining({
        appToken: 'appWeatherWarning',
        wikiToken: '',
        registrationTableId: 'tbld85f2e4a48893',
      }),
    );
  });

  it.each([
    [
      'FEISHU_WEATHER_WARNING_REGISTRATION_TABLE_ID',
      'not-a-table-id-PRIVATE_VALUE_SHOULD_NOT_LEAK',
    ],
    ['FEISHU_WEATHER_WARNING_REGISTRATION_CHECKER_FIELD', '   '],
    [
      'FEISHU_WEATHER_WARNING_REGISTRATION_MANAGER_FIELD',
      '经理\nPRIVATE_VALUE_SHOULD_NOT_LEAK',
    ],
  ])('rejects and redacts an invalid %s override', (name, value) => {
    const env = {
      FEISHU_WEATHER_WARNING_SOURCE_URL: SOURCE_URL,
      [name]: value,
    };

    let error: unknown;
    try {
      loadWeatherWarningRegistrationRuntimeConfig(env);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain(name);
    expect((error as Error).message).not.toContain(
      'PRIVATE_VALUE_SHOULD_NOT_LEAK',
    );
  });

  it('rejects duplicate registration field overrides without echoing the value', () => {
    const envName = 'FEISHU_WEATHER_WARNING_REGISTRATION_CHECKER_FIELD';
    let error: unknown;

    try {
      loadWeatherWarningRegistrationRuntimeConfig({
        FEISHU_WEATHER_WARNING_SOURCE_URL: SOURCE_URL,
        [envName]: '机房经理',
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain(envName);
    expect((error as Error).message).not.toContain('机房经理');
  });
});
