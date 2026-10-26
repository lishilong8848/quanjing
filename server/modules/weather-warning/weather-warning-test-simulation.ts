import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { readEnv } from '@server/common/config/external-services.config';
import type {
  WeatherWarningBuildingProgressSummary,
  WeatherWarningCheckKey,
  WeatherWarningCheckSummary,
  WeatherWarningGuardCompletionSummary,
  WeatherWarningMetricSnapshot,
  WeatherWarningSnapshot,
} from '@shared/api.interface';
import { getWeatherWarningActionTemplate } from './weather-warning-action-templates';
import { resolveWeatherWarningCheckScope } from './weather-warning-check-scope';
import { WEATHER_GUARD_BUILDINGS } from './weather-warning-registration.rules';

const TOKEN_VERSION = 'wte2e1';
const TOKEN_PURPOSE = 'weather-warning-full-flow-test-v1';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_CLOCK_SKEW_MS = 30 * 1000;
const MAX_WARNING_ID_LENGTH = 512;
const RUN_MUTATION_ID_PATTERN = /^weather-e2e-(\d{13})-([A-Za-z0-9-]{16,64})$/u;
const RUN_ID_PATTERN = /^[0-9a-f]{20}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DEVELOPMENT_EPHEMERAL_SECRET = randomBytes(32).toString('base64url');

interface SimulationTokenPayload {
  r: string;
  o: number;
  e: number;
}

export interface WeatherWarningTestSimulationContext {
  runId: string;
  warningId: string;
  tag: string;
  openedAt: string;
  expiresAt: string;
  snapshot: WeatherWarningSnapshot;
}

export interface WeatherWarningTestSimulationSnapshotOverrides {
  snapshotAt?: string;
  weather?: WeatherWarningMetricSnapshot | null;
  checkSummary?: WeatherWarningCheckSummary;
  buildingProgress?: WeatherWarningBuildingProgressSummary;
  guardCompletion?: WeatherWarningGuardCompletionSummary;
}

export function createWeatherWarningTestSimulationContext(
  clientMutationId: string,
  now = Date.now(),
): WeatherWarningTestSimulationContext {
  const openedAtMs = parseRunMutationId(clientMutationId);
  if (!isUsableEventWindow(openedAtMs, now)) {
    throw new Error('天气预警全流程测试操作号无效或已过期');
  }

  const payload: SimulationTokenPayload = {
    r: createHash('sha256').update(clientMutationId).digest('hex').slice(0, 20),
    o: openedAtMs,
    e: openedAtMs + TOKEN_TTL_MS,
  };
  return buildContext(payload, createSignedWarningId(payload));
}

export function isWeatherWarningTestSimulationId(value: string): boolean {
  return typeof value === 'string' && value.startsWith(`${TOKEN_VERSION}.`);
}

export function verifyWeatherWarningTestSimulationId(
  value: string,
  now = Date.now(),
): WeatherWarningTestSimulationContext | null {
  if (!isWeatherWarningTestSimulationId(value)) return null;
  if (value.length > MAX_WARNING_ID_LENGTH) return null;

  const tokenParts = value.split('.');
  if (tokenParts.length !== 3) return null;
  const [version, encodedPayload, actualSignature] = tokenParts;
  if (
    version !== TOKEN_VERSION ||
    !isCanonicalBase64Url(encodedPayload) ||
    !isCanonicalBase64Url(actualSignature)
  ) {
    return null;
  }

  let expectedSignature: string;
  try {
    expectedSignature = signEncodedPayload(encodedPayload);
  } catch {
    if (process.env.NODE_ENV === 'production')
      throw new Error('天气预警全流程测试签名密钥未配置');
    return null;
  }
  if (!safeEqualText(actualSignature, expectedSignature)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    );
  } catch {
    return null;
  }
  if (!isSimulationTokenPayload(payload, now)) return null;
  return buildContext(payload, value);
}

export function buildWeatherWarningTestSimulationSnapshot(
  context: WeatherWarningTestSimulationContext,
  overrides: WeatherWarningTestSimulationSnapshotOverrides = {},
): WeatherWarningSnapshot {
  return {
    ...context.snapshot,
    ...(overrides.snapshotAt ? { snapshotAt: overrides.snapshotAt } : {}),
    ...(Object.prototype.hasOwnProperty.call(overrides, 'weather')
      ? { weather: overrides.weather ?? null }
      : {}),
    ...(overrides.checkSummary ? { checkSummary: overrides.checkSummary } : {}),
    ...(overrides.buildingProgress
      ? { buildingProgress: overrides.buildingProgress }
      : {}),
    ...(overrides.guardCompletion
      ? { guardCompletion: overrides.guardCompletion }
      : {}),
  };
}

function parseRunMutationId(value: unknown): number {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error('天气预警全流程测试操作号无效或已过期');
  }
  const match = RUN_MUTATION_ID_PATTERN.exec(value);
  const openedAtMs = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(openedAtMs)) {
    throw new Error('天气预警全流程测试操作号无效或已过期');
  }
  return openedAtMs;
}

