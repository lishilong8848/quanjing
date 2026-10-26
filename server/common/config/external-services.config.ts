export type FeishuCardActionConsumerProfile =
  | 'production'
  | 'local-test'
  | 'disabled';

export interface FeishuAppCredentials {
  appId: string;
  appSecret: string;
}

const FEISHU_CARD_ACTION_CONSUMER_PROFILES =
  new Set<FeishuCardActionConsumerProfile>([
    'production',
    'local-test',
    'disabled',
  ]);

function readRawEnv(name: string): string {
  return process.env[name]?.trim() || '';
}

export function getFeishuCardActionConsumerProfile(): FeishuCardActionConsumerProfile | null {
  const configured = readRawEnv(
    'FEISHU_CARD_ACTION_CONSUMER_PROFILE',
  ).toLowerCase();
  if (!configured) return null;
  if (
    FEISHU_CARD_ACTION_CONSUMER_PROFILES.has(
      configured as FeishuCardActionConsumerProfile,
    )
  ) {
    return configured as FeishuCardActionConsumerProfile;
  }
  throw new Error(
    'FEISHU_CARD_ACTION_CONSUMER_PROFILE 仅支持 production、local-test、disabled',
  );
}

export function getEffectiveFeishuAppCredentials(): FeishuAppCredentials {
  const profile = getFeishuCardActionConsumerProfile();
  const productionAppId = readRawEnv('FEISHU_APP_ID');
  const productionAppSecret = readRawEnv('FEISHU_APP_SECRET');

  if (profile !== 'local-test') {
    return {
      appId: productionAppId,
      appSecret: productionAppSecret,
    };
  }

  const testAppId = readRawEnv('FEISHU_CARD_ACTION_TEST_APP_ID');
  const testAppSecret = readRawEnv('FEISHU_CARD_ACTION_TEST_APP_SECRET');
  if (!productionAppId) {
    throw new Error(
      'local-test 必须配置 FEISHU_APP_ID，用于确认测试应用与生产应用不同',
    );
  }
  if (!testAppId || !testAppSecret) {
    throw new Error(
      'local-test 缺少隔离测试应用配置：请配置 FEISHU_CARD_ACTION_TEST_APP_ID 和 FEISHU_CARD_ACTION_TEST_APP_SECRET',
    );
  }
  if (testAppId === productionAppId) {
    throw new Error(
      'FEISHU_CARD_ACTION_TEST_APP_ID 与生产 FEISHU_APP_ID 必须不同',
    );
  }

  return { appId: testAppId, appSecret: testAppSecret };
}

export function readEnv(name: string, aliases: string[] = []): string {
  for (const key of [name, ...aliases]) {
    let value: string;
    if (key === 'FEISHU_APP_ID' || key === 'FEISHU_APP_SECRET') {
      const credentials = getEffectiveFeishuAppCredentials();
      value =
        key === 'FEISHU_APP_ID' ? credentials.appId : credentials.appSecret;
    } else {
      value = readRawEnv(key);
    }
    if (value) {
      return value;
    }
  }
  return '';
}

export interface FeishuBitableLinkConfig {
  appToken: string;
  wikiToken: string;
  tableId: string;
  viewId: string;
}

export function parseFeishuBitableLink(value: string): FeishuBitableLinkConfig {
  const empty: FeishuBitableLinkConfig = {
    appToken: '',
    wikiToken: '',
    tableId: '',
    viewId: '',
  };
  const source = value.trim();

  if (!source) {
    return empty;
  }

  try {
    const url = new URL(source);
    const segments = url.pathname.split('/').filter(Boolean);
    const wikiIndex = segments.findIndex((segment) => segment === 'wiki');
    const baseIndex = segments.findIndex(
      (segment) => segment === 'base' || segment === 'bitable',
    );

    return {
      appToken: baseIndex >= 0 ? segments[baseIndex + 1] || '' : '',
      wikiToken: wikiIndex >= 0 ? segments[wikiIndex + 1] || '' : '',
      tableId: normalizeBitableId(url.searchParams.get('table') || '', 'tbl'),
      viewId: normalizeBitableId(url.searchParams.get('view') || '', 'vew'),
    };
  } catch {
    return {
      ...empty,
      tableId: normalizeBitableId(source, 'tbl'),
      viewId: normalizeBitableId(source, 'vew'),
    };
  }
}

function normalizeBitableId(value: string, prefix: string): string {
  const id = value.trim();
  return id.startsWith(prefix) ? id : '';
}

export function getFeishuAuthPayload() {
  const { appId, appSecret } = getEffectiveFeishuAppCredentials();

  if (!appId || !appSecret) {
    throw new Error(
      '缺少飞书开放平台配置：请在 .env 中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET',
    );
  }

  return {
    app_id: appId,
    app_secret: appSecret,
  };
}

export function assertBitableTableConfig(
  tableName: string,
  appToken: string,
  tableId: string,
) {
  if (!appToken || !tableId) {
    throw new Error(
      `缺少${tableName}多维表配置：请在 .env 中配置对应的 APP_TOKEN 和 TABLE_ID`,
    );
  }
}

export function maskSecret(value: string): string {
  if (!value) return '<empty>';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
