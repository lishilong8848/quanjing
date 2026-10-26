import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  WeatherWarningCheckKey,
  WeatherWarningColor,
  WeatherWarningDisplayWarning,
  WeatherWarningIncompleteItem,
  WeatherWarningSnapshot,
} from '@shared/api.interface';
import {
  buildWeatherWarningCard,
  buildWeatherWarningReminderCard,
  buildWeatherWarningResolvedCard,
  type WeatherWarningReminderItem,
} from './weather-warning-card';
import { resolveWeatherWarningCheckScope } from './weather-warning-check-scope';
import { loadWeatherWarningFeatureConfig } from './weather-warning-feature.config';
import { buildWeatherGuardRegistrationUrlFromSnapshot } from './weather-warning-registration-link';
import {
  loadWeatherWarningAutomationConfig,
  type WeatherWarningAutomationConfig,
  type WeatherWarningAutomationTarget,
} from './weather-warning-automation.config';
import {
  acquireWeatherWarningAutomationLease,
  readWeatherWarningAutomationStateFile,
  writeWeatherWarningAutomationStateFile,
  type WeatherWarningAutomationActiveEvent,
  type WeatherWarningAutomationPendingResolvedEvent,
  type WeatherWarningAutomationState,
  type WeatherWarningAutomationStateOptions,
  type WeatherWarningAutomationWarningSummary,
} from './weather-warning-automation-state-store';
import { WeatherWarningBitableService } from './weather-warning-bitable.service';
import { WeatherWarningNotificationService } from './weather-warning-notification.service';
import type { WeatherGuardLevel } from './weather-warning-rules';
import { WeatherWarningSnapshotService } from './weather-warning-snapshot.service';

export type WeatherWarningAutomationRunStatus =
  | 'disabled'
  | 'busy'
  | 'no-active-warning'
  | 'progress-unavailable'
  | 'resolved'
  | 'processed';

export interface WeatherWarningAutomationRunResult {
  status: WeatherWarningAutomationRunStatus;
  sentCount: number;
  failedCount: number;
  eventHash?: string;
  reminderSkippedReason?: 'building-progress-unavailable';
}

type NotificationRevision = 'initial' | 'upgrade';

interface ResolvedDeliveryResult {
  hadPending: boolean;
  sentCount: number;
  failedCount: number;
  eventHash?: string;
}

const COLOR_LABELS: Record<WeatherWarningColor, string> = {
  red: '红色',
  orange: '橙色',
  yellow: '黄色',
  blue: '蓝色',
};
const WARNING_COLOR_PRIORITY: Record<WeatherWarningColor, number> = {
  red: 4,
  orange: 3,
  yellow: 2,
  blue: 1,
};
const GUARD_LEVEL_PRIORITY: Record<WeatherGuardLevel, number> = {
  一级戒备: 3,
  二级戒备: 2,
  三级戒备: 1,
};
@Injectable()
export class WeatherWarningAutomationService {
  private readonly logger = new Logger(WeatherWarningAutomationService.name);
  private readonly clearObservationCounts = new Map<string, number>();
  private readonly lastActiveSeenAt = new Map<string, number>();

  constructor(
    private readonly weatherWarningSnapshotService: WeatherWarningSnapshotService,
    private readonly weatherWarningNotificationService: WeatherWarningNotificationService,
    private readonly weatherWarningBitableService: WeatherWarningBitableService,
  ) {}

