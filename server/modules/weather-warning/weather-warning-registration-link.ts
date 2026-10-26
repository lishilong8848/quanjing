export interface WeatherGuardRegistrationLinkInput {
  publicBaseUrl: string;
  clientBasePath: string;
  warningId: string;
  source: 'feishu-card' | 'test-card';
}

export interface WeatherGuardRegistrationEnvironmentLike {
  readonly [key: string]: unknown;
  readonly PUBLIC_BASE_URL?: unknown;
  readonly CLIENT_BASE_PATH?: unknown;
}

export interface WeatherGuardRegistrationSnapshotLike {
  readonly matchedWarnings: readonly {
    readonly id?: unknown;
  }[];
}

const INVALID_PUBLIC_BASE_URL_MESSAGE =
  '天气戒备登记链接必须使用无凭据 HTTPS 公网基址';
const INVALID_CLIENT_BASE_PATH_MESSAGE = 'CLIENT_BASE_PATH 配置无效';
const INVALID_WARNING_ID_MESSAGE = '天气预警 ID 无效';
const INVALID_SOURCE_MESSAGE = '天气戒备登记链接来源无效';
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const MAX_WARNING_ID_LENGTH = 512;
const DNS_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const NUMERIC_TLD_PATTERN = /^\d+$/u;
const SPECIAL_USE_DNS_SUFFIXES = new Set([
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'home',
  'home.arpa',
  'test',
  'invalid',
  'example',
  'example.com',
  'example.net',
  'example.org',
  'onion',
  'alt',
  'arpa',
]);
const MAX_DNS_HOSTNAME_LENGTH = 253;
const MAX_PATH_DECODE_DEPTH = 5;

export function buildWeatherGuardRegistrationUrl(
  input: WeatherGuardRegistrationLinkInput,
): string {
  const { base, publicBasePath } = parsePublicBaseUrl(input?.publicBaseUrl);
  const clientBasePath = normalizeSafeBasePath(
    input?.clientBasePath,
    INVALID_CLIENT_BASE_PATH_MESSAGE,
  );
  const warningId = validateWarningId(input?.warningId);
  const source = validateSource(input?.source);

  base.pathname = `/${[
    trimPathSlashes(publicBasePath),
    trimPathSlashes(clientBasePath),
    'monthly-schedule',
  ]
    .filter(Boolean)
    .join('/')}`;
  base.searchParams.set('weatherGuardRegistration', '1');
  base.searchParams.set('warningId', warningId);
  base.searchParams.set('source', source);
  return base.toString();
}

export function buildWeatherGuardRegistrationUrlFromSnapshot(
  environment: WeatherGuardRegistrationEnvironmentLike,
  snapshot: WeatherGuardRegistrationSnapshotLike,
  source: WeatherGuardRegistrationLinkInput['source'],
): string {
  const publicBaseUrl = environment?.PUBLIC_BASE_URL;
  const clientBasePath = environment?.CLIENT_BASE_PATH;
  const warningId = snapshot?.matchedWarnings?.[0]?.id;

  return buildWeatherGuardRegistrationUrl({
    publicBaseUrl: typeof publicBaseUrl === 'string' ? publicBaseUrl : '',
    clientBasePath: typeof clientBasePath === 'string' ? clientBasePath : '',
    warningId: typeof warningId === 'string' ? warningId : '',
    source,
  });
}

function parsePublicBaseUrl(value: unknown): {
  base: URL;
  publicBasePath: string;
} {
  const publicBaseUrl = typeof value === 'string' ? value.trim() : '';
  if (
    !publicBaseUrl ||
    publicBaseUrl.includes('\\') ||
    CONTROL_CHARACTER_PATTERN.test(publicBaseUrl)
  ) {
    throw new Error(INVALID_PUBLIC_BASE_URL_MESSAGE);
  }

  let base: URL;
  try {
    base = new URL(publicBaseUrl);
  } catch {
    throw new Error(INVALID_PUBLIC_BASE_URL_MESSAGE);
  }

  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !isCanonicalPublicDnsHostname(base.hostname)
  ) {
    throw new Error(INVALID_PUBLIC_BASE_URL_MESSAGE);
  }
  return {
    base,
    publicBasePath: normalizeSafeBasePath(
      extractRawPathname(publicBaseUrl),
      INVALID_PUBLIC_BASE_URL_MESSAGE,
    ),
  };
}

function normalizeSafeBasePath(value: unknown, invalidMessage: string): string {
  if (typeof value !== 'string') {
    throw new Error(invalidMessage);
  }
  const path = value.trim();
  if (!path || path === '/') return '';
  if (
    path.includes('\\') ||
    CONTROL_CHARACTER_PATTERN.test(path) ||
    /[?#]/u.test(path) ||
    /^[A-Za-z][A-Za-z\d+.-]*:/u.test(path) ||
    path.startsWith('//')
  ) {
    throw new Error(invalidMessage);
  }

  const segments = trimPathSlashes(path).split('/');
  if (segments.some((segment) => !isSafePathSegment(segment))) {
    throw new Error(invalidMessage);
  }
  return `/${segments.join('/')}`;
}

function isSafePathSegment(segment: string): boolean {
  if (!segment) return false;
  let decoded = segment;
  for (let depth = 0; depth < MAX_PATH_DECODE_DEPTH; depth += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      CONTROL_CHARACTER_PATTERN.test(decoded)
    ) {
      return false;
    }
    if (!decoded.includes('%')) return true;
  }
  return false;
}

function validateWarningId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_WARNING_ID_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new Error(INVALID_WARNING_ID_MESSAGE);
  }
  return value;
}

function validateSource(value: unknown): 'feishu-card' | 'test-card' {
  if (value !== 'feishu-card' && value !== 'test-card') {
    throw new Error(INVALID_SOURCE_MESSAGE);
  }
  return value;
}

function isCanonicalPublicDnsHostname(value: string): boolean {
  if (!value || value.length > MAX_DNS_HOSTNAME_LENGTH || value.endsWith('.')) {
    return false;
  }

  const hostname = value.toLowerCase();
  const labels = hostname.split('.');
  if (
    labels.length < 2 ||
    labels.some(
      (label) => label.length > 63 || !DNS_LABEL_PATTERN.test(label),
    ) ||
    NUMERIC_TLD_PATTERN.test(labels.at(-1) ?? '')
  ) {
    return false;
  }

  return [...SPECIAL_USE_DNS_SUFFIXES].every(
    (suffix) => hostname !== suffix && !hostname.endsWith(`.${suffix}`),
  );
}

function extractRawPathname(publicBaseUrl: string): string {
  const authorityStart = publicBaseUrl.indexOf('://') + 3;
  const pathnameStart = publicBaseUrl.indexOf('/', authorityStart);
  return pathnameStart === -1 ? '' : publicBaseUrl.slice(pathnameStart);
}

function trimPathSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/gu, '');
}
