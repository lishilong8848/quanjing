import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  acquireWeatherWarningDeliveryLease,
  type DeliveryLease,
} from './weather-warning-delivery-state-store';
import type { WeatherWarningColor } from '@shared/api.interface';
import type { WeatherGuardLevel } from './weather-warning-rules';

const AUTOMATION_STATE_FILE_NAME = 'weather-warning-automation-state.json';
const EVENT_HASH = /^[0-9a-f]{24}$/u;
const TARGET_HASH = /^[0-9a-f]{16}$/u;
const FEISHU_MESSAGE_ID = /^om_[A-Za-z0-9_-]+$/u;
const WARNING_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;

export interface WeatherWarningAutomationDeliveryEntry {
  clientMutationId: string;
  messageId: string;
  sentAt: string;
  uuid: string;
  snapshotSignature: string;
}

export interface WeatherWarningAutomationActiveEvent {
  eventHash: string;
  openedAt: string;
  guardLevel: WeatherGuardLevel;
  highestGuardLevel: WeatherGuardLevel;
  revision: number;
  warningFingerprint: string;
  firstNotifiedAt?: string;
  primaryWarning?: WeatherWarningAutomationWarningSummary;
}

export interface WeatherWarningAutomationWarningSummary {
  id: string;
  title: string;
  type?: string;
  color?: WeatherWarningColor;
  startTime?: string;
  pubTime?: string;
}

export interface WeatherWarningAutomationPendingResolvedEvent {
  eventHash: string;
  openedAt: string;
  closedAt: string;
  highestGuardLevel: WeatherGuardLevel;
  firstNotifiedAt: string;
  notifiedTargetHashes: string[];
  primaryWarning?: WeatherWarningAutomationWarningSummary;
}

export interface WeatherWarningAutomationState {
  version: 3;
  entries: Record<string, WeatherWarningAutomationDeliveryEntry>;
  eventSequence: number;
  activeEvent: WeatherWarningAutomationActiveEvent | null;
  pendingResolvedEvents: Record<
    string,
    WeatherWarningAutomationPendingResolvedEvent
  >;
}

export type WeatherWarningAutomationLease = DeliveryLease;

export interface WeatherWarningAutomationStateOptions {
  cwd?: string;
  explicitPath?: string;
  configuredDirectory?: string;
  now?: Date;
}

export function resolveWeatherWarningAutomationStatePath(
  options: WeatherWarningAutomationStateOptions = {},
): string {
  const explicitPath = nonEmptyString(options.explicitPath);
  if (explicitPath) return resolve(explicitPath);

  const configuredDirectory = nonEmptyString(options.configuredDirectory);
  if (configuredDirectory) {
    return join(resolve(configuredDirectory), AUTOMATION_STATE_FILE_NAME);
  }

  return join(
    resolve(nonEmptyString(options.cwd) || process.cwd()),
    'data',
    AUTOMATION_STATE_FILE_NAME,
  );
}

export function readWeatherWarningAutomationStateFile(
  options: WeatherWarningAutomationStateOptions = {},
): WeatherWarningAutomationState {
  const statePath = resolveWeatherWarningAutomationStatePath(options);
  try {
    const details = lstatSync(statePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error('state file is not a regular file');
    }
    return normalizeState(JSON.parse(readFileSync(statePath, 'utf8')), true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyState();
    }
    throw new Error('天气预警自动化状态文件损坏');
  }
}