  async runDue(
    now: Date = new Date(),
  ): Promise<WeatherWarningAutomationRunResult> {
    const config = loadWeatherWarningAutomationConfig();
    if (!config.enabled) {
      return { status: 'disabled', sentCount: 0, failedCount: 0 };
    }

    const stateOptions = getStateOptions(config, now);
    const lease = acquireWeatherWarningAutomationLease(stateOptions);
    if (!lease) return { status: 'busy', sentCount: 0, failedCount: 0 };

    try {
      const state = readWeatherWarningAutomationStateFile(stateOptions);
      const previouslyPending = await this.deliverPendingResolvedEvents(
        state,
        config.targets,
        stateOptions,
      );
      const featureConfig = loadWeatherWarningFeatureConfig();
      const snapshot = await this.weatherWarningSnapshotService.getSnapshot({
        forceRefresh: true,
        forceRuleRefresh: false,
        includeCheckProgress: featureConfig.progressNotificationsEnabled,
      });

      if (isConfirmedClearSnapshot(snapshot)) {
        const activeEvent = state.activeEvent;
        if (
          activeEvent &&
          isTrackedWarningStillActive(activeEvent, snapshot.unmatchedWarnings)
        ) {
          this.clearObservationCounts.delete(activeEvent.eventHash);
          this.lastActiveSeenAt.set(activeEvent.eventHash, now.getTime());
          return {
            status: previouslyPending.hadPending
              ? 'resolved'
              : 'no-active-warning',
            sentCount: previouslyPending.sentCount,
            failedCount: previouslyPending.failedCount,
            eventHash: activeEvent.eventHash,
          };
        }
        if (
          activeEvent &&
          !this.hasConfirmedConsecutiveClear(
            activeEvent.eventHash,
            now,
            config.pollIntervalMs,
          )
        ) {
          return {
            status: previouslyPending.hadPending
              ? 'resolved'
              : 'no-active-warning',
            sentCount: previouslyPending.sentCount,
            failedCount: previouslyPending.failedCount,
            eventHash: activeEvent.eventHash,
          };
        }
        const closingEventHash = state.activeEvent?.eventHash;
        if (queueActiveEventForResolution(state, now)) {
          if (closingEventHash) {
            this.clearObservationCounts.delete(closingEventHash);
            this.lastActiveSeenAt.delete(closingEventHash);
          }
          writeWeatherWarningAutomationStateFile(state, stateOptions);
        }
        const currentResolution =
          closingEventHash && state.pendingResolvedEvents[closingEventHash]
            ? await this.deliverPendingResolvedEvents(
                state,
                config.targets,
                stateOptions,
                new Set([closingEventHash]),
              )
            : emptyResolvedDeliveryResult();
        const resolved = mergeResolvedDeliveryResults(
          previouslyPending,
          currentResolution,
        );
        return {
          status: resolved.hadPending ? 'resolved' : 'no-active-warning',
          sentCount: resolved.sentCount,
          failedCount: resolved.failedCount,
          ...(resolved.eventHash ? { eventHash: resolved.eventHash } : {}),
        };
      }
      if (!isEventSnapshotReady(snapshot)) {
        if (state.activeEvent) {
          this.clearObservationCounts.delete(state.activeEvent.eventHash);
        }
        return {
          status: previouslyPending.hadPending
            ? 'resolved'
            : 'no-active-warning',
          sentCount: previouslyPending.sentCount,
          failedCount: previouslyPending.failedCount,
          ...(previouslyPending.eventHash
            ? { eventHash: previouslyPending.eventHash }
            : {}),
        };
      }

      const registrationUrl = featureConfig.registrationEnabled
        ? buildWeatherGuardRegistrationUrlFromSnapshot(
            process.env,
            snapshot,
            'feishu-card',
          )
        : undefined;

      const event = reconcileActiveEvent(state, snapshot, now);
      this.clearObservationCounts.delete(event.activeEvent.eventHash);
      this.lastActiveSeenAt.set(event.activeEvent.eventHash, now.getTime());
      if (event.stateChanged) {
        writeWeatherWarningAutomationStateFile(state, stateOptions);
      }

      let eventSnapshot = snapshot;
      if (featureConfig.progressNotificationsEnabled) {
        const progressSnapshot = await this.loadEventProgress(
          snapshot,
          event.activeEvent,
        );
        if (!progressSnapshot) {
          return {
            status: 'progress-unavailable',
            eventHash: event.activeEvent.eventHash,
            sentCount: previouslyPending.sentCount,
            failedCount: previouslyPending.failedCount,
          };
        }
        eventSnapshot = progressSnapshot;
      }

      const notificationRevision: NotificationRevision =
        event.activeEvent.revision === 1 ? 'initial' : 'upgrade';
      const alertCard = buildWeatherWarningCard({
        snapshot: eventSnapshot,
        testMessage: false,
        registrationUrl,
        showProgress: featureConfig.progressNotificationsEnabled,
        notificationKind: notificationRevision,
      });
      const reminderProgress = featureConfig.progressNotificationsEnabled
        ? getIncompleteReminderItems(eventSnapshot)
        : { available: false, items: [] };
      const targets = getTargetsForGuardLevel(
        config.targets,
        eventSnapshot.guardLevel,
      );
      let sentCount = previouslyPending.sentCount;
      let failedCount = previouslyPending.failedCount;
      let reminderSkipped = false;

      for (const target of targets) {
        const alertDeliveryKey = buildAlertDeliveryKey(
          event.activeEvent,
          notificationRevision,
          target,
        );
        if (!hasDelivery(state, alertDeliveryKey)) {
          try {
            const receipt =
              await this.weatherWarningNotificationService.sendAutomationCard({
                deliveryKey: alertDeliveryKey,
                target,
                card: alertCard,
              });
            recordSuccessfulDelivery(
              state,
              alertDeliveryKey,
              receipt,
              createSnapshotSignature(eventSnapshot),
            );
            recordFirstNotificationAt(event.activeEvent, receipt.sentAt);
            writeWeatherWarningAutomationStateFile(state, stateOptions);
            sentCount += 1;
          } catch {
            failedCount += 1;
          }
          continue;
        }

        if (!featureConfig.progressNotificationsEnabled) continue;

        const latestDeliveryAt = getLatestDeliveryAt(
          state,
          event.activeEvent.eventHash,
          target,
        );
        if (latestDeliveryAt === null) continue;
        const reminderDueAt = latestDeliveryAt + config.reminderIntervalMs;
        if (now.getTime() < reminderDueAt) continue;

        if (!reminderProgress.available) {
          reminderSkipped = true;
          continue;
        }
        if (reminderProgress.items.length === 0) continue;

        const deliveryKey = buildReminderDeliveryKey(
          event.activeEvent.eventHash,
          reminderDueAt,
          target,
        );
        if (hasDelivery(state, deliveryKey)) continue;

        try {
          const card = buildWeatherWarningReminderCard({
            snapshot: eventSnapshot,
            incompleteItems: reminderProgress.items,
            reminderAt: now.toISOString(),
            testMessage: false,
            registrationUrl,
          });
          const receipt =
            await this.weatherWarningNotificationService.sendAutomationCard({
              deliveryKey,
              target,
              card,
            });
          recordSuccessfulDelivery(
            state,
            deliveryKey,
            receipt,
            createSnapshotSignature(eventSnapshot),
          );
          writeWeatherWarningAutomationStateFile(state, stateOptions);
          sentCount += 1;
        } catch {
          failedCount += 1;
        }
      }

      if (reminderSkipped) {
        this.logger.warn(
          '天气预警戒备楼栋进度不可用，已跳过本轮催办，未构造基地级替代楼栋',
        );
      }

      return {
        status: 'processed',
        eventHash: event.activeEvent.eventHash,
        sentCount,
        failedCount,
        ...(reminderSkipped
          ? {
              reminderSkippedReason: 'building-progress-unavailable' as const,
            }
          : {}),
      };
    } finally {
      lease.release();
    }
  }

