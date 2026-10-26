import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  getFeishuAuthPayload,
  readEnv,
} from '@server/common/config/external-services.config';
import type {
  WeatherWarningFullFlowProgressSendRequest,
  WeatherWarningSnapshot,
  WeatherWarningTestPreviewResponse,
  WeatherWarningTestSendRequest,
  WeatherWarningTestSendResponse,
} from '@shared/api.interface';
import type { WeatherWarningAutomationTarget } from './weather-warning-automation.config';
import { WeatherWarningBitableService } from './weather-warning-bitable.service';
import {
  buildWeatherWarningCard,
  buildWeatherWarningReminderCard,
} from './weather-warning-card';
import { loadWeatherWarningFeatureConfig } from './weather-warning-feature.config';
import { buildWeatherGuardRegistrationUrlFromSnapshot } from './weather-warning-registration-link';
import {
  acquireWeatherWarningDeliveryLease,
  readWeatherWarningDeliveryStateFile,
  writeWeatherWarningDeliveryStateFile,
  type DeliveryLease,
  type DeliveryStoreOptions,
  type WeatherWarningDeliveryState,
} from './weather-warning-delivery-state-store';
import { WeatherWarningSnapshotService } from './weather-warning-snapshot.service';
import {
  buildWeatherWarningTestSimulationSnapshot,
  createWeatherWarningTestSimulationContext,
} from './weather-warning-test-simulation';

const AUTH_ENDPOINT =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const MESSAGE_ENDPOINT =
  'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id';
const CHAT_MESSAGE_ENDPOINT =
  'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id';
const REQUEST_TIMEOUT_MS = 30_000;
const MUTATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;
const FULL_FLOW_RUN_MUTATION_ID_PATTERN =
  /^weather-e2e-\d{13}-[A-Za-z0-9-]{16,64}$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/u;
const FEISHU_MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]+$/u;
const RESERVED_MUTATION_IDS = new Set([
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
  'prototype',
]);

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

interface PersonalTestCardPreparation {
  card: Record<string, unknown>;
  snapshot: WeatherWarningSnapshot;
}

interface PersonalTestCardDeliveryInput {
  stateKey: string;
  responseMutationId: string;
  uuidPurpose: string;
  successMessage: string;
  prepare: () => Promise<PersonalTestCardPreparation>;
}

export interface WeatherWarningAutomationCardDeliveryRequest {
  deliveryKey: string;
  target: WeatherWarningAutomationTarget;
  card: Record<string, unknown>;
}

export interface WeatherWarningAutomationCardDeliveryReceipt {
  messageId: string;
  sentAt: string;
  uuid: string;
}

