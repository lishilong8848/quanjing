import { ServiceUnavailableException } from '@nestjs/common';
import { parseFeishuBitableLink } from '@server/common/config/external-services.config';

export interface EmployeeOnboardingConfig {
  appToken: string;
  wikiToken: string;
  tableId: string;
  tableName: '员工信息池（全量）';
}

const TABLE_NAME = '员工信息池（全量）' as const;
const DEFAULT_SOURCE_URL =
  'https://vnet.feishu.cn/wiki/AdQmwOqwei6Xr4kag3pcp1Flnmg?table=tblOu75UtJTDNHIM&view=vewrQcypV4';
const CONFIGURATION_ERROR_MESSAGE = '新员工入职数据源配置不可用，请联系管理员';

const DEDICATED_SOURCE_URL_ENV = 'FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL';
const DEDICATED_APP_TOKEN_ENV = 'FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN';
const DEDICATED_WIKI_TOKEN_ENV = 'FEISHU_EMPLOYEE_ONBOARDING_WIKI_TOKEN';
const DEDICATED_TABLE_ID_ENV = 'FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID';

const SOURCE_URL_ALIASES = [
  'FEISHU_PERSONNEL_MOVEMENT_SOURCE_URL',
  'FEISHU_ORG_SOURCE_URL',
  'FEISHU_ORGANIZATION_SOURCE_URL',
] as const;
const APP_TOKEN_ALIASES = [
  'FEISHU_PERSONNEL_MOVEMENT_APP_TOKEN',
  'FEISHU_ORG_APP_TOKEN',
  'FEISHU_ORGANIZATION_APP_TOKEN',
] as const;
const WIKI_TOKEN_ALIASES = [
  'FEISHU_PERSONNEL_MOVEMENT_WIKI_TOKEN',
  'FEISHU_ORG_WIKI_TOKEN',
  'FEISHU_ORGANIZATION_WIKI_TOKEN',
] as const;
const TABLE_ID_ALIASES = [
  'FEISHU_PERSONNEL_MOVEMENT_TABLE_ID',
  'FEISHU_ORG_TABLE_ID',
  'FEISHU_ORGANIZATION_TABLE_ID',
] as const;

const FEISHU_TOKEN_PATTERN = /^[A-Za-z0-9]{10,128}$/u;
const BITABLE_TABLE_ID_PATTERN = /^tbl[A-Za-z0-9]+$/u;
const MAX_PATH_DECODE_ROUNDS = 3;

export function readEmployeeOnboardingConfig(
  env: NodeJS.ProcessEnv = process.env,
): EmployeeOnboardingConfig {
  assertConfiguredSourceUrls(env);

  const dedicatedSourceUrl = clean(env[DEDICATED_SOURCE_URL_ENV]);
  const aliasSourceUrl = readFirst(env, SOURCE_URL_ALIASES);
  const dedicatedSource = parseFeishuBitableLink(dedicatedSourceUrl);
  const aliasSource = parseFeishuBitableLink(aliasSourceUrl);
  const defaultSource = parseFeishuBitableLink(DEFAULT_SOURCE_URL);

  const { appToken, wikiToken } = selectTokenLayer(
    {
      appToken: clean(env[DEDICATED_APP_TOKEN_ENV]),
      wikiToken: clean(env[DEDICATED_WIKI_TOKEN_ENV]),
    },
    dedicatedSource,
    {
      appToken: readFirst(env, APP_TOKEN_ALIASES),
      wikiToken: readFirst(env, WIKI_TOKEN_ALIASES),
    },
    aliasSource,
    defaultSource,
  );

  const tableId =
    clean(env[DEDICATED_TABLE_ID_ENV]) ||
    dedicatedSource.tableId ||
    readFirst(env, TABLE_ID_ALIASES) ||
    aliasSource.tableId ||
    defaultSource.tableId;

  assertToken(appToken);
  assertToken(wikiToken);
  if (!appToken && !wikiToken) {
    throwConfigurationUnavailable();
  }
  if (!BITABLE_TABLE_ID_PATTERN.test(tableId)) {
    throwConfigurationUnavailable();
  }

  return { appToken, wikiToken, tableId, tableName: TABLE_NAME };
}

function assertConfiguredSourceUrls(env: NodeJS.ProcessEnv): void {
  for (const envName of [DEDICATED_SOURCE_URL_ENV, ...SOURCE_URL_ALIASES]) {
    const sourceUrl = clean(env[envName]);
    if (sourceUrl) {
      assertValidSourceUrl(sourceUrl);
    }
  }
}

function selectTokenLayer(
  ...layers: Array<{ appToken: string; wikiToken: string }>
): { appToken: string; wikiToken: string } {
  return (
    layers.find((layer) => layer.appToken || layer.wikiToken) || {
      appToken: '',
      wikiToken: '',
    }
  );
}

function assertValidSourceUrl(sourceUrl: string): void {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throwConfigurationUnavailable();
  }

  if (url.protocol !== 'https:' || !isFeishuHostname(url.hostname)) {
    throwConfigurationUnavailable();
  }

  const normalizedPathname = decodeAndNormalizePathname(url.pathname);
  if (isShareFormPath(normalizedPathname)) {
    throwConfigurationUnavailable();
  }

  const source = parseFeishuBitableLink(sourceUrl);
  const hasAppToken = Boolean(source.appToken);
  const hasWikiToken = Boolean(source.wikiToken);
  if (hasAppToken === hasWikiToken) {
    throwConfigurationUnavailable();
  }

  assertToken(source.appToken);
  assertToken(source.wikiToken);
  if (!BITABLE_TABLE_ID_PATTERN.test(source.tableId)) {
    throwConfigurationUnavailable();
  }
}

function decodeAndNormalizePathname(pathname: string): string {
  let decoded = pathname;
  for (let round = 0; round < MAX_PATH_DECODE_ROUNDS; round += 1) {
    if (!decoded.includes('%')) {
      break;
    }
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throwConfigurationUnavailable();
    }
  }

  if (decoded.includes('%')) {
    throwConfigurationUnavailable();
  }
  return decoded.replace(/\\/gu, '/').replace(/\/+/gu, '/');
}

function isShareFormPath(pathname: string): boolean {
  const segments = pathname
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  for (let index = 0; index <= segments.length - 3; index += 1) {
    if (
      segments[index] === 'share' &&
      segments[index + 1] === 'base' &&
      segments[index + 2] === 'form'
    ) {
      return true;
    }
  }
  return false;
}

function isFeishuHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === 'feishu.cn' ||
    normalizedHostname.endsWith('.feishu.cn') ||
    normalizedHostname === 'larksuite.com' ||
    normalizedHostname.endsWith('.larksuite.com')
  );
}

function assertToken(value: string): void {
  if (!value) {
    return;
  }
  if (value.toLowerCase() === 'form' || !FEISHU_TOKEN_PATTERN.test(value)) {
    throwConfigurationUnavailable();
  }
}

function readFirst(env: NodeJS.ProcessEnv, names: readonly string[]): string {
  for (const name of names) {
    const value = clean(env[name]);
    if (value) {
      return value;
    }
  }
  return '';
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function throwConfigurationUnavailable(): never {
  throw new ServiceUnavailableException(CONFIGURATION_ERROR_MESSAGE);
}