  private hasConfirmedConsecutiveClear(
    eventHash: string,
    now: Date,
    pollIntervalMs: number,
  ): boolean {
    const lastSeenAt = this.lastActiveSeenAt.get(eventHash);
    const confirmationWindowMs = Math.max(pollIntervalMs * 2, 2 * 60 * 1000);
    if (
      lastSeenAt === undefined ||
      now.getTime() - lastSeenAt > confirmationWindowMs
    ) {
      return true;
    }
    const count = (this.clearObservationCounts.get(eventHash) || 0) + 1;
    this.clearObservationCounts.set(eventHash, count);
    return count >= 2;
  }

  private async deliverPendingResolvedEvents(
    state: WeatherWarningAutomationState,
    targets: readonly WeatherWarningAutomationTarget[],
    stateOptions: WeatherWarningAutomationStateOptions,
    onlyEventHashes?: ReadonlySet<string>,
  ): Promise<ResolvedDeliveryResult> {
    const pendingEvents = Object.values(state.pendingResolvedEvents)
      .filter(
        (pendingEvent) =>
          !onlyEventHashes || onlyEventHashes.has(pendingEvent.eventHash),
      )
      .sort((left, right) => left.closedAt.localeCompare(right.closedAt));
    if (pendingEvents.length === 0) return emptyResolvedDeliveryResult();

    const targetsByHash = new Map(
      targets.map((target) => [createTargetHash(target), target] as const),
    );
    const result: ResolvedDeliveryResult = {
      hadPending: true,
      sentCount: 0,
      failedCount: 0,
      eventHash: pendingEvents[pendingEvents.length - 1]?.eventHash,
    };

    for (const pendingEvent of pendingEvents) {
      const card = buildWeatherWarningResolvedCard({
        warning: toResolvedDisplayWarning(pendingEvent),
        firstNotifiedAt: pendingEvent.firstNotifiedAt,
        closedAt: pendingEvent.closedAt,
        highestGuardLevel: pendingEvent.highestGuardLevel,
        testMessage: false,
      });
      const snapshotSignature = createResolvedEventSignature(pendingEvent);
      const notifiedTargetHashes = new Set(pendingEvent.notifiedTargetHashes);
      const configuredTargetHashes = targets
        .map((target) => createTargetHash(target))
        .filter((targetHash) => notifiedTargetHashes.has(targetHash));
      const missingTargetHashes = pendingEvent.notifiedTargetHashes.filter(
        (targetHash) => !targetsByHash.has(targetHash),
      );

      for (const targetHash of missingTargetHashes) {
        this.logger.warn(
          `天气预警结束通报目标配置已变化，保留待重试事件：${pendingEvent.eventHash}/${targetHash}`,
        );
        result.failedCount += 1;
      }

      for (const targetHash of configuredTargetHashes) {
        const deliveryKey = buildResolvedDeliveryKey(
          pendingEvent.eventHash,
          targetHash,
        );
        if (hasDelivery(state, deliveryKey)) continue;

        const target = targetsByHash.get(targetHash);
        if (!target) continue;

        try {
          const receipt =
            await this.weatherWarningNotificationService.sendAutomationCard({
              deliveryKey,
              target,
              card,
            });
          recordSuccessfulDelivery(
            state,
            deliveryKey,
            receipt,
            snapshotSignature,
          );
          writeWeatherWarningAutomationStateFile(state, stateOptions);
          result.sentCount += 1;
        } catch {
          result.failedCount += 1;
        }
      }

      if (
        pendingEvent.notifiedTargetHashes.every((targetHash) =>
          hasDelivery(
            state,
            buildResolvedDeliveryKey(pendingEvent.eventHash, targetHash),
          ),
        )
      ) {
        delete state.pendingResolvedEvents[pendingEvent.eventHash];
        writeWeatherWarningAutomationStateFile(state, stateOptions);
      }
    }

    return result;
  }