@Injectable()
export class WeatherWarningNotificationService {
  private readonly logger = new Logger(WeatherWarningNotificationService.name);
  private tenantToken: TenantTokenState | null = null;
  private tenantTokenRequest: Promise<string> | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly weatherWarningSnapshotService: WeatherWarningSnapshotService,
    private readonly weatherWarningBitableService: WeatherWarningBitableService,
  ) {}

  async getTestPreview(): Promise<WeatherWarningTestPreviewResponse> {
    let snapshot: WeatherWarningSnapshot;
    try {
      snapshot = await this.weatherWarningSnapshotService.getSnapshot({
        forceRefresh: true,
      });
    } catch {
      throw new ServiceUnavailableException('天气预警测试预览所需快照暂不可用');
    }

    return {
      success: true,
      recipientName: getConfiguredRecipientName(
        this.weatherWarningBitableService,
      ),
      senderName: '系统机器人',
      canSend: snapshot.canSendTest === true,
      snapshot: toPublicWeatherWarningSnapshot(snapshot),
    };
  }

  async sendTest(
    request: WeatherWarningTestSendRequest,
  ): Promise<WeatherWarningTestSendResponse> {
    const clientMutationId = validateTestSendRequest(request);
    const storeOptions = getDeliveryStoreOptions();
    const lease = acquireDeliveryLease(storeOptions);
    let completed = false;

    try {
      const state = readDeliveryState(storeOptions);
      const previousDelivery = Object.prototype.hasOwnProperty.call(
        state.entries,
        clientMutationId,
      )
        ? state.entries[clientMutationId]
        : undefined;
      if (previousDelivery) {
        completed = true;
        return toReplayResponse(previousDelivery);
      }

      const snapshot = await getSendableSnapshot(
        this.weatherWarningSnapshotService,
      );
      const card = buildSafeTestCard(snapshot);
      const recipientOpenId = getConfiguredRecipientOpenId(
        this.weatherWarningBitableService,
      );
      const uuid = createStableMessageUuid(clientMutationId);
      const snapshotSignature = createSnapshotSignature(snapshot);
      const token = await this.getTenantAccessToken();
      const messageId = await this.sendInteractiveCard(
        token,
        recipientOpenId,
        card,
        uuid,
      );
      const sentAt = new Date().toISOString();
      const nextState: WeatherWarningDeliveryState = {
        version: 1,
        entries: {
          ...state.entries,
          [clientMutationId]: {
            clientMutationId,
            messageId,
            sentAt,
            uuid,
            snapshotSignature,
          },
        },
      };

      try {
        writeWeatherWarningDeliveryStateFile(nextState, storeOptions);
      } catch {
        throw new ServiceUnavailableException(
          '天气预警测试消息已送达但投递记录保存失败，请勿重试并联系管理员',
        );
      }

      completed = true;
      return {
        success: true,
        sent: true,
        clientMutationId,
        messageId,
        sentAt,
        message: '天气预警测试卡片已发送',
      };
    } finally {
      try {
        lease.release();
      } catch {
        if (completed) {
          throw new ServiceUnavailableException(
            '天气预警测试投递锁释放失败，请稍后查询发送结果',
          );
        }
      }
    }
  }

  async sendFullFlowTest(
    request: WeatherWarningTestSendRequest,
  ): Promise<WeatherWarningTestSendResponse> {
    const clientMutationId = validateFullFlowInitialRequest(request);
    const context = createFullFlowSimulationContext(clientMutationId);
    return this.sendPersonalTestCard({
      stateKey: `full-flow:initial:${clientMutationId}`,
      responseMutationId: clientMutationId,
      uuidPurpose: 'full-flow-initial',
      successMessage: '天气预警全流程测试卡片已发送',
      prepare: async () => ({
        snapshot: context.snapshot,
        card: buildSafeTestCard(context.snapshot),
      }),
    });
  }

  async sendFullFlowProgress(
    request: WeatherWarningFullFlowProgressSendRequest,
  ): Promise<WeatherWarningTestSendResponse> {
    const validated = validateFullFlowProgressRequest(request);
    const featureConfig = loadWeatherWarningFeatureConfig();
    if (!featureConfig.progressNotificationsEnabled) {
      throw new ServiceUnavailableException('天气预警戒备进度与催办消息已暂停');
    }
    const context = createFullFlowSimulationContext(
      validated.runClientMutationId,
    );
    return this.sendPersonalTestCard({
      stateKey: `full-flow:${validated.runClientMutationId}:${validated.cardType}:${validated.clientMutationId}`,
      responseMutationId: validated.clientMutationId,
      uuidPurpose: `full-flow-${validated.cardType}`,
      successMessage:
        validated.cardType === 'reminder'
          ? '天气预警全流程催办测试卡片已发送'
          : '天气预警全流程进度测试卡片已发送',
      prepare: async () => {
        const snapshotAt = new Date().toISOString();
        let progressAvailable = true;
        let snapshot: WeatherWarningSnapshot;
        try {
          const progress =
            await this.weatherWarningBitableService.getCheckProgress(
              '三级戒备',
              context.tag,
              context.openedAt,
              context.snapshot.requiredCheckKeys ?? [],
              true,
            );
          snapshot = buildWeatherWarningTestSimulationSnapshot(context, {
            snapshotAt,
            checkSummary: progress.summary,
            buildingProgress: progress.buildingProgress,
            guardCompletion: progress.guardCompletion,
          });
        } catch {
          progressAvailable = false;
          snapshot = {
            ...buildWeatherWarningTestSimulationSnapshot(context, {
              snapshotAt,
              buildingProgress: {
                available: false,
                buildings: [],
                missingRegistrationBuildings: [],
                unassignedRecordCount: 0,
                incompleteItems: [],
              },
            }),
            checkSyncState: 'unavailable',
          };
        }
        const registrationUrl = featureConfig.registrationEnabled
          ? buildSafeRegistrationUrl(snapshot)
          : undefined;
        const card =
          validated.cardType === 'reminder' && progressAvailable
            ? buildWeatherWarningReminderCard({
                snapshot,
                incompleteItems:
                  snapshot.buildingProgress?.incompleteItems ?? [],
                reminderAt: snapshot.snapshotAt,
                testMessage: true,
                registrationUrl,
              })
            : buildWeatherWarningCard({
                snapshot,
                testMessage: true,
                registrationUrl,
              });
        return { snapshot, card };
      },
    });
  }

  private async sendPersonalTestCard(
    input: PersonalTestCardDeliveryInput,
  ): Promise<WeatherWarningTestSendResponse> {
    const storeOptions = getDeliveryStoreOptions();
    const lease = acquireDeliveryLease(storeOptions);
    let completed = false;

    try {
      const state = readDeliveryState(storeOptions);
      const previousDelivery = Object.prototype.hasOwnProperty.call(
        state.entries,
        input.stateKey,
      )
        ? state.entries[input.stateKey]
        : undefined;
      if (previousDelivery) {
        completed = true;
        return toNamedReplayResponse(
          previousDelivery,
          input.responseMutationId,
          input.successMessage,
        );
      }

      const prepared = await input.prepare();
      const recipientOpenId = getConfiguredRecipientOpenId(
        this.weatherWarningBitableService,
      );
      const uuid = createStablePersonalTestMessageUuid(
        input.uuidPurpose,
        input.stateKey,
      );
      const token = await this.getTenantAccessToken();
      const messageId = await this.sendInteractiveCard(
        token,
        recipientOpenId,
        prepared.card,
        uuid,
        'open_id',
      );
      const sentAt = new Date().toISOString();
      const nextState: WeatherWarningDeliveryState = {
        version: 1,
        entries: {
          ...state.entries,
          [input.stateKey]: {
            clientMutationId: input.stateKey,
            messageId,
            sentAt,
            uuid,
            snapshotSignature: createSnapshotSignature(prepared.snapshot),
          },
        },
      };

      try {
        writeWeatherWarningDeliveryStateFile(nextState, storeOptions);
      } catch {
        throw new ServiceUnavailableException(
          '测试消息已送达但投递记录保存失败，请勿重试并联系管理员',
        );
      }

      completed = true;
      return {
        success: true,
        sent: true,
        clientMutationId: input.responseMutationId,
        messageId,
        sentAt,
        message: input.successMessage,
      };
    } finally {
      try {
        lease.release();
      } catch {
        if (completed) {
          throw new ServiceUnavailableException(
            '测试投递锁释放失败，请稍后查询发送结果',
          );
        }
      }
    }
  }

  async sendAutomationCard(
    request: WeatherWarningAutomationCardDeliveryRequest,
  ): Promise<WeatherWarningAutomationCardDeliveryReceipt> {
    validateAutomationDeliveryRequest(request);
    const uuid = createAutomationMessageUuid(request.deliveryKey);
    const token = await this.getTenantAccessToken();
    const messageId = await this.sendInteractiveCard(
      token,
      request.target.receiveId,
      request.card,
      uuid,
      request.target.receiveIdType,
    );
    return {
      messageId,
      sentAt: new Date().toISOString(),
      uuid,
    };
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now() + 60_000) {
      return this.tenantToken.value;
    }
    if (this.tenantTokenRequest) return this.tenantTokenRequest;

    this.tenantTokenRequest = this.requestTenantAccessToken().finally(() => {
      this.tenantTokenRequest = null;
    });
    return this.tenantTokenRequest;
  }

  private async requestTenantAccessToken(): Promise<string> {
    let response: { data?: unknown };
    try {
      response = await this.httpService.axiosRef.post(
        AUTH_ENDPOINT,
        getFeishuAuthPayload(),
        { timeout: REQUEST_TIMEOUT_MS },
      );
    } catch {
      throw new ServiceUnavailableException('飞书测试发送鉴权暂不可用');
    }

    const payload = asRecord(response.data);
    const token = cleanString(payload?.tenant_access_token);
    if (payload?.code !== 0 || !token) {
      throw new ServiceUnavailableException('飞书测试发送鉴权暂不可用');
    }

    const expireSeconds = Number(payload.expire);
    this.tenantToken = {
      value: token,
      expiresAt:
        Date.now() +
        (Number.isFinite(expireSeconds)
          ? Math.max(60, expireSeconds - 300)
          : 5_400) *
          1_000,
    };
    return token;
  }

  private async sendInteractiveCard(
    token: string,
    recipientOpenId: string,
    card: Record<string, unknown>,
    uuid: string,
    receiveIdType: WeatherWarningAutomationTarget['receiveIdType'] = 'open_id',
  ): Promise<string> {
    let response: { data?: unknown };
    try {
      response = await this.httpService.axiosRef.post(
        receiveIdType === 'chat_id' ? CHAT_MESSAGE_ENDPOINT : MESSAGE_ENDPOINT,
        {
          receive_id: recipientOpenId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
          uuid,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );
    } catch (error) {
      this.logger.warn(
        formatFeishuDeliveryDiagnostic('http', getFeishuHttpDiagnostic(error)),
      );
      throw new BadGatewayException('天气预警测试卡片发送失败');
    }

    const payload = asRecord(response.data);
    const messageId = asRecord(payload?.data)?.message_id;
    if (
      payload?.code !== 0 ||
      typeof messageId !== 'string' ||
      !FEISHU_MESSAGE_ID_PATTERN.test(messageId)
    ) {
      this.logger.warn(
        formatFeishuDeliveryDiagnostic('response', {
          status: 200,
          code: toDiagnosticInteger(payload?.code),
        }),
      );
      throw new BadGatewayException('天气预警测试卡片发送失败');
    }
    return messageId;
  }
}

