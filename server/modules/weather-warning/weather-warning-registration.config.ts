import { ServiceUnavailableException } from '@nestjs/common';
import { parseFeishuBitableLink } from '@server/common/config/external-services.config';

export interface WeatherWarningRegistrationFields {
  date: string;
  checker: string;
  manager: string;
  guard: string;
  device: string;
  deviceImage: string;
  deviceIssue: string;
  disaster: string;
  disasterImage: string;
  disasterIssue: string;
  environment: string;
  environmentImage: string;
  environmentIssue: string;
  materials: string;
  materialsIssue: string;
  contacts: string;
  contactsIssue: string;
  building: string;
  tag: string;
  managerConfirmation: string;
}

export interface WeatherWarningRegistrationRuntimeConfig {
  appToken: string;
  wikiToken: string;
  registrationTableId: string;
  registrationFields: WeatherWarningRegistrationFields;
}

const DEFAULT_REGISTRATION_FIELDS: WeatherWarningRegistrationFields = {
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
};

const REGISTRATION_FIELD_ENV_NAMES: Record<
  keyof WeatherWarningRegistrationFields,
  string
> = {
  date: 'FEISHU_WEATHER_WARNING_REGISTRATION_DATE_FIELD',
  checker: 'FEISHU_WEATHER_WARNING_REGISTRATION_CHECKER_FIELD',
  manager: 'FEISHU_WEATHER_WARNING_REGISTRATION_MANAGER_FIELD',
  guard: 'FEISHU_WEATHER_WARNING_REGISTRATION_GUARD_FIELD',
  device: 'FEISHU_WEATHER_WARNING_REGISTRATION_DEVICE_FIELD',
  deviceImage: 'FEISHU_WEATHER_WARNING_REGISTRATION_DEVICE_IMAGE_FIELD',
  deviceIssue: 'FEISHU_WEATHER_WARNING_REGISTRATION_DEVICE_ISSUE_FIELD',
  disaster: 'FEISHU_WEATHER_WARNING_REGISTRATION_DISASTER_FIELD',
  disasterImage: 'FEISHU_WEATHER_WARNING_REGISTRATION_DISASTER_IMAGE_FIELD',
  disasterIssue: 'FEISHU_WEATHER_WARNING_REGISTRATION_DISASTER_ISSUE_FIELD',
  environment: 'FEISHU_WEATHER_WARNING_REGISTRATION_ENVIRONMENT_FIELD',
  environmentImage:
    'FEISHU_WEATHER_WARNING_REGISTRATION_ENVIRONMENT_IMAGE_FIELD',
  environmentIssue:
    'FEISHU_WEATHER_WARNING_REGISTRATION_ENVIRONMENT_ISSUE_FIELD',
  materials: 'FEISHU_WEATHER_WARNING_REGISTRATION_MATERIALS_FIELD',
  materialsIssue: 'FEISHU_WEATHER_WARNING_REGISTRATION_MATERIALS_ISSUE_FIELD',
  contacts: 'FEISHU_WEATHER_WARNING_REGISTRATION_CONTACTS_FIELD',
  contactsIssue: 'FEISHU_WEATHER_WARNING_REGISTRATION_CONTACTS_ISSUE_FIELD',
  building: 'FEISHU_WEATHER_WARNING_REGISTRATION_BUILDING_FIELD',
  tag: 'FEISHU_WEATHER_WARNING_REGISTRATION_TAG_FIELD',
  managerConfirmation:
    'FEISHU_WEATHER_WARNING_REGISTRATION_MANAGER_CONFIRMATION_FIELD',
};

const REGISTRATION_TABLE_ID_ENV =
  'FEISHU_WEATHER_WARNING_REGISTRATION_TABLE_ID';
const SOURCE_URL_ENV = 'FEISHU_WEATHER_WARNING_SOURCE_URL';
const CHECK_TABLE_ID_ENV = 'FEISHU_WEATHER_WARNING_CHECK_TABLE_ID';
const DEFAULT_SOURCE_URL =
  'https://vnet.feishu.cn/base/Tmn8bjGnpasbLTskafbcRijvnKe?table=tbldeLoJJe6cPiHy&view=vewXWFTfcG';
const DEFAULT_CHECK_TABLE_ID = 'tblVFWuUbjo4GHOY';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function loadWeatherWarningRegistrationRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): WeatherWarningRegistrationRuntimeConfig {
  const source = loadRegistrationSource(env);
  const registrationTableId = hasOwn(env, REGISTRATION_TABLE_ID_ENV)
    ? readStrictOverride(env, REGISTRATION_TABLE_ID_ENV, isBitableTableId)
    : readDefaultCheckTableId(env);

  const registrationFields = Object.fromEntries(
    Object.entries(REGISTRATION_FIELD_ENV_NAMES).map(([key, envName]) => [
      key,
      hasOwn(env, envName)
        ? readStrictOverride(env, envName, isBitableFieldName)
        : DEFAULT_REGISTRATION_FIELDS[
            key as keyof WeatherWarningRegistrationFields
          ],
    ]),
  ) as unknown as WeatherWarningRegistrationFields;
  assertDistinctRegistrationFields(registrationFields, env);

  return {
    appToken: source.appToken,
    wikiToken: source.wikiToken,
    registrationTableId,
    registrationFields,
  };
}

function loadRegistrationSource(env: NodeJS.ProcessEnv): {
  appToken: string;
  wikiToken: string;
} {
  const sourceUrl = readOptionalEnv(env, SOURCE_URL_ENV) || DEFAULT_SOURCE_URL;
  const source = parseFeishuBitableLink(sourceUrl);
  if (!source.appToken && !source.wikiToken) {
    throwConfigurationUnavailable(SOURCE_URL_ENV);
  }
  return { appToken: source.appToken, wikiToken: source.wikiToken };
}

function readDefaultCheckTableId(env: NodeJS.ProcessEnv): string {
  const tableId =
    readOptionalEnv(env, CHECK_TABLE_ID_ENV) || DEFAULT_CHECK_TABLE_ID;
  if (!isBitableTableId(tableId)) {
    throwConfigurationUnavailable(CHECK_TABLE_ID_ENV);
  }
  return tableId;
}

function readOptionalEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function assertDistinctRegistrationFields(
  fields: WeatherWarningRegistrationFields,
  env: NodeJS.ProcessEnv,
): void {
  const seen = new Map<
    string,
    { key: keyof WeatherWarningRegistrationFields; envName: string }
  >();
  for (const key of Object.keys(fields) as Array<
    keyof WeatherWarningRegistrationFields
  >) {
    const value = fields[key];
    const envName = REGISTRATION_FIELD_ENV_NAMES[key];
    const previous = seen.get(value);
    if (previous) {
      const invalidEnvName = hasOwn(env, envName)
        ? envName
        : hasOwn(env, previous.envName)
          ? previous.envName
          : envName;
      throwConfigurationUnavailable(invalidEnvName);
    }
    seen.set(value, { key, envName });
  }
}

function readStrictOverride(
  env: NodeJS.ProcessEnv,
  name: string,
  validate: (value: string) => boolean,
): string {
  const rawValue = env[name];
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!validate(value)) {
    throwConfigurationUnavailable(name);
  }
  return value;
}

function isBitableTableId(value: string): boolean {
  return /^tbl[A-Za-z0-9]+$/u.test(value);
}

function isBitableFieldName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 100 &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function hasOwn(env: NodeJS.ProcessEnv, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, name);
}

function throwConfigurationUnavailable(name: string): never {
  throw new ServiceUnavailableException(
    `Weather warning registration configuration unavailable: ${name}`,
  );
}