  private async loadEventProgress(
    snapshot: WeatherWarningSnapshot & { guardLevel: WeatherGuardLevel },
    activeEvent: WeatherWarningAutomationActiveEvent,
  ): Promise<WeatherWarningSnapshot | null> {
    const warning = snapshot.matchedWarnings.find(
      (candidate) =>
        candidate.guardLevel === snapshot.guardLevel &&
        candidate.type !== null &&
        candidate.color !== null,
    );
    if (!warning?.type || !warning.color) {
      this.logger.warn(
        '天气预警缺少可用于查询戒备登记的类型或颜色，已跳过自动通知',
      );
      return null;
    }

    const requiredCheckKeys = getSnapshotRequiredCheckKeys(snapshot);
    try {
      const progress = await this.weatherWarningBitableService.getCheckProgress(
        snapshot.guardLevel,
        `${warning.type}${COLOR_LABELS[warning.color]}`,
        activeEvent.openedAt,
        requiredCheckKeys,
        true,
      );
      return {
        ...snapshot,
        requiredCheckKeys: [...requiredCheckKeys],
        checkSyncState: 'fresh',
        checkSummary: progress.summary,
        buildingProgress: progress.buildingProgress,
      };
    } catch {
      this.logger.warn(
        '天气预警戒备检查进度不可用，首次预警继续发送，本轮催办将跳过',
      );
      return {
        ...snapshot,
        requiredCheckKeys: [...requiredCheckKeys],
        checkSyncState: 'unavailable',
        buildingProgress: {
          available: false,
          buildings: [],
          missingRegistrationBuildings: [],
          unassignedRecordCount: 0,
          incompleteItems: [],
        },
      };
    }
  }
}