function getFeishuHttpDiagnostic(error: unknown): {
  status: number | null;
  code: number | null;
} {
  const response = asRecord(readResponseProperty(error));
  const payload = asRecord(response?.data);
  return {
    status: toDiagnosticInteger(response?.status),
    code: toDiagnosticInteger(payload?.code),
  };
}

function readResponseProperty(value: unknown): unknown {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'response');
    return descriptor &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function toDiagnosticInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null;
}

function formatFeishuDeliveryDiagnostic(
  stage: 'http' | 'response',
  diagnostic: { status: number | null; code: number | null },
): string {
  return `天气预警飞书投递失败：stage=${stage}, status=${diagnostic.status ?? 'unknown'}, code=${diagnostic.code ?? 'unknown'}`;
}

function validateAutomationDeliveryRequest(
  request: WeatherWarningAutomationCardDeliveryRequest,
): void {
  const target = request?.target;
  const validDeliveryKey =
    typeof request?.deliveryKey === 'string' &&
    /^auto:[A-Za-z0-9:._-]{16,240}$/u.test(request.deliveryKey);
  const validTarget =
    target?.receiveIdType === 'chat_id'
      ? /^oc_[A-Za-z0-9_-]+$/u.test(target.receiveId)
      : target?.receiveIdType === 'open_id' &&
        /^ou_[A-Za-z0-9_-]+$/u.test(target.receiveId);
  if (!validDeliveryKey || !validTarget || !isPlainRecord(request?.card)) {
    throw new ServiceUnavailableException(
      '天气预警自动投递目标或卡片配置不可用',
    );
  }
}

