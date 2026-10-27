import { ServiceUnavailableException } from '@nestjs/common';

export type WeatherWarningAutomationReceiveIdType = 'chat_id' | 'open_id';
export type WeatherWarningAutomationAudience =
  | 'general_chat'
  | 'important_event_chat'
  | 'owner';

export interface WeatherWarningAutomationTarget {
  key: string;
  receiveIdType: WeatherWarningAutomationReceiveIdType;
  receiveId: string;
  displayName: string;
  audience: WeatherWarningAutomationAudience;
}

export interface WeatherWarningAutomationConfig {
  enabled: boolean;
  pollIntervalMs: number;
  reminderIntervalMs: number;
  targets: WeatherWarningAutomationTarget[];
  statePath: string;
  stateDirectory: string;
}

const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_REMINDER_INTERVAL_MS = 2 * 60 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 60 * 1000;
const MIN_REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const CHAT_ID_PATTERN = /^oc_[A-Za-z0-9_-]+$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/u;

export function loadWeatherWarningAutomationConfig(
  env: NodeJS.ProcessEnv = process.env,
): WeatherWarningAutomationConfig {
  const enabled = isEnabled(
    readAutomationEnv(env, 'FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED'),
  );
  const statePath = readAutomationEnv(
    env,
    'FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH',
  );
  const stateDirectory = readAutomationEnv(
    env,
    'FEISHU_WEATHER_WARNING_AUTOMATION_STATE_DIR',
  );
  if (!enabled) {
    return {
      enabled: false,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      reminderIntervalMs: DEFAULT_REMINDER_INTERVAL_MS,
      targets: [],
      statePath,
      stateDirectory,
    };
  }

  const chatIds = parseChatIds(
    readAutomationEnv(env, 'FEISHU_WEATHER_WARNING_CHAT_IDS'),
    'FEISHU_WEATHER_WARNING_CHAT_IDS',
  );
  if (chatIds.length === 0) {
    throwConfigurationUnavailable('FEISHU_WEATHER_WARNING_CHAT_IDS');
  }
  const ownerOpenId = readAutomationEnv(
    env,
    'FEISHU_WEATHER_WARNING_OWNER_OPEN_ID',
  );
  if (!OPEN_ID_PATTERN.test(ownerOpenId)) {
    throwConfigurationUnavailable('FEISHU_WEATHER_WARNING_OWNER_OPEN_ID');
  }
  const generalChatIds = new Set(chatIds);
  const configuredImportantEventChatIds = parseChatIds(
    readAutomationEnv(env, 'FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS'),
    'FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS',
  );
  if (configuredImportantEventChatIds.length === 0) {
    throwConfigurationUnavailable(
      'FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS',
    );
  }
  const importantEventChatIds = configuredImportantEventChatIds.filter(
    (chatId) => !generalChatIds.has(chatId),
  );

  return {
    enabled: true,
    pollIntervalMs: parseInterval(
      env,
      'FEISHU_WEATHER_WARNING_POLL_INTERVAL_MS',
      DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
    ),
    reminderIntervalMs: parseInterval(
      env,
      'FEISHU_WEATHER_WARNING_REMINDER_INTERVAL_MS',
      DEFAULT_REMINDER_INTERVAL_MS,
      MIN_REMINDER_INTERVAL_MS,
    ),
    targets: [
      ...chatIds.map((receiveId, index) => ({
        key: `chat-${index + 1}`,
        receiveIdType: 'chat_id' as const,
        receiveId,
        displayName: `天气预警群${index + 1}`,
        audience: 'general_chat' as const,
      })),
      ...importantEventChatIds.map((receiveId, index) => ({
        key: `important-event-chat-${index + 1}`,
        receiveIdType: 'chat_id' as const,
        receiveId,
        displayName: `重要事件通报群${index + 1}`,
        audience: 'important_event_chat' as const,
      })),
      {
        key: 'owner',
        receiveIdType: 'open_id',
        receiveId: ownerOpenId,
        displayName:
          readAutomationEnv(env, 'FEISHU_WEATHER_WARNING_OWNER_NAME') ||
          '马进宇',
        audience: 'owner',
      },
    ],
    statePath,
    stateDirectory,
  };
}

function parseChatIds(value: string, variableName: string): string[] {
  const chatIds = [
    ...new Set(
      value
        .split(/[;,\s]+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (chatIds.some((chatId) => !CHAT_ID_PATTERN.test(chatId))) {
    throwConfigurationUnavailable(variableName);
  }
  return chatIds;
}

function parseInterval(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const configured = readAutomationEnv(env, name);
  if (!configured) return fallback;
  if (!/^\d+$/u.test(configured)) throwConfigurationUnavailable(name);
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throwConfigurationUnavailable(name);
  }
  return value;
}

function isEnabled(value: string): boolean {
  return ['1', 'true', 'on', 'yes'].includes(value.toLowerCase());
}

function readAutomationEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function throwConfigurationUnavailable(name: string): never {
  throw new ServiceUnavailableException(
    `Weather warning automation configuration unavailable: ${name}`,
  );
}