export function createWeatherWarningEventHash(
  openedAt: string,
  eventSequence: number,
): string {
  return sha256(`weather-warning-event:${eventSequence}:${openedAt}`).slice(
    0,
    24,
  );
}

function reconcileActiveEvent(
  state: WeatherWarningAutomationState,
  snapshot: WeatherWarningSnapshot & { guardLevel: WeatherGuardLevel },
  now: Date,
): {
  activeEvent: WeatherWarningAutomationActiveEvent;
  stateChanged: boolean;
} {
  const warningFingerprint = createActiveWarningFingerprint(snapshot);
  const primaryWarning = createWarningSummary(snapshot);
  const current = state.activeEvent;
  if (!current) {
    const eventSequence = state.eventSequence + 1;
    const openedAt = now.toISOString();
    const activeEvent: WeatherWarningAutomationActiveEvent = {
      eventHash: createStableActiveWarningEventHash(
        warningFingerprint,
        eventSequence,
      ),
      openedAt,
      guardLevel: snapshot.guardLevel,
      highestGuardLevel: snapshot.guardLevel,
      revision: 1,
      warningFingerprint,
      ...(primaryWarning ? { primaryWarning } : {}),
    };
    state.eventSequence = eventSequence;
    state.activeEvent = activeEvent;
    return { activeEvent, stateChanged: true };
  }

  let stateChanged = false;
  const reachedNewHighestGuard = isGuardUpgrade(
    current.highestGuardLevel,
    snapshot.guardLevel,
  );
  const warningColorUpgraded =
    current.highestGuardLevel === snapshot.guardLevel &&
    isWarningColorUpgrade(current.primaryWarning, primaryWarning);
  const reachedNewNotificationPeak =
    reachedNewHighestGuard || warningColorUpgraded;
  if (reachedNewNotificationPeak) {
    current.revision += 1;
    stateChanged = true;
  }
  if (reachedNewHighestGuard) {
    current.highestGuardLevel = snapshot.guardLevel;
    stateChanged = true;
  }
  if (current.guardLevel !== snapshot.guardLevel) {
    current.guardLevel = snapshot.guardLevel;
    stateChanged = true;
  }
  const warningChanged = current.warningFingerprint !== warningFingerprint;
  if (warningChanged) {
    current.warningFingerprint = warningFingerprint;
    stateChanged = true;
  }
  if (
    primaryWarning &&
    (!current.primaryWarning || reachedNewNotificationPeak)
  ) {
    current.primaryWarning = primaryWarning;
    stateChanged = true;
  }
  return { activeEvent: current, stateChanged };
}

function createStableActiveWarningEventHash(
  warningFingerprint: string,
  eventSequence: number,
): string {
  return sha256(
    `weather-warning-active:${eventSequence}:${warningFingerprint}`,
  ).slice(0, 24);
}

function isTrackedWarningStillActive(
  activeEvent: WeatherWarningAutomationActiveEvent,
  warnings: readonly WeatherWarningDisplayWarning[],
): boolean {
  const tracked = activeEvent.primaryWarning;
  if (!tracked) return false;

  return warnings.some((warning) => {
    if (warning.id && warning.id === tracked.id) return true;
    return Boolean(
      tracked.type && warning.type && tracked.type === warning.type,
    );
  });
}