function validateTestSendRequest(value: unknown): string {
  if (!isPlainRecord(value)) {
    throw new BadRequestException('天气预警测试发送请求无效');
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 1 ||
    keys[0] !== 'clientMutationId' ||
    !Object.prototype.hasOwnProperty.call(value, 'clientMutationId')
  ) {
    throw new BadRequestException('天气预警测试发送请求无效');
  }
  const clientMutationId = value.clientMutationId;
  if (
    typeof clientMutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(clientMutationId) ||
    RESERVED_MUTATION_IDS.has(clientMutationId)
  ) {
    throw new BadRequestException('天气预警测试发送请求无效');
  }
  return clientMutationId;
}

function validateFullFlowInitialRequest(value: unknown): string {
  const clientMutationId = validateTestSendRequest(value);
  if (!FULL_FLOW_RUN_MUTATION_ID_PATTERN.test(clientMutationId)) {
    throw new BadRequestException('天气预警全流程测试请求无效');
  }
  return clientMutationId;
}

function validateFullFlowProgressRequest(
  value: unknown,
): WeatherWarningFullFlowProgressSendRequest {
  if (!isPlainRecord(value)) {
    throw new BadRequestException('天气预警全流程进度请求无效');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys.join(',') !== 'cardType,clientMutationId,runClientMutationId'
  ) {
    throw new BadRequestException('天气预警全流程进度请求无效');
  }
  const runClientMutationId = value.runClientMutationId;
  const clientMutationId = value.clientMutationId;
  const cardType = value.cardType;
  if (
    typeof runClientMutationId !== 'string' ||
    !FULL_FLOW_RUN_MUTATION_ID_PATTERN.test(runClientMutationId) ||
    typeof clientMutationId !== 'string' ||
    !MUTATION_ID_PATTERN.test(clientMutationId) ||
    RESERVED_MUTATION_IDS.has(clientMutationId) ||
    (cardType !== 'progress' && cardType !== 'reminder')
  ) {
    throw new BadRequestException('天气预警全流程进度请求无效');
  }
  return { runClientMutationId, clientMutationId, cardType };
}