function isUsableEventWindow(openedAtMs: number, now: number): boolean {
  return (
    Number.isFinite(now) &&
    openedAtMs <= now + TOKEN_CLOCK_SKEW_MS &&
    now <= openedAtMs + TOKEN_TTL_MS
  );
}

function createSignedWarningId(payload: SimulationTokenPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const signature = signEncodedPayload(encodedPayload);
  const warningId = `${TOKEN_VERSION}.${encodedPayload}.${signature}`;
  if (warningId.length > MAX_WARNING_ID_LENGTH) {
    throw new Error('天气预警全流程测试操作号无效或已过期');
  }
  return warningId;
}

function signEncodedPayload(encodedPayload: string): string {
  const signingRoot = getSigningRoot();
  const signingKey = createHmac('sha256', signingRoot)
    .update(TOKEN_PURPOSE)
    .digest();
  return createHmac('sha256', signingKey)
    .update(`${TOKEN_VERSION}.${encodedPayload}`)
    .digest('base64url');
}

function getSigningRoot(): string {
  const configured =
    readEnv('WEATHER_WARNING_TEST_SIMULATION_SECRET') ||
    readEnv('FEISHU_APP_SECRET') ||
    readEnv('APP_SECRET');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('天气预警全流程测试签名密钥未配置');
  }
  return DEVELOPMENT_EPHEMERAL_SECRET;
}

function isSimulationTokenPayload(
  value: unknown,
  now: number,
): value is SimulationTokenPayload {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys.join(',') !== 'e,o,r') return false;

  const runId = value.r;
  const openedAtMs = value.o;
  const expiresAtMs = value.e;
  return (
    typeof runId === 'string' &&
    RUN_ID_PATTERN.test(runId) &&
    typeof openedAtMs === 'number' &&
    Number.isSafeInteger(openedAtMs) &&
    typeof expiresAtMs === 'number' &&
    Number.isSafeInteger(expiresAtMs) &&
    expiresAtMs - openedAtMs === TOKEN_TTL_MS &&
    isUsableEventWindow(openedAtMs, now)
  );
}

function buildContext(
  payload: SimulationTokenPayload,
  warningId: string,
): WeatherWarningTestSimulationContext {
  const openedAt = new Date(payload.o).toISOString();
  const expiresAt = new Date(payload.e).toISOString();
  const tag = `全流程测试/${payload.r}`;
  const buildingProgress = createInitialBuildingProgress();
  const matchedWarning = {
    id: warningId,
    title: '【全流程测试】南通市气象台发布台风蓝色预警',
    type: '台风',
    color: 'blue',
    guardLevel: '三级戒备',
    startTime: openedAt,
    endTime: expiresAt,
    pubTime: openedAt,
    status: 'active',
  } as const;
  const requiredCheckKeys =
    resolveWeatherWarningCheckScope(matchedWarning).requiredCheckKeys;
  const snapshot: WeatherWarningSnapshot = {
    status: 'active',
    sourceState: 'fresh',
    guardDecisionState: 'fresh',
    checkSyncState: 'fresh',
    snapshotAt: openedAt,
    lastSuccessAt: openedAt,
    guardLevel: '三级戒备',
    matchedWarnings: [matchedWarning],
    unmatchedWarnings: [],
    actions: getWeatherWarningActionTemplate('三级戒备'),
    weather: {
      temperature: '32℃',
      feelsLike: '35℃',
      humidity: '72%',
      windDirection: '东风',
      windScale: '3级',
      observedAt: openedAt,
    },
    checkSummary: createNotStartedCheckSummary(requiredCheckKeys),
    requiredCheckKeys: [...requiredCheckKeys],
    buildingProgress,
    canSendTest: true,
  };
  return {
    runId: payload.r,
    warningId,
    tag,
    openedAt,
    expiresAt,
    snapshot,
  };
}

function createNotStartedCheckSummary(
  requiredCheckKeys: readonly WeatherWarningCheckKey[],
): WeatherWarningCheckSummary {
  const required = new Set(requiredCheckKeys);
  return {
    device: required.has('device') ? 'not_started' : 'not_required',
    environment: required.has('environment') ? 'not_started' : 'not_required',
    disaster: required.has('disaster') ? 'not_started' : 'not_required',
    materials: required.has('materials') ? 'not_started' : 'not_required',
    contacts: required.has('contacts') ? 'not_started' : 'not_required',
    managerConfirmation: required.has('managerConfirmation')
      ? 'not_started'
      : 'not_required',
    abnormalSummaries: [],
  };
}

function createInitialBuildingProgress(): WeatherWarningBuildingProgressSummary {
  const missingRegistrationBuildings = [...WEATHER_GUARD_BUILDINGS];
  return {
    available: true,
    buildings: [],
    missingRegistrationBuildings,
    unassignedRecordCount: 0,
    incompleteItems: missingRegistrationBuildings.map((building) => ({
      building,
      key: 'registration',
      label: '未提交戒备登记',
      state: 'missing_registration',
    })),
  };
}

function isCanonicalBase64Url(value: string): boolean {
  if (!BASE64URL_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, 'base64url').toString('base64url') === value;
  } catch {
    return false;
  }
}

function safeEqualText(left: string, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