function queueActiveEventForResolution(
  state: WeatherWarningAutomationState,
  now: Date,
): boolean {
  const activeEvent = state.activeEvent;
  if (!activeEvent) return false;

  const successfulAlerts = getSuccessfulAlertDeliveries(
    state,
    activeEvent.eventHash,
  );
  state.activeEvent = null;
  if (successfulAlerts.length === 0) return true;

  const firstNotifiedAt =
    activeEvent.firstNotifiedAt || successfulAlerts[0].sentAt;
  state.pendingResolvedEvents[activeEvent.eventHash] = {
    eventHash: activeEvent.eventHash,
    openedAt: activeEvent.openedAt,
    closedAt: now.toISOString(),
    highestGuardLevel: activeEvent.highestGuardLevel,
    firstNotifiedAt,
    notifiedTargetHashes: Array.from(
      new Set(successfulAlerts.map((delivery) => delivery.targetHash)),
    ).sort(),
    ...(activeEvent.primaryWarning
      ? { primaryWarning: activeEvent.primaryWarning }
      : {}),
  };
  return true;
}

function getSuccessfulAlertDeliveries(
  state: WeatherWarningAutomationState,
  eventHash: string,
): Array<{ targetHash: string; sentAt: string }> {
  const initialPrefix = `auto:initial:${eventHash}:`;
  const upgradePrefix = `auto:upgrade:${eventHash}:`;
  const deliveries: Array<{ targetHash: string; sentAt: string }> = [];

  for (const [deliveryKey, entry] of Object.entries(state.entries)) {
    if (
      !deliveryKey.startsWith(initialPrefix) &&
      !deliveryKey.startsWith(upgradePrefix)
    ) {
      continue;
    }
    const targetHash = deliveryKey.slice(deliveryKey.lastIndexOf(':') + 1);
    if (!/^[0-9a-f]{16}$/u.test(targetHash)) continue;
    deliveries.push({ targetHash, sentAt: entry.sentAt });
  }

  return deliveries.sort((left, right) =>
    left.sentAt.localeCompare(right.sentAt),
  );
}

function recordFirstNotificationAt(
  activeEvent: WeatherWarningAutomationActiveEvent,
  sentAt: string,
): void {
  if (activeEvent.firstNotifiedAt) return;
  const openedAt = Date.parse(activeEvent.openedAt);
  const receivedAt = Date.parse(sentAt);
  activeEvent.firstNotifiedAt =
    Number.isFinite(receivedAt) && receivedAt >= openedAt
      ? new Date(receivedAt).toISOString()
      : activeEvent.openedAt;
}

function createWarningSummary(
  snapshot: WeatherWarningSnapshot,
): WeatherWarningAutomationWarningSummary | undefined {
  const isUsableWarning = (candidate: WeatherWarningDisplayWarning): boolean =>
    typeof candidate.id === 'string' &&
    candidate.id.trim().length > 0 &&
    typeof candidate.title === 'string' &&
    candidate.title.trim().length > 0;
  const warning =
    snapshot.matchedWarnings.find(
      (candidate) =>
        candidate.guardLevel === snapshot.guardLevel &&
        isUsableWarning(candidate),
    ) || snapshot.matchedWarnings.find(isUsableWarning);
  if (!warning) return undefined;

  const id = sanitizeSummaryText(warning.id, 200);
  const title = sanitizeSummaryText(warning.title, 500);
  if (!id || !title) return undefined;
  const startTime = normalizeSummaryTimestamp(warning.startTime);
  const pubTime = normalizeSummaryTimestamp(warning.pubTime);
  return {
    id,
    title,
    ...(warning.type ? { type: sanitizeSummaryText(warning.type, 80) } : {}),
    ...(warning.color ? { color: warning.color } : {}),
    ...(startTime ? { startTime } : {}),
    ...(pubTime ? { pubTime } : {}),
  };
}

function sanitizeSummaryText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeSummaryTimestamp(value: string | undefined): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function toResolvedDisplayWarning(
  pendingEvent: WeatherWarningAutomationPendingResolvedEvent,
): WeatherWarningDisplayWarning {
  const warning = pendingEvent.primaryWarning;
  return {
    id: warning?.id || pendingEvent.eventHash,
    title: warning?.title || '天气预警',
    type: warning?.type || null,
    color: warning?.color || null,
    guardLevel: pendingEvent.highestGuardLevel,
    ...(warning?.startTime ? { startTime: warning.startTime } : {}),
    ...(warning?.pubTime ? { pubTime: warning.pubTime } : {}),
  };
}