function createFullFlowSimulationContext(clientMutationId: string) {
  try {
    return createWeatherWarningTestSimulationContext(clientMutationId);
  } catch {
    throw new BadRequestException('天气预警全流程测试操作号无效或已过期');
  }
}

function getDeliveryStoreOptions(): DeliveryStoreOptions {
  const explicitPath = readEnv('FEISHU_WEATHER_WARNING_DELIVERY_STATE_PATH');
  const configuredDirectory = readEnv(
    'FEISHU_WEATHER_WARNING_DELIVERY_STATE_DIR',
  );
  return {
    ...(explicitPath ? { explicitPath } : {}),
    ...(configuredDirectory ? { configuredDirectory } : {}),
  };
}

function acquireDeliveryLease(options: DeliveryStoreOptions): DeliveryLease {
  try {
    const lease = acquireWeatherWarningDeliveryLease(options);
    if (!lease) {
      throw new ConflictException('天气预警测试发送正在处理中');
    }
    return lease;
  } catch (error) {
    if (error instanceof ConflictException) throw error;
    throw new ServiceUnavailableException('天气预警测试发送状态暂不可用');
  }
}

function readDeliveryState(
  options: DeliveryStoreOptions,
): WeatherWarningDeliveryState {
  try {
    return readWeatherWarningDeliveryStateFile(options);
  } catch {
    throw new ServiceUnavailableException('天气预警测试发送状态暂不可用');
  }
}

async function getSendableSnapshot(
  service: WeatherWarningSnapshotService,
): Promise<WeatherWarningSnapshot> {
  let snapshot: WeatherWarningSnapshot;
  try {
    snapshot = await service.getSnapshot({ forceRefresh: true });
  } catch {
    throw new ServiceUnavailableException('天气预警测试发送所需快照暂不可用');
  }
  if (!snapshot || snapshot.canSendTest !== true) {
    throw new ConflictException('当前天气预警状态不允许发送测试卡片');
  }
  return snapshot;
}

