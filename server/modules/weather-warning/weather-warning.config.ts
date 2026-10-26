import { ServiceUnavailableException } from '@nestjs/common';
import { parseFeishuBitableLink } from '@server/common/config/external-services.config';

export interface WeatherWarningSourceRuntimeConfig {
  appToken: string;
  wikiToken: string;
}

export interface WeatherWarningRuleRuntimeConfig extends WeatherWarningSourceRuntimeConfig {
  ruleTableId: string;
  ruleFields: {
    type: string;
    color: string;
    guard: string;
  };
}

export interface WeatherWarningCheckRuntimeConfig extends WeatherWarningSourceRuntimeConfig {
  checkTableId: string;
  checkFields: {
    date: string;
    building: string;
    guard: string;
    tag: string;
    device: string;
    deviceEvidence: string;
    deviceIssue: string;
    environment: string;
    environmentEvidence: string;
    environmentIssue: string;
    disaster: string;
    disasterEvidence: string;
    disasterIssue: string;
    materials: string;
    materialsIssue: string;
    contacts: string;
    contactsIssue: string;
    managerConfirmation: string;
  };
}

export interface WeatherWarningRuntimeConfig
  extends WeatherWarningRuleRuntimeConfig, WeatherWarningCheckRuntimeConfig {
  testRecipient: {
    openId: string;
    displayName: string;
  } | null;
}

const DEFAULT_SOURCE_URL =
  'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';
const DEFAULT_RULE_TABLE_ID = 'tbl249bff422a711';
const DEFAULT_CHECK_TABLE_ID = 'tblc4742cfc8398f';
const DEFAULT_RULE_FIELDS = {
  type: '预警类型',
  color: '预警等级',
  guard: '重保类型',
} as const;
const DEFAULT_CHECK_FIELDS = {
  date: '日期',
  building: '楼栋',
  guard: '重保戒备等级',
  tag: '重保标签',
  device: '检查设备安全项',
  deviceEvidence: '设备安全检查纸质图片',
  deviceIssue: '设备异常描述',
  environment: '检查环境安全项',
  environmentEvidence: '环境安全检查纸质图片',
  environmentIssue: '环境异常描述',
  disaster: '检查灾害专项',
  disasterEvidence: '灾害专项检查纸质图片',
  disasterIssue: '灾害异常描述',
  materials: '检查重保物资清单正常',
  materialsIssue: '重保物资异常描述',
  contacts: '检查重保联络清单人员齐备',
  contactsIssue: '联络清单异常描述',
  managerConfirmation: '机房经理确认',
} as const;

export function loadWeatherWarningRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): WeatherWarningRuntimeConfig {
  const ruleConfig = loadWeatherWarningRuleRuntimeConfig(env);
  const checkConfig = loadWeatherWarningCheckRuntimeConfig(env);
  const testOpenId = readWeatherWarningEnv(
    env,
    'FEISHU_WEATHER_WARNING_TEST_OPEN_ID',
  );
  if (testOpenId && !/^ou_/u.test(testOpenId)) {
    throwConfigurationUnavailable('FEISHU_WEATHER_WARNING_TEST_OPEN_ID');
  }

  return {
    ...ruleConfig,
    checkTableId: checkConfig.checkTableId,
    checkFields: checkConfig.checkFields,
    testRecipient: testOpenId
      ? {
          openId: testOpenId,
          displayName:
            readWeatherWarningEnv(
              env,
              'FEISHU_WEATHER_WARNING_TEST_RECIPIENT_NAME',
            ) || '示例人员020',
        }
      : null,
  };
}

export function loadWeatherWarningRuleRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): WeatherWarningRuleRuntimeConfig {
  const source = loadWeatherWarningSourceRuntimeConfig(env);
  const ruleTableId =
    readWeatherWarningEnv(env, 'FEISHU_WEATHER_WARNING_RULE_TABLE_ID') ||
    source.sourceTableId ||
    DEFAULT_RULE_TABLE_ID;
  if (!isBitableTableId(ruleTableId)) {
    throwConfigurationUnavailable('FEISHU_WEATHER_WARNING_RULE_TABLE_ID');
  }

  return {
    appToken: source.appToken,
    wikiToken: source.wikiToken,
    ruleTableId,
    ruleFields: {
      type:
        readWeatherWarningEnv(env, 'FEISHU_WEATHER_WARNING_RULE_TYPE_FIELD') ||
        DEFAULT_RULE_FIELDS.type,
      color:
        readWeatherWarningEnv(env, 'FEISHU_WEATHER_WARNING_RULE_COLOR_FIELD') ||
        DEFAULT_RULE_FIELDS.color,
      guard:
        readWeatherWarningEnv(env, 'FEISHU_WEATHER_WARNING_RULE_GUARD_FIELD') ||
        DEFAULT_RULE_FIELDS.guard,
    },
  };
}

export function loadWeatherWarningCheckRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): WeatherWarningCheckRuntimeConfig {
  const source = loadWeatherWarningSourceRuntimeConfig(env);
  const checkTableId =
    readWeatherWarningEnv(env, 'FEISHU_WEATHER_WARNING_CHECK_TABLE_ID') ||
    DEFAULT_CHECK_TABLE_ID;
  if (!isBitableTableId(checkTableId)) {
    throwConfigurationUnavailable('FEISHU_WEATHER_WARNING_CHECK_TABLE_ID');
  }

  return {
    appToken: source.appToken,
    wikiToken: source.wikiToken,
    checkTableId,
    checkFields: {
      date:
        readWeatherWarningEnv(env, 'FEISHU_WEATHER_WARNING_CHECK_DATE_FIELD') ||
        DEFAULT_CHECK_FIELDS.date,
      building:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_BUILDING_FIELD',
        ) || DEFAULT_CHECK_FIELDS.building,
      guard:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_GUARD_FIELD',
        ) || DEFAULT_CHECK_FIELDS.guard,
      tag:
        readWeatherWarningEnv(env, 'FEISHU_WEATHER_WARNING_CHECK_TAG_FIELD') ||
        DEFAULT_CHECK_FIELDS.tag,
      device:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_DEVICE_FIELD',
        ) || DEFAULT_CHECK_FIELDS.device,
      deviceEvidence:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_DEVICE_EVIDENCE_FIELD',
        ) || DEFAULT_CHECK_FIELDS.deviceEvidence,
      deviceIssue:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_DEVICE_ISSUE_FIELD',
        ) || DEFAULT_CHECK_FIELDS.deviceIssue,
      environment:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_FIELD',
        ) || DEFAULT_CHECK_FIELDS.environment,
      environmentEvidence:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_EVIDENCE_FIELD',
        ) || DEFAULT_CHECK_FIELDS.environmentEvidence,
      environmentIssue:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_ISSUE_FIELD',
        ) || DEFAULT_CHECK_FIELDS.environmentIssue,
      disaster:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_DISASTER_FIELD',
        ) || DEFAULT_CHECK_FIELDS.disaster,
      disasterEvidence:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_DISASTER_EVIDENCE_FIELD',
        ) || DEFAULT_CHECK_FIELDS.disasterEvidence,
      disasterIssue:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_DISASTER_ISSUE_FIELD',
        ) || DEFAULT_CHECK_FIELDS.disasterIssue,
      materials:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_MATERIALS_FIELD',
        ) || DEFAULT_CHECK_FIELDS.materials,
      materialsIssue:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_MATERIALS_ISSUE_FIELD',
        ) || DEFAULT_CHECK_FIELDS.materialsIssue,
      contacts:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_CONTACTS_FIELD',
        ) || DEFAULT_CHECK_FIELDS.contacts,
      contactsIssue:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_CONTACTS_ISSUE_FIELD',
        ) || DEFAULT_CHECK_FIELDS.contactsIssue,
      managerConfirmation:
        readWeatherWarningEnv(
          env,
          'FEISHU_WEATHER_WARNING_CHECK_MANAGER_CONFIRMATION_FIELD',
        ) || DEFAULT_CHECK_FIELDS.managerConfirmation,
    },
  };
}

function loadWeatherWarningSourceRuntimeConfig(
  env: NodeJS.ProcessEnv,
): WeatherWarningSourceRuntimeConfig & { sourceTableId: string } {
  const sourceUrl =
    readWeatherWarningEnv(env, 'FEISHU_WEATHER_WARNING_SOURCE_URL') ||
    DEFAULT_SOURCE_URL;
  const source = parseFeishuBitableLink(sourceUrl);
  if (!source.appToken && !source.wikiToken) {
    throwConfigurationUnavailable('FEISHU_WEATHER_WARNING_SOURCE_URL');
  }
  return {
    appToken: source.appToken,
    wikiToken: source.wikiToken,
    sourceTableId: source.tableId,
  };
}

function readWeatherWarningEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function isBitableTableId(value: string): boolean {
  return /^tbl[A-Za-z0-9]+$/u.test(value);
}

function throwConfigurationUnavailable(name: string): never {
  throw new ServiceUnavailableException(
    `Weather warning runtime configuration unavailable: ${name}`,
  );
}