function createActiveWarningFingerprint(
  snapshot: WeatherWarningSnapshot,
): string {
  const warnings = [...snapshot.matchedWarnings]
    .map((warning) => [
      warning.id,
      warning.type || '',
      warning.color || '',
      warning.startTime || '',
      warning.pubTime || '',
    ])
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return `sha256:${sha256(JSON.stringify(warnings))}`;
}

function isGuardUpgrade(
  previous: WeatherGuardLevel,
  current: WeatherGuardLevel,
): boolean {
  return GUARD_LEVEL_PRIORITY[current] > GUARD_LEVEL_PRIORITY[previous];
}

function isWarningColorUpgrade(
  previous: WeatherWarningAutomationWarningSummary | undefined,
  current: WeatherWarningAutomationWarningSummary | undefined,
): boolean {
  if (!previous?.color || !current?.color) return false;
  if (previous.type && current.type) {
    if (previous.type !== current.type) return false;
  } else if (previous.id !== current.id) {
    return false;
  }
  return (
    WARNING_COLOR_PRIORITY[current.color] >
    WARNING_COLOR_PRIORITY[previous.color]
  );
}

function getTargetsForGuardLevel(
  targets: readonly WeatherWarningAutomationTarget[],
  guardLevel: WeatherGuardLevel,
): WeatherWarningAutomationTarget[] {
  return targets.filter(
    (target) =>
      target.audience !== 'important_event_chat' || guardLevel === '一级戒备',
  );
}

function buildAlertDeliveryKey(
  activeEvent: WeatherWarningAutomationActiveEvent,
  revision: NotificationRevision,
  target: WeatherWarningAutomationTarget,
): string {
  if (revision === 'initial') {
    return `auto:initial:${activeEvent.eventHash}:${createTargetHash(target)}`;
  }
  return `auto:upgrade:${activeEvent.eventHash}:${activeEvent.revision}:${createTargetHash(
    target,
  )}`;
}

function buildReminderDeliveryKey(
  eventHash: string,
  reminderDueAt: number,
  target: WeatherWarningAutomationTarget,
): string {
  return `auto:reminder:${eventHash}:${reminderDueAt.toString(36)}:${createTargetHash(
    target,
  )}`;
}

function buildResolvedDeliveryKey(
  eventHash: string,
  targetHash: string,
): string {
  return `auto:resolved:${eventHash}:${targetHash}`;
}

function createTargetHash(target: WeatherWarningAutomationTarget): string {
  return sha256(`${target.receiveIdType}:${target.receiveId}`).slice(0, 16);
}

function createSnapshotSignature(snapshot: WeatherWarningSnapshot): string {
  return `sha256:${sha256(JSON.stringify(snapshot))}`;
}

function createResolvedEventSignature(
  pendingEvent: WeatherWarningAutomationPendingResolvedEvent,
): string {
  return `sha256:${sha256(JSON.stringify(pendingEvent))}`;
}

function emptyResolvedDeliveryResult(): ResolvedDeliveryResult {
  return { hadPending: false, sentCount: 0, failedCount: 0 };
}

function mergeResolvedDeliveryResults(
  left: ResolvedDeliveryResult,
  right: ResolvedDeliveryResult,
): ResolvedDeliveryResult {
  return {
    hadPending: left.hadPending || right.hadPending,
    sentCount: left.sentCount + right.sentCount,
    failedCount: left.failedCount + right.failedCount,
    ...(right.eventHash || left.eventHash
      ? { eventHash: right.eventHash || left.eventHash }
      : {}),
  };
}