function getConfiguredRecipientOpenId(
  service: WeatherWarningBitableService,
): string {
  let openId = '';
  try {
    openId = cleanString(service.getRuntimeConfig()?.testRecipient?.openId);
  } catch {
    throw new ServiceUnavailableException('天气预警测试收件人配置不可用');
  }
  if (!OPEN_ID_PATTERN.test(openId)) {
    throw new ServiceUnavailableException('天气预警测试收件人配置不可用');
  }
  return openId;
}

function getConfiguredRecipientName(
  service: WeatherWarningBitableService,
): string {
  try {
    const displayName = cleanString(
      service.getRuntimeConfig()?.testRecipient?.displayName,
    );
    return displayName || '示例人员020';
  } catch {
    return '示例人员020';
  }
}

export function toPublicWeatherWarningSnapshot(
  snapshot: WeatherWarningSnapshot,
): WeatherWarningSnapshot {
  const checkSummary = snapshot.checkSummary;
  const weather = snapshot.weather;
  const guardCompletion = toPublicGuardCompletion(snapshot.guardCompletion);

  return {
    status: snapshot.status,
    sourceState: snapshot.sourceState,
    ...(snapshot.guardDecisionState
      ? { guardDecisionState: snapshot.guardDecisionState }
      : {}),
    ...(snapshot.checkSyncState
      ? { checkSyncState: snapshot.checkSyncState }
      : {}),
    snapshotAt: snapshot.snapshotAt,
    ...(typeof snapshot.lastSuccessAt === 'string'
      ? { lastSuccessAt: snapshot.lastSuccessAt }
      : {}),
    guardLevel: snapshot.guardLevel,
    matchedWarnings: snapshot.matchedWarnings.map((warning) => ({
      id: warning.id,
      title: warning.title,
      type: warning.type,
      color: warning.color,
      guardLevel: warning.guardLevel,
      ...(typeof warning.startTime === 'string'
        ? { startTime: warning.startTime }
        : {}),
      ...(typeof warning.endTime === 'string'
        ? { endTime: warning.endTime }
        : {}),
      ...(typeof warning.pubTime === 'string'
        ? { pubTime: warning.pubTime }
        : {}),
      ...(typeof warning.status === 'string' ? { status: warning.status } : {}),
    })),
    unmatchedWarnings: snapshot.unmatchedWarnings.map((warning) => ({
      id: warning.id,
      title: warning.title,
      type: warning.type,
      color: warning.color,
      guardLevel: warning.guardLevel,
      ...(typeof warning.startTime === 'string'
        ? { startTime: warning.startTime }
        : {}),
      ...(typeof warning.endTime === 'string'
        ? { endTime: warning.endTime }
        : {}),
      ...(typeof warning.pubTime === 'string'
        ? { pubTime: warning.pubTime }
        : {}),
      ...(typeof warning.status === 'string' ? { status: warning.status } : {}),
    })),
    actions: snapshot.actions.filter(
      (action): action is string => typeof action === 'string',
    ),
    weather: weather
      ? {
          ...(typeof weather.temperature === 'string'
            ? { temperature: weather.temperature }
            : {}),
          ...(typeof weather.feelsLike === 'string'
            ? { feelsLike: weather.feelsLike }
            : {}),
          ...(typeof weather.humidity === 'string'
            ? { humidity: weather.humidity }
            : {}),
          ...(typeof weather.windDirection === 'string'
            ? { windDirection: weather.windDirection }
            : {}),
          ...(typeof weather.windScale === 'string'
            ? { windScale: weather.windScale }
            : {}),
          ...(typeof weather.observedAt === 'string'
            ? { observedAt: weather.observedAt }
            : {}),
        }
      : null,
    ...(typeof snapshot.weatherSourceError === 'string'
      ? { weatherSourceError: snapshot.weatherSourceError }
      : {}),
    checkSummary: {
      device: checkSummary.device,
      environment: checkSummary.environment,
      disaster: checkSummary.disaster,
      materials: checkSummary.materials,
      contacts: checkSummary.contacts,
      managerConfirmation: checkSummary.managerConfirmation,
      abnormalSummaries: [],
    },
    ...(guardCompletion ? { guardCompletion } : {}),
    ...(typeof snapshot.sourceError === 'string'
      ? { sourceError: snapshot.sourceError }
      : {}),
    canSendTest: snapshot.canSendTest === true,
  };
}

