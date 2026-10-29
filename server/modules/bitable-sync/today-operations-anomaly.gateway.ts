import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  getFeishuAuthPayload,
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import { resolveBitableAppToken } from '../../common/feishu/bitable-direct-read';
import type {
  TodayOperationsAnomalyEvent,
  TodayOperationsAnomalyTerminal,
  TodayOperationsFollowUpRecord,
  TodayOperationsFollowUpSource,
  TodayOperationsFollowUpUpdate,
} from './today-operations-anomaly.types';
import { followUpRecordFingerprint } from './today-operations-follow-up-card.types';

const DEFAULT_SOURCE_URL =
  'https://vnet.feishu.cn/wiki/G7oUwGdwaiTmimk8i2ecGTWOn4d?table=tblCGU1ry3tanQ20&view=vewX0MdewN';
const REQUEST_TIMEOUT_MS = 15_000;
const FIELD_SCHEMA = {
  日期: 5,
  异常项: 1,
  异常说明: 1,
  异常类型: 3,
  已知悉: 7,
  已处理完成: 7,
  处理措施: 1,
  异常唯一键: 1,
  来源: 3,
  楼栋: 1,
  最近发现时间: 5,
  处理人姓名: 1,
  处理时间: 5,
  客户端变更ID: 1,
} as const;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,252}$/u;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

interface Target {
  appToken: string;
  tableId: string;
}

@Injectable()
export class TodayOperationsAnomalyGateway {
  private readonly followUpWrites = new Map<string, Promise<TodayOperationsFollowUpRecord>>();
  private tenantToken: TenantTokenState | null = null;
  private tenantTokenPromise: Promise<string> | null = null;
  private targetPromise: Promise<Target> | null = null;
  private schemaValidated = false;

  constructor(private readonly httpService: HttpService) {}

  recipientOpenId(): string {
    const value = readEnv('TODAY_OPERATIONS_ANOMALY_RECIPIENT_OPEN_ID', [
      'FEISHU_WEATHER_WARNING_TEST_OPEN_ID',
    ]);
    if (!OPEN_ID_PATTERN.test(value)) {
      throw new BadRequestException(
        '今日航图异常提醒接收人 Open ID 未配置或无效',
      );
    }
    return value;
  }

  recipientName(): string {
    return readEnv('TODAY_OPERATIONS_ANOMALY_RECIPIENT_NAME') || '马进宇';
  }

  async ensureRecord(
    anomalyEvent: TodayOperationsAnomalyEvent,
  ): Promise<string> {
    const target = await this.target();
    await this.validateSchema(target);
    const token = await this.getTenantAccessToken();
    const existing = await this.findRecordByKey(
      target,
      token,
      anomalyEvent.anomalyEventId,
    );
    if (existing) return existing;

    const fields = {
      ...buildTodayOperationsFollowUpObjectiveFields(anomalyEvent),
      已知悉: false,
      已处理完成: false,
      处理措施: '',
    };
    const response = await this.httpService.axiosRef.post(
      recordsUrl(target),
      { fields },
      requestConfig(token),
    );
    assertFeishuSuccess(response.data, '创建今日航图异常记录失败');
    const recordId = clean(response.data?.data?.record?.record_id);
    if (!RECORD_ID_PATTERN.test(recordId)) {
      throw new BadGatewayException(
        '创建今日航图异常记录失败：响应缺少记录标识',
      );
    }
    await this.verifyRecord(recordId, fields);
    return recordId;
  }

  async writeEvent(
    recordId: string,
    anomalyEvent: TodayOperationsAnomalyEvent,
  ): Promise<void> {
    if (!RECORD_ID_PATTERN.test(recordId)) {
      throw new BadRequestException('今日航图异常记录标识无效');
    }
    const target = await this.target();
    await this.validateSchema(target);
    const fields = buildTodayOperationsFollowUpObjectiveFields(anomalyEvent);
    const response = await this.httpService.axiosRef.put(
      `${recordsUrl(target)}/${encodeURIComponent(recordId)}`,
      { fields },
      requestConfig(await this.getTenantAccessToken()),
    );
    assertFeishuSuccess(response.data, '合并今日航图异常记录失败');
    await this.verifyRecord(recordId, fields);
  }

  async deleteRecord(recordId: string): Promise<void> {
    if (!RECORD_ID_PATTERN.test(recordId)) {
      throw new BadRequestException('今日航图异常重复记录标识无效');
    }
    const target = await this.target();
    const response = await this.httpService.axiosRef.delete(
      `${recordsUrl(target)}/${encodeURIComponent(recordId)}`,
      requestConfig(await this.getTenantAccessToken()),
    );
    assertFeishuSuccess(response.data, '删除今日航图异常重复记录失败');
  }