function getLatestDeliveryAt(
  state: WeatherWarningAutomationState,
  eventHash: string,
  target: WeatherWarningAutomationTarget,
): number | null {
  const targetHash = createTargetHash(target);
  const initialKey = `auto:initial:${eventHash}:${targetHash}`;
  const upgradePrefix = `auto:upgrade:${eventHash}:`;
  const reminderPrefix = `auto:reminder:${eventHash}:`;
  const targetSuffix = `:${targetHash}`;
  let latest: number | null = null;

  for (const [deliveryKey, entry] of Object.entries(state.entries)) {
    const belongsToTarget =
      deliveryKey === initialKey ||
      ((deliveryKey.startsWith(upgradePrefix) ||
        deliveryKey.startsWith(reminderPrefix)) &&
        deliveryKey.endsWith(targetSuffix));
    if (!belongsToTarget) continue;
    const sentAt = Date.parse(entry.sentAt);
    if (Number.isFinite(sentAt) && (latest === null || sentAt > latest)) {
      latest = sentAt;
    }
  }

  return latest;
}

function getIncompleteReminderItems(snapshot: WeatherWarningSnapshot): {
  available: boolean;
  items: WeatherWarningReminderItem[];
} {
  const buildingProgress = snapshot.buildingProgress;
  if (!buildingProgress?.available || !snapshot.guardLevel) {
    return { available: false, items: [] };
  }

  const requiredKeys = new Set(getSnapshotRequiredCheckKeys(snapshot));
  return {
    available: true,
    items: buildingProgress.incompleteItems
      .filter(
        (item) => item.key === 'registration' || requiredKeys.has(item.key),
      )
      .filter(isReminderItem)
      .map((item) => ({
        building: item.building,
        label: item.label,
        state: item.state,
        ...(item.detail ? { detail: item.detail } : {}),
      })),
  };
}

function getSnapshotRequiredCheckKeys(
  snapshot: WeatherWarningSnapshot,
): readonly WeatherWarningCheckKey[] {
  if (snapshot.requiredCheckKeys?.length) {
    return snapshot.requiredCheckKeys;
  }
  const warning = snapshot.matchedWarnings.find(
    (candidate) =>
      candidate.type !== null &&
      candidate.color !== null &&
      candidate.guardLevel !== null,
  );
  if (!warning) return [];
  try {
    return resolveWeatherWarningCheckScope(warning).requiredCheckKeys;
  } catch {
    return [];
  }
}

function isReminderItem(
  item: WeatherWarningIncompleteItem,
): item is WeatherWarningIncompleteItem {
  return (
    typeof item.building === 'string' &&
    item.building.length > 0 &&
    typeof item.label === 'string' &&
    item.label.trim().length > 0 &&
    ['pending', 'abnormal', 'not_started', 'missing_registration'].includes(
      item.state,
    )
  );
}

function isEventSnapshotReady(
  snapshot: WeatherWarningSnapshot,
): snapshot is WeatherWarningSnapshot & { guardLevel: WeatherGuardLevel } {
  return (
    snapshot.status === 'active' &&
    snapshot.sourceState === 'fresh' &&
    snapshot.guardLevel !== null &&
    snapshot.matchedWarnings.length > 0 &&
    (snapshot.guardDecisionState === undefined ||
      snapshot.guardDecisionState === 'fresh')
  );
}

function isConfirmedClearSnapshot(snapshot: WeatherWarningSnapshot): boolean {
  return (
    snapshot.status === 'clear' &&
    snapshot.sourceState === 'fresh' &&
    snapshot.guardLevel === null &&
    snapshot.matchedWarnings.length === 0 &&
    (snapshot.guardDecisionState === undefined ||
      snapshot.guardDecisionState === 'fresh')
  );
}

function hasDelivery(
  state: WeatherWarningAutomationState,
  deliveryKey: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(state.entries, deliveryKey);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function getStateOptions(
  config: WeatherWarningAutomationConfig,
  now: Date,
): WeatherWarningAutomationStateOptions {
  return {
    ...(config.statePath ? { explicitPath: config.statePath } : {}),
    ...(config.stateDirectory
      ? { configuredDirectory: config.stateDirectory }
      : {}),
    now,
  };
}

function recordSuccessfulDelivery(
  state: WeatherWarningAutomationState,
  deliveryKey: string,
  receipt: { messageId: string; sentAt: string; uuid: string },
  snapshotSignature: string,
): void {
  state.entries[deliveryKey] = {
    clientMutationId: deliveryKey,
    messageId: receipt.messageId,
    sentAt: receipt.sentAt,
    uuid: receipt.uuid,
    snapshotSignature,
  };
}