function toPublicGuardCompletion(
  value: WeatherWarningSnapshot['guardCompletion'],
): WeatherWarningSnapshot['guardCompletion'] | undefined {
  if (!value) return undefined;
  if (
    value.state !== 'completed' &&
    value.state !== 'incomplete' &&
    value.state !== 'unavailable' &&
    value.state !== 'not_applicable'
  ) {
    return undefined;
  }
  if (
    !Number.isInteger(value.completedBuildingCount) ||
    !Number.isInteger(value.totalBuildingCount) ||
    value.completedBuildingCount < 0 ||
    value.totalBuildingCount < 0 ||
    value.completedBuildingCount > value.totalBuildingCount
  ) {
    return undefined;
  }

  return {
    state: value.state,
    completedBuildingCount: value.completedBuildingCount,
    totalBuildingCount: value.totalBuildingCount,
  };
}

function buildSafeTestCard(
  snapshot: WeatherWarningSnapshot,
): Record<string, unknown> {
  try {
    const featureConfig = loadWeatherWarningFeatureConfig();
    const registrationUrl = featureConfig.registrationEnabled
      ? buildSafeRegistrationUrl(snapshot)
      : undefined;
    return buildWeatherWarningCard({
      snapshot,
      testMessage: true,
      registrationUrl,
      showProgress: featureConfig.progressNotificationsEnabled,
    });
  } catch {
    throw new ServiceUnavailableException('天气预警测试卡片生成失败');
  }
}

function buildSafeRegistrationUrl(snapshot: WeatherWarningSnapshot): string {
  try {
    return buildWeatherGuardRegistrationUrlFromSnapshot(
      process.env,
      snapshot,
      'test-card',
    );
  } catch {
    throw new ServiceUnavailableException('天气预警测试卡片生成失败');
  }
}

function createStableMessageUuid(clientMutationId: string): string {
  return createHash('sha256')
    .update(`weather-warning:test:${clientMutationId}`)
    .digest('hex')
    .slice(0, 32);
}

function createStablePersonalTestMessageUuid(
  purpose: string,
  stateKey: string,
): string {
  return createHash('sha256')
    .update(`weather-warning:${purpose}:${stateKey}`)
    .digest('hex')
    .slice(0, 32);
}

function createAutomationMessageUuid(deliveryKey: string): string {
  return createHash('sha256')
    .update(`weather-warning:auto:${deliveryKey}`)
    .digest('hex')
    .slice(0, 32);
}

function createSnapshotSignature(snapshot: WeatherWarningSnapshot): string {
  try {
    return `sha256:${createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex')}`;
  } catch {
    throw new ServiceUnavailableException('天气预警测试快照签名失败');
  }
}

function toReplayResponse(entry: {
  clientMutationId: string;
  messageId: string;
  sentAt: string;
}): WeatherWarningTestSendResponse {
  return {
    success: true,
    sent: true,
    clientMutationId: entry.clientMutationId,
    messageId: entry.messageId,
    sentAt: entry.sentAt,
    message: '天气预警测试卡片已发送',
  };
}

function toNamedReplayResponse(
  entry: { messageId: string; sentAt: string },
  clientMutationId: string,
  message: string,
): WeatherWarningTestSendResponse {
  return {
    success: true,
    sent: true,
    clientMutationId,
    messageId: entry.messageId,
    sentAt: entry.sentAt,
    message,
  };
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isPlainRecord(value) ? value : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== '[object Object]') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