  async writeTerminal(
    recordId: string,
    anomalyEvent: TodayOperationsAnomalyEvent,
    result: {
      terminal: TodayOperationsAnomalyTerminal;
      actorName: string;
      handledAt: string;
      treatmentMeasure?: string;
    },
  ): Promise<void> {
    if (!RECORD_ID_PATTERN.test(recordId)) {
      throw new BadRequestException('今日航图异常记录标识无效');
    }
    const target = await this.target();
    await this.validateSchema(target);
    const fields = buildTodayOperationsAnomalyTerminalFields(
      anomalyEvent,
      result,
    );
    const response = await this.httpService.axiosRef.put(
      `${recordsUrl(target)}/${encodeURIComponent(recordId)}`,
      { fields },
      requestConfig(await this.getTenantAccessToken()),
    );
    assertFeishuSuccess(response.data, '回填今日航图异常状态失败');
    await this.verifyRecord(recordId, fields);
  }

  async sendInteractiveCard(
    card: Record<string, unknown>,
    anomalyId: string,
  ): Promise<string> {
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      {
        receive_id: this.recipientOpenId(),
        msg_type: 'interactive',
        content: serializeCard(card),
        uuid: stableTodayOperationsAnomalyMessageUuid(anomalyId),
      },
      requestConfig(await this.getTenantAccessToken()),
    );
    assertFeishuSuccess(response.data, '发送今日航图异常卡片失败');
    const messageId = clean(response.data?.data?.message_id);
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new BadGatewayException(
        '发送今日航图异常卡片失败：响应缺少消息标识',
      );
    }
    return messageId;
  }

  async patchInteractiveCard(
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    if (!MESSAGE_ID_PATTERN.test(messageId)) {
      throw new BadRequestException('飞书互动卡消息标识无效');
    }
    const response = await this.httpService.axiosRef.patch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { content: serializeCard(card) },
      requestConfig(await this.getTenantAccessToken()),
    );
    assertFeishuSuccess(response.data, '更新今日航图异常卡片失败');
  }

  async ensureFollowUpEvent(
    anomalyEvent: TodayOperationsAnomalyEvent,
  ): Promise<string> {
    const recordId = await this.ensureRecord(anomalyEvent);
    await this.writeEvent(recordId, anomalyEvent);
    return recordId;
  }

  async listFollowUps(
    from: string,
    through: string,
  ): Promise<TodayOperationsFollowUpRecord[]> {
    assertDateRange(from, through);
    const target = await this.target();
    await this.validateSchema(target);
    const token = await this.getTenantAccessToken();
    const records: Array<{
      record_id?: unknown;
      fields?: Record<string, unknown>;
    }> = [];
    const seen = new Set<string>();
    let pageToken = '';
    for (let page = 0; page < 100; page += 1) {
      const response = await this.httpService.axiosRef.post(
        `${recordsUrl(target)}/search`,
        { automatic_fields: true },
        {
          ...requestConfig(token),
          params: { page_size: 500, page_token: pageToken || undefined },
        },
      );
      assertFeishuSuccess(response.data, '读取异常跟进记录失败');
      const data = response.data?.data;
      if (Array.isArray(data?.items)) records.push(...data.items);
      if (!data?.has_more) {
        return records
          .map(normalizeTodayOperationsFollowUpRecord)
          .filter((record): record is TodayOperationsFollowUpRecord =>
            Boolean(record),
          )
          .filter((record) => record.date >= from && record.date <= through)
          .sort(
            (left, right) =>
              right.date.localeCompare(left.date) ||
              Number(left.completed) - Number(right.completed) ||
              left.item.localeCompare(right.item, 'zh-CN'),
          );
      }
      const next = clean(data?.page_token);
      if (!next || seen.has(next)) {
        throw new BadGatewayException('读取异常跟进记录失败：分页令牌无效');
      }
      seen.add(next);
      pageToken = next;
    }
    throw new BadGatewayException('读取异常跟进记录失败：超过分页安全上限');
  }

  async getFollowUp(recordId: string): Promise<TodayOperationsFollowUpRecord> {
    if (!RECORD_ID_PATTERN.test(recordId)) {
      throw new BadRequestException('异常跟进记录标识无效');
    }
    const target = await this.target();
    await this.validateSchema(target);
    const response = await this.httpService.axiosRef.get(
      `${recordsUrl(target)}/${encodeURIComponent(recordId)}`,
      requestConfig(await this.getTenantAccessToken()),
    );
    assertFeishuSuccess(response.data, '读取异常跟进记录失败');
    const record = normalizeTodayOperationsFollowUpRecord(
      response.data?.data?.record,
    );
    if (!record) throw new BadGatewayException('异常跟进记录字段无效');
    return record;
  }

  updateFollowUp(
    input: TodayOperationsFollowUpUpdate,
    expected?: TodayOperationsFollowUpRecord,
  ): Promise<TodayOperationsFollowUpRecord> {
    input = structuredClone(input);
    expected = expected && structuredClone(expected);
    const previous = this.followUpWrites.get(input.recordId) || Promise.resolve();
    const write = previous.catch(() => undefined).then(() => this.writeFollowUp(input, expected));
    this.followUpWrites.set(input.recordId, write);
    return write.finally(() => { if (this.followUpWrites.get(input.recordId) === write) this.followUpWrites.delete(input.recordId); });
  }

  private async writeFollowUp(input: TodayOperationsFollowUpUpdate, expected?: TodayOperationsFollowUpRecord): Promise<TodayOperationsFollowUpRecord> {
    const fields = buildTodayOperationsFollowUpUpdateFields(input);
    const current = await this.getFollowUp(input.recordId);
    const target = await this.target();
    const token = await this.getTenantAccessToken();
    const existingMutationId = await this.readMutationId(
      target,
      token,
      input.recordId,
    );
    if (existingMutationId === input.clientMutationId) return current;
    if (expected && followUpRecordFingerprint(expected) !== followUpRecordFingerprint(current)) {
      throw new ConflictException('异常跟进记录已变化，请核对后重新提交');
    }
    const response = await this.httpService.axiosRef.put(
      `${recordsUrl(target)}/${encodeURIComponent(input.recordId)}`,
      { fields },
      requestConfig(token),
    );
    assertFeishuSuccess(response.data, '保存异常跟进失败');
    await this.verifyRecord(input.recordId, fields);
    return this.getFollowUp(input.recordId);
  }

  private async findRecordByKey(
    target: Target,
    token: string,
    issueKey: string,
  ): Promise<string> {
    const response = await this.httpService.axiosRef.post(
      `${recordsUrl(target)}/search`,
      {
        field_names: ['异常唯一键'],
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: '异常唯一键', operator: 'is', value: [issueKey] },
          ],
        },
      },
      { ...requestConfig(token), params: { page_size: 10 } },
    );
    assertFeishuSuccess(response.data, '查找今日航图异常记录失败');
    const records = Array.isArray(response.data?.data?.items)
      ? response.data.data.items
      : [];
    const recordId = clean(records[0]?.record_id);
    return RECORD_ID_PATTERN.test(recordId) ? recordId : '';
  }

  private async readMutationId(
    target: Target,
    token: string,
    recordId: string,
  ): Promise<string> {
    const response = await this.httpService.axiosRef.get(
      `${recordsUrl(target)}/${encodeURIComponent(recordId)}`,
      requestConfig(token),
    );
    assertFeishuSuccess(response.data, '读取异常跟进幂等状态失败');
    return displayText(response.data?.data?.record?.fields?.['客户端变更ID']);
  }

  private async verifyRecord(
    recordId: string,
    expectedFields: Record<string, unknown>,
  ): Promise<void> {
    const target = await this.target();
    const response = await this.httpService.axiosRef.get(
      `${recordsUrl(target)}/${encodeURIComponent(recordId)}`,
      requestConfig(await this.getTenantAccessToken()),
    );
    assertFeishuSuccess(response.data, '回读今日航图异常记录失败');
    const actual = response.data?.data?.record?.fields;
    if (!actual || typeof actual !== 'object') {
      throw new BadGatewayException('回读今日航图异常记录失败：响应缺少字段');
    }
    for (const [name, expected] of Object.entries(expectedFields)) {
      if (
        !areTodayOperationsFieldValuesEqual(
          (actual as Record<string, unknown>)[name],
          expected,
        )
      ) {
        throw new BadGatewayException(`今日航图异常字段回读校验失败：${name}`);
      }
    }
  }

  private async validateSchema(target: Target): Promise<void> {
    if (this.schemaValidated) return;
    const response = await this.httpService.axiosRef.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${target.appToken}/tables/${target.tableId}/fields`,
      {
        ...requestConfig(await this.getTenantAccessToken()),
        params: { page_size: 100 },
      },
    );
    assertFeishuSuccess(response.data, '读取今日航图异常字段失败');
    assertTodayOperationsAnomalyFieldSchema(response.data?.data?.items || []);
    this.schemaValidated = true;
  }

  private target(): Promise<Target> {
    if (this.targetPromise) return this.targetPromise;
    this.targetPromise = (async () => {
      const source = parseFeishuBitableLink(
        readEnv('TODAY_OPERATIONS_ANOMALY_BASE_URL') || DEFAULT_SOURCE_URL,
      );
      const appToken = await resolveBitableAppToken(this.httpService, {
        appToken:
          readEnv('TODAY_OPERATIONS_ANOMALY_APP_TOKEN') || source.appToken,
        wikiToken: source.wikiToken,
        tableName: '今日航图异常提醒',
      });
      const tableId =
        readEnv('TODAY_OPERATIONS_ANOMALY_TABLE_ID') || source.tableId;
      if (!appToken || !/^tbl[A-Za-z0-9_-]+$/u.test(tableId)) {
        throw new BadRequestException('今日航图异常多维表配置不完整');
      }
      return { appToken, tableId };
    })().catch((error) => {
      this.targetPromise = null;
      throw error;
    });
    return this.targetPromise;
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now()) {
      return this.tenantToken.value;
    }
    if (this.tenantTokenPromise) return this.tenantTokenPromise;
    this.tenantTokenPromise = (async () => {
      const response = await this.httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        getFeishuAuthPayload(),
        { timeout: 10_000 },
      );
      assertFeishuSuccess(response.data, '获取飞书应用访问令牌失败');
      const value = clean(
        response.data?.tenant_access_token ||
          response.data?.data?.tenant_access_token,
      );
      if (!value) throw new BadGatewayException('获取飞书应用访问令牌失败');
      const expires = Math.max(60, Number(response.data?.expire || 7_200));
      this.tenantToken = {
        value,
        expiresAt: Date.now() + Math.max(30_000, expires * 1_000 - 60_000),
      };
      return value;
    })();
    try {
      return await this.tenantTokenPromise;
    } finally {
      this.tenantTokenPromise = null;
    }
  }
}

export function stableTodayOperationsAnomalyMessageUuid(
  anomalyId: string,
): string {
  return `toa_${createHash('sha256')
    .update(`today-operations-anomaly:${anomalyId}`)
    .digest('hex')
    .slice(0, 40)}`;
}

export function assertTodayOperationsAnomalyFieldSchema(
  fields: Array<{ field_name?: unknown; type?: unknown }>,
): void {
  for (const [name, type] of Object.entries(FIELD_SCHEMA)) {
    const field = fields.find((candidate) => candidate.field_name === name);
    if (!field || field.type !== type) {
      throw new BadGatewayException(
        `今日航图异常多维表字段不匹配：${name} 应为类型 ${type}`,
      );
    }
  }
}

export function buildTodayOperationsAnomalyItem(
  anomalyEvent: TodayOperationsAnomalyEvent,
): string {
  return anomalyEvent.anomalies
    .map((anomaly) =>
      [
        anomaly.metricLabel,
        anomalyCategoryLabel(anomaly),
        anomaly.scope && anomaly.scope !== '园区' ? `（${anomaly.scope}）` : '',
      ].join(''),
    )
    .join('；');
}

export function buildTodayOperationsFollowUpObjectiveFields(
  anomalyEvent: TodayOperationsAnomalyEvent,
): Record<string, unknown> {
  const buildings = [
    ...new Set(
      anomalyEvent.anomalies
        .map((anomaly) => clean(anomaly.scope))
        .filter((scope) => /^(?:110站|[ABCDEH]楼)$/u.test(scope)),
    ),
  ];
  return {
    日期: Date.parse(`${anomalyEvent.businessDate}T00:00:00+08:00`),
    异常唯一键: anomalyEvent.anomalyEventId,
    来源: anomalyEvent.followUpSource || '今日航图',
    异常类型: followUpType(anomalyEvent),
    异常项: buildTodayOperationsAnomalyItem(anomalyEvent),
    异常说明: buildTodayOperationsAnomalyDescription(anomalyEvent),
    楼栋: buildings.join('、') || '园区',
    最近发现时间: Date.parse(anomalyEvent.detectedAt),
  };
}

function followUpType(
  anomalyEvent: TodayOperationsAnomalyEvent,
): '运行异常' | '排班异常' | '封网&变更' | '考勤异常' {
  if (anomalyEvent.followUpSource === '考勤通晒') return '考勤异常';
  const keys = anomalyEvent.anomalies.map((anomaly) => anomaly.metricKey);
  if (
    keys.length > 0 &&
    keys.every(
      (key) =>
        key.startsWith('dailyPatrol.schedule.') ||
        key.startsWith('scheduleConsistency.'),
    )
  ) {
    return '排班异常';
  }
  if (
    keys.length > 0 &&
    keys.every((key) => key.startsWith('dailyPatrol.plan.'))
  ) {
    return '封网&变更';
  }
  return '运行异常';
}

export function buildTodayOperationsFollowUpUpdateFields(
  input: TodayOperationsFollowUpUpdate,
  now: Date = new Date(),
): Record<string, unknown> {
  if (!RECORD_ID_PATTERN.test(clean(input.recordId))) {
    throw new BadRequestException('异常跟进记录标识无效');
  }
  const clientMutationId = clean(input.clientMutationId);
  if (!/^[A-Za-z0-9:_-]{8,160}$/u.test(clientMutationId)) {
    throw new BadRequestException('异常跟进请求标识无效');
  }
  if (typeof input.treatmentMeasure !== 'string' || typeof input.acknowledged !== 'boolean' || typeof input.completed !== 'boolean') {
    throw new BadRequestException('异常跟进状态或处理措施无效');
  }
  const treatmentMeasure = input.treatmentMeasure.normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ' ').trim();
  const measureLength = Array.from(treatmentMeasure).length;
  if (measureLength > 500 || (input.completed && measureLength < 2)) {
    throw new BadRequestException('标记完成前请填写 2–500 字处理措施');
  }
  const acknowledged = Boolean(input.acknowledged || input.completed);
  return {
    已知悉: acknowledged,
    已处理完成: Boolean(input.completed),
    处理措施: treatmentMeasure,
    处理人姓名: clean(input.handlerName),
    ...(acknowledged ? { 处理时间: now.getTime() } : {}),
    客户端变更ID: clientMutationId,
  };
}

export function normalizeTodayOperationsFollowUpRecord(
  value: unknown,
): TodayOperationsFollowUpRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { record_id?: unknown; fields?: unknown };
  const recordId = clean(record.record_id);
  if (
    !RECORD_ID_PATTERN.test(recordId) ||
    !record.fields ||
    typeof record.fields !== 'object'
  ) {
    return null;
  }
  const fields = record.fields as Record<string, unknown>;
  const timestamp = Number(fields['日期']);
  const date = Number.isFinite(timestamp)
    ? new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 10)
    : '';
  const sourceText = displayText(fields['来源']);
  const source: TodayOperationsFollowUpSource = isFollowUpSource(sourceText)
    ? sourceText
    : '今日航图';
  return {
    recordId,
    issueKey: displayText(fields['异常唯一键']),
    date,
    source,
    item: displayText(fields['异常项']),
    description: displayText(fields['异常说明']),
    building: displayText(fields['楼栋']),
    acknowledged: Boolean(fields['已知悉']),
    completed: Boolean(fields['已处理完成']),
    treatmentMeasure: displayText(fields['处理措施']),
    handlerName: displayText(fields['处理人姓名']),
    handledAt: formatIso(fields['处理时间']),
  };
}

export function buildTodayOperationsAnomalyDescription(
  anomalyEvent: TodayOperationsAnomalyEvent,
): string {
  return anomalyEvent.anomalies
    .flatMap((anomaly, index) => [
      `${index + 1}. ${anomaly.metricLabel}${anomaly.scope ? `（${anomaly.scope}）` : ''}：${buildAnomalySummary(anomaly)}`,
      `位置：${anomaly.location}`,
      ...(anomaly.details.length
        ? [`明细：${anomaly.details.join('；')}`]
        : []),
      `数据日期：${[anomaly.dataDate, anomaly.comparisonDate].filter(Boolean).join(' / ') || anomaly.businessDate}`,
      ...(index < anomalyEvent.anomalies.length - 1 ? [''] : []),
    ])
    .join('\n');
}

function buildAnomalySummary(
  anomaly: TodayOperationsAnomalyEvent['anomalies'][number],
): string {
  if (isAttendanceAnomaly(anomaly)) {
    return anomaly.details.join('；') || '考勤异常';
  }
  if (isScheduleConsistencyAnomaly(anomaly)) {
    return '排班信息不一致，待核验';
  }
  if (anomaly.category === 'missing') return '数据缺失';
  const change =
    anomaly.category === 'increase' &&
    Number(anomaly.previousValue) === 0 &&
    Number(anomaly.currentValue) > 0
      ? '由 0 突增'
      : anomaly.changePercent === null
        ? categoryLabel(anomaly.category)
        : `${anomaly.changePercent > 0 ? '+' : ''}${anomaly.changePercent}%`;
  return `${displayValue(anomaly.previousValue, anomaly.unit)} → ${displayValue(anomaly.currentValue, anomaly.unit)}（${change}）`;
}

function anomalyCategoryLabel(
  anomaly: TodayOperationsAnomalyEvent['anomalies'][number],
): string {
  return isScheduleConsistencyAnomaly(anomaly)
    ? '排班一致性待核验'
    : isAttendanceAnomaly(anomaly)
      ? '考勤异常'
      : categoryLabel(anomaly.category);
}

function isScheduleConsistencyAnomaly(
  anomaly: TodayOperationsAnomalyEvent['anomalies'][number],
): boolean {
  return anomaly.metricKey.startsWith('scheduleConsistency.');
}

function isAttendanceAnomaly(
  anomaly: TodayOperationsAnomalyEvent['anomalies'][number],
): boolean {
  return anomaly.metricKey.startsWith('attendance.');
}

export function buildTodayOperationsAnomalyTerminalFields(
  anomalyEvent: TodayOperationsAnomalyEvent,
  result: {
    terminal: TodayOperationsAnomalyTerminal;
    actorName: string;
    handledAt: string;
    treatmentMeasure?: string;
  },
): Record<string, unknown> {
  const resolved = result.terminal === 'resolved';
  return {
    异常说明: buildTodayOperationsAnomalyDescription(anomalyEvent),
    已知悉: true,
    已处理完成: resolved,
    处理措施: resolved ? clean(result.treatmentMeasure) : '',
  };
}

function categoryLabel(
  category: TodayOperationsAnomalyEvent['anomalies'][number]['category'],
): string {
  if (category === 'missing') return '数据缺失';
  return category === 'increase' ? '异常上涨' : '异常下降';
}

export function areTodayOperationsFieldValuesEqual(
  actual: unknown,
  expected: unknown,
): boolean {
  if (typeof expected === 'boolean') return Boolean(actual) === expected;
  if (typeof expected === 'number') return Number(actual) === expected;
  if (typeof expected === 'string') {
    if (
      expected === '' &&
      (actual === undefined || actual === null || actual === '')
    ) {
      return true;
    }
    if (typeof actual === 'string') return actual === expected;
    if (Array.isArray(actual)) {
      return (
        actual
          .map((part) =>
            typeof part === 'string'
              ? part
              : part && typeof part === 'object'
                ? String((part as Record<string, unknown>).text || '')
                : '',
          )
          .join('') === expected
      );
    }
  }
  return false;
}

function serializeCard(card: Record<string, unknown>): string {
  const content = JSON.stringify(card);
  if (Buffer.byteLength(content, 'utf8') > 30 * 1_024) {
    throw new BadRequestException('今日航图异常卡片内容过大');
  }
  return content;
}

function recordsUrl(target: Target): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${target.appToken}/tables/${target.tableId}/records`;
}

function requestConfig(token: string): Record<string, unknown> {
  return {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT_MS,
  };
}

function assertFeishuSuccess(payload: any, message: string): void {
  if (payload?.code === 0) return;
  throw new BadGatewayException(
    `${message}${payload?.msg ? `：${clean(payload.msg)}` : ''}`,
  );
}

function displayValue(value: number | null, unit: string): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value}${unit}`;
}

function clean(value: unknown): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
}

function cleanLong(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

function displayText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value))
    return value.map(displayText).filter(Boolean).join('');
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    return displayText(
      objectValue.text ?? objectValue.name ?? objectValue.value ?? '',
    );
  }
  return String(value).trim();
}

function formatIso(value: unknown): string {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : '';
}

function isFollowUpSource(
  value: string,
): value is TodayOperationsFollowUpSource {
  return [
    '今日航图',
    '每日巡视',
    '考勤通晒',
    '人工登记',
    '历史手工跟进',
  ].includes(value);
}

function assertDateRange(from: string, through: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(through) ||
    from > through
  ) {
    throw new BadRequestException('异常跟进日期范围无效');
  }
}