export function writeWeatherWarningAutomationStateFile(
  state: WeatherWarningAutomationState,
  options: WeatherWarningAutomationStateOptions = {},
): void {
  let persistedState: WeatherWarningAutomationState;
  try {
    persistedState = normalizeState(state, false);
  } catch {
    throw new Error('天气预警自动化状态无效');
  }

  const statePath = resolveWeatherWarningAutomationStatePath(options);
  if (existsSync(statePath)) {
    const details = lstatSync(statePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error('天气预警自动化状态路径不安全');
    }
  }

  mkdirSync(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(persistedState, null, 2)}\n`,
      'utf8',
    );
    renameSync(temporaryPath, statePath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function acquireWeatherWarningAutomationLease(
  options: WeatherWarningAutomationStateOptions = {},
): WeatherWarningAutomationLease | null {
  return acquireWeatherWarningDeliveryLease({
    explicitPath: resolveWeatherWarningAutomationStatePath(options),
    ...(options.now ? { now: options.now } : {}),
  });
}

function emptyState(): WeatherWarningAutomationState {
  return {
    version: 3,
    entries: {},
    eventSequence: 0,
    activeEvent: null,
    pendingResolvedEvents: {},
  };
}

function normalizeState(
  value: unknown,
  rejectUnknownFields: boolean,
): WeatherWarningAutomationState {
  if (!isRecord(value) || !isRecord(value.entries)) {
    throw new Error('state shape is invalid');
  }

  if (value.version === 1) {
    if (rejectUnknownFields) assertOnlyFields(value, ['version', 'entries']);
    return {
      version: 3,
      entries: normalizeEntries(value.entries, rejectUnknownFields),
      eventSequence: 0,
      activeEvent: null,
      pendingResolvedEvents: {},
    };
  }

  if (value.version === 2) {
    if (rejectUnknownFields) {
      assertOnlyFields(value, [
        'version',
        'entries',
        'eventSequence',
        'activeEvent',
      ]);
    }

    const eventSequence = requiredNonNegativeInteger(value.eventSequence);
    const legacyActiveEvent =
      value.activeEvent === null
        ? null
        : normalizeLegacyActiveEvent(value.activeEvent, rejectUnknownFields);
    if (legacyActiveEvent && eventSequence < 1) {
      throw new Error('event sequence is invalid');
    }

    return {
      version: 3,
      entries: normalizeEntries(value.entries, rejectUnknownFields),
      eventSequence,
      activeEvent:
        legacyActiveEvent && !legacyActiveEvent.closedAt
          ? withoutClosedAt(legacyActiveEvent)
          : null,
      pendingResolvedEvents: {},
    };
  }

  if (value.version !== 3) throw new Error('state version is invalid');
  if (rejectUnknownFields) {
    assertOnlyFields(value, [
      'version',
      'entries',
      'eventSequence',
      'activeEvent',
      'pendingResolvedEvents',
    ]);
  }

  if (!isRecord(value.pendingResolvedEvents)) {
    throw new Error('pending resolved events are invalid');
  }

  const eventSequence = requiredNonNegativeInteger(value.eventSequence);
  const activeEvent =
    value.activeEvent === null
      ? null
      : normalizeActiveEvent(value.activeEvent, rejectUnknownFields);
  const pendingResolvedEvents = normalizePendingResolvedEvents(
    value.pendingResolvedEvents,
    rejectUnknownFields,
  );
  if (activeEvent && pendingResolvedEvents[activeEvent.eventHash]) {
    throw new Error('event cannot be active and pending resolution');
  }
  if (
    (activeEvent || Object.keys(pendingResolvedEvents).length > 0) &&
    eventSequence < 1
  ) {
    throw new Error('event sequence is invalid');
  }

  return {
    version: 3,
    entries: normalizeEntries(value.entries, rejectUnknownFields),
    eventSequence,
    activeEvent,
    pendingResolvedEvents,
  };
}

function normalizeEntries(
  value: Record<string, unknown>,
  rejectUnknownFields: boolean,
): Record<string, WeatherWarningAutomationDeliveryEntry> {
  const entries: Record<string, WeatherWarningAutomationDeliveryEntry> = {};
  for (const [entryKey, rawEntry] of Object.entries(value)) {
    if (!isSafeKey(entryKey) || !isRecord(rawEntry)) {
      throw new Error('delivery entry is invalid');
    }
    if (rejectUnknownFields) {
      assertOnlyFields(rawEntry, [
        'clientMutationId',
        'messageId',
        'sentAt',
        'uuid',
        'snapshotSignature',
      ]);
    }
    const entry = {
      clientMutationId: requiredString(rawEntry.clientMutationId),
      messageId: requiredPattern(rawEntry.messageId, FEISHU_MESSAGE_ID),
      sentAt: requiredTimestamp(rawEntry.sentAt),
      uuid: requiredString(rawEntry.uuid),
      snapshotSignature: requiredString(rawEntry.snapshotSignature),
    };
    if (entry.clientMutationId !== entryKey) {
      throw new Error('delivery entry key mismatch');
    }
    entries[entryKey] = entry;
  }
  return entries;
}

function normalizeActiveEvent(
  value: unknown,
  rejectUnknownFields: boolean,
): WeatherWarningAutomationActiveEvent {
  if (!isRecord(value)) throw new Error('active event is invalid');
  if (rejectUnknownFields) {
    assertOnlyFields(value, [
      'eventHash',
      'openedAt',
      'guardLevel',
      'highestGuardLevel',
      'revision',
      'warningFingerprint',
      'firstNotifiedAt',
      'primaryWarning',
    ]);
  }

  const openedAt = requiredTimestamp(value.openedAt);
  const firstNotifiedAt =
    value.firstNotifiedAt === undefined
      ? undefined
      : requiredTimestamp(value.firstNotifiedAt);
  if (firstNotifiedAt && Date.parse(firstNotifiedAt) < Date.parse(openedAt)) {
    throw new Error('active event first notification time is invalid');
  }

  return {
    eventHash: requiredPattern(value.eventHash, EVENT_HASH),
    openedAt,
    guardLevel: requiredGuardLevel(value.guardLevel),
    highestGuardLevel: requiredGuardLevel(value.highestGuardLevel),
    revision: requiredPositiveInteger(value.revision),
    warningFingerprint: requiredPattern(
      value.warningFingerprint,
      WARNING_FINGERPRINT,
    ),
    ...(firstNotifiedAt ? { firstNotifiedAt } : {}),
    ...(value.primaryWarning === undefined
      ? {}
      : {
          primaryWarning: normalizeWarningSummary(
            value.primaryWarning,
            rejectUnknownFields,
          ),
        }),
  };
}

interface LegacyActiveEvent extends WeatherWarningAutomationActiveEvent {
  closedAt?: string;
}

function normalizeLegacyActiveEvent(
  value: unknown,
  rejectUnknownFields: boolean,
): LegacyActiveEvent {
  if (!isRecord(value)) throw new Error('active event is invalid');
  if (rejectUnknownFields) {
    assertOnlyFields(value, [
      'eventHash',
      'openedAt',
      'guardLevel',
      'highestGuardLevel',
      'revision',
      'warningFingerprint',
      'firstNotifiedAt',
      'primaryWarning',
      'closedAt',
    ]);
  }

  const guardLevel = requiredGuardLevel(value.guardLevel);
  const openedAt = requiredTimestamp(value.openedAt);
  const firstNotifiedAt =
    value.firstNotifiedAt === undefined
      ? undefined
      : requiredTimestamp(value.firstNotifiedAt);
  const closedAt =
    value.closedAt === undefined
      ? undefined
      : requiredTimestamp(value.closedAt);
  if (firstNotifiedAt && Date.parse(firstNotifiedAt) < Date.parse(openedAt)) {
    throw new Error('active event first notification time is invalid');
  }
  if (closedAt && Date.parse(closedAt) < Date.parse(openedAt)) {
    throw new Error('active event close time is invalid');
  }

  return {
    eventHash: requiredPattern(value.eventHash, EVENT_HASH),
    openedAt,
    guardLevel,
    highestGuardLevel:
      value.highestGuardLevel === undefined
        ? guardLevel
        : requiredGuardLevel(value.highestGuardLevel),
    revision: requiredPositiveInteger(value.revision),
    warningFingerprint: requiredPattern(
      value.warningFingerprint,
      WARNING_FINGERPRINT,
    ),
    ...(firstNotifiedAt ? { firstNotifiedAt } : {}),
    ...(value.primaryWarning === undefined
      ? {}
      : {
          primaryWarning: normalizeWarningSummary(
            value.primaryWarning,
            rejectUnknownFields,
          ),
        }),
    ...(closedAt ? { closedAt } : {}),
  };
}

function withoutClosedAt(
  event: LegacyActiveEvent,
): WeatherWarningAutomationActiveEvent {
  const { closedAt: _closedAt, ...activeEvent } = event;
  return activeEvent;
}

function normalizePendingResolvedEvents(
  value: Record<string, unknown>,
  rejectUnknownFields: boolean,
): Record<string, WeatherWarningAutomationPendingResolvedEvent> {
  const events: Record<string, WeatherWarningAutomationPendingResolvedEvent> =
    {};
  for (const [eventKey, rawEvent] of Object.entries(value)) {
    if (!isSafeKey(eventKey) || !isRecord(rawEvent)) {
      throw new Error('pending resolved event is invalid');
    }
    if (rejectUnknownFields) {
      assertOnlyFields(rawEvent, [
        'eventHash',
        'openedAt',
        'closedAt',
        'highestGuardLevel',
        'firstNotifiedAt',
        'notifiedTargetHashes',
        'primaryWarning',
      ]);
    }

    const openedAt = requiredTimestamp(rawEvent.openedAt);
    const closedAt = requiredTimestamp(rawEvent.closedAt);
    const firstNotifiedAt = requiredTimestamp(rawEvent.firstNotifiedAt);
    if (Date.parse(closedAt) < Date.parse(openedAt)) {
      throw new Error('pending resolved event close time is invalid');
    }
    if (
      Date.parse(firstNotifiedAt) < Date.parse(openedAt) ||
      Date.parse(firstNotifiedAt) > Date.parse(closedAt)
    ) {
      throw new Error('pending resolved event notification time is invalid');
    }
    if (!Array.isArray(rawEvent.notifiedTargetHashes)) {
      throw new Error('pending resolved event targets are invalid');
    }
    const notifiedTargetHashes = Array.from(
      new Set(
        rawEvent.notifiedTargetHashes.map((targetHash) =>
          requiredPattern(targetHash, TARGET_HASH),
        ),
      ),
    ).sort();
    if (notifiedTargetHashes.length < 1) {
      throw new Error('pending resolved event targets are empty');
    }

    const eventHash = requiredPattern(rawEvent.eventHash, EVENT_HASH);
    if (eventHash !== eventKey) {
      throw new Error('pending resolved event key mismatch');
    }
    events[eventKey] = {
      eventHash,
      openedAt,
      closedAt,
      highestGuardLevel: requiredGuardLevel(rawEvent.highestGuardLevel),
      firstNotifiedAt,
      notifiedTargetHashes,
      ...(rawEvent.primaryWarning === undefined
        ? {}
        : {
            primaryWarning: normalizeWarningSummary(
              rawEvent.primaryWarning,
              rejectUnknownFields,
            ),
          }),
    };
  }
  return events;
}

function normalizeWarningSummary(
  value: unknown,
  rejectUnknownFields: boolean,
): WeatherWarningAutomationWarningSummary {
  if (!isRecord(value)) throw new Error('warning summary is invalid');
  if (rejectUnknownFields) {
    assertOnlyFields(value, [
      'id',
      'title',
      'type',
      'color',
      'startTime',
      'pubTime',
    ]);
  }

  return {
    id: requiredBoundedString(value.id, 200),
    title: requiredBoundedString(value.title, 500),
    ...(value.type === undefined
      ? {}
      : { type: requiredBoundedString(value.type, 80) }),
    ...(value.color === undefined
      ? {}
      : { color: requiredWarningColor(value.color) }),
    ...(value.startTime === undefined
      ? {}
      : { startTime: requiredTimestamp(value.startTime) }),
    ...(value.pubTime === undefined
      ? {}
      : { pubTime: requiredTimestamp(value.pubTime) }),
  };
}

function requiredWarningColor(value: unknown): WeatherWarningColor {
  if (
    value === 'red' ||
    value === 'orange' ||
    value === 'yellow' ||
    value === 'blue'
  ) {
    return value;
  }
  throw new Error('warning color is invalid');
}

function requiredGuardLevel(value: unknown): WeatherGuardLevel {
  if (value === '一级戒备' || value === '二级戒备' || value === '三级戒备') {
    return value;
  }
  throw new Error('guard level is invalid');
}

function requiredNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('non-negative integer is required');
  }
  return Number(value);
}

function requiredPositiveInteger(value: unknown): number {
  const integer = requiredNonNegativeInteger(value);
  if (integer < 1) throw new Error('positive integer is required');
  return integer;
}

function requiredTimestamp(value: unknown): string {
  const timestamp = requiredString(value);
  const parsed = Date.parse(timestamp);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== timestamp
  ) {
    throw new Error('timestamp is invalid');
  }
  return timestamp;
}

function requiredPattern(value: unknown, pattern: RegExp): string {
  const text = requiredString(value);
  if (!pattern.test(text)) throw new Error('string pattern is invalid');
  return text;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('string is required');
  }
  return value;
}

function requiredBoundedString(value: unknown, maxLength: number): string {
  const text = requiredString(value).trim();
  if (text.length > maxLength || /[\u0000-\u001F\u007F]/u.test(text)) {
    throw new Error('bounded string is invalid');
  }
  return text;
}

function assertOnlyFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowedFields.includes(key))) {
    throw new Error('unexpected field');
  }
}

function isSafeKey(value: string): boolean {
  return (
    Boolean(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
  );
}

function nonEmptyString(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
