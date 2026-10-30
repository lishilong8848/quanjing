import { observedCardPost, observedCardPatch, observedCardTokenUpdate } from '../../common/feishu-card-copy/transport';
import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import FormData = require('form-data');
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import {
  getFeishuAuthPayload,
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  extractDisplayText,
  extractDisplayValues,
  extractNumberValue,
  getRecordId,
  invalidateBitableRecordCache,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import type {
  PurchaseWorkflowRecord,
  PurchaseWorkflowUser,
} from '../../../shared/purchase-workflow.interface';
import { readPurchaseManagerApprover } from './purchase-manager-approval.config';
import { readConfiguredCardMembers } from '../../common/access/access-configuration.service';
import { purchaseAuthorityTarget } from './purchase-authority-target';
import type { PurchaseExecutorHandover } from './purchase-executor-handover';
import { resolvePurchaseStage, normalizeMethod } from './purchase-workflow.rules';
import { PurchaseComparisonCardAssetsStore } from './purchase-comparison-card-assets.store';
import { preparePurchaseComparisonCardEvidence } from './purchase-comparison-card-media';
import type { PurchaseComparisonCardEvidence } from './purchase-comparison-card-evidence';
import {
  PURCHASE_MANAGER_APPROVAL_FIELD_DEFINITIONS,
  PURCHASE_MANAGER_APPROVAL_FIELDS,
  PURCHASE_MANAGER_APPROVAL_POLICY_VERSION,
  type PurchaseManagerApprovalFieldDefinition,
} from './purchase-manager-approval.fields';

interface PurchaseWorkflowConfig {
  appToken: string;
  executionTableId: string;
  submissionTableId: string;
  organizationTableId: string;
}

export interface PurchaseWorkflowRecordRecoveryList {
  records: PurchaseWorkflowRecord[];
  errors: Array<{ recordId: string; message: string }>;
}

interface TenantTokenState {
  value: string;
  expiresAt: number;
}

interface OrganizationRecordsState {
  value: BitableRecordItem[];
  dayKey: string;
}

interface WarehouseRecipientAssignment {
  building: string;
  responsibleUsers: PurchaseWorkflowUser[];
  managerUsers: PurchaseWorkflowUser[];
}

interface WarehouseRecipientSnapshot {
  version: 1;
  sourceFingerprint: string;
  syncedAt: string;
  assignments: WarehouseRecipientAssignment[];
}

const COMPREHENSIVE_PURCHASE_POSITION = '综合管理';
const BUILDING_SUPERVISOR_POSITIONS = new Set(['设施运维主管', '楼栋主管']);
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1_000;
const WAREHOUSE_RECIPIENT_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

export class InboundResponsibleUsersNotConfiguredException extends ServiceUnavailableException {
  constructor(building: string) {
    super(`${clean(building) || '目标楼栋'}未配置有效的库房责任人员`);
  }
}

const INTERACTIVE_CARD_MAX_BYTES = 30 * 1024;
// Feishu deduplicates create-message UUIDs for one hour; callers must
// reconcile an unknown delivery outcome instead of blindly retrying past it.
const INTERACTIVE_MESSAGE_UUID_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;
const EXECUTION_RECORD_READ_TOTAL_TIMEOUT_MS = 30_000;
const MANAGER_APPROVAL_DECISION_TIMEOUT_MS = 8_000;
const EXECUTION_RECORD_READ_RETRY_DELAYS_MS = [
  250, 500, 1_000, 1_500, 2_000, 3_000, 5_000,
];
const TRANSIENT_EXECUTION_RECORD_READ_FEISHU_CODES = new Set([1254607]);
const TRANSIENT_EXECUTION_RECORD_READ_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

export interface PurchaseWorkflowUploadFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class PurchaseWorkflowGateway {
  private readonly logger = new Logger(PurchaseWorkflowGateway.name);
  private readonly comparisonCardAssets = new PurchaseComparisonCardAssetsStore();
  private tenantToken: TenantTokenState | null = null;
  private tenantTokenPromise: Promise<string> | null = null;
  private managerApprovalFieldsReady = false;
  private managerApprovalFieldsPromise: Promise<void> | null = null;
  private receiptAttachmentFieldName = '';
  private receiptAttachmentFieldPromise: Promise<string> | null = null;
  private organizationRecords: OrganizationRecordsState | null = null;
  private organizationRecordsPromise: Promise<BitableRecordItem[]> | null =
    null;
  private warehouseRecipientSnapshot: WarehouseRecipientSnapshot | null = null;
  private warehouseRecipientSnapshotLoaded = false;
  private warehouseRecipientLoadPromise: Promise<WarehouseRecipientSnapshot | null> | null =
    null;
  private warehouseRecipientRefreshPromise: Promise<WarehouseRecipientSnapshot> | null =
    null;

  constructor(private readonly httpService: HttpService) {}

  async getExecutionRecord(
    recordId: string,
    userAccessToken: string,
  ): Promise<PurchaseWorkflowRecord> {
    return this.getExecutionRecordWithBudget(
      recordId,
      userAccessToken,
      EXECUTION_RECORD_READ_TOTAL_TIMEOUT_MS,
    );
  }

  async getManagerApprovalDecisionRecordAsApp(
    recordId: string,
  ): Promise<PurchaseWorkflowRecord> {
    return this.getExecutionRecordWithBudget(
      recordId,
      await this.getTenantAccessToken(),
      MANAGER_APPROVAL_DECISION_TIMEOUT_MS,
    );
  }

  private async getExecutionRecordWithBudget(
    recordId: string,
    userAccessToken: string,
    totalTimeoutMs: number,
  ): Promise<PurchaseWorkflowRecord> {
    const config = this.config();
    const recordUrl = `${recordsUrl(config.appToken, config.executionTableId)}/${encodeURIComponent(recordId)}`;
    const response = await retryTransientExecutionRecordRead(
      (timeout) =>
        this.httpService.axiosRef.get(recordUrl, {
          ...requestConfig(userAccessToken, timeout),
        }),
      totalTimeoutMs,
    );
    assertFeishuSuccess(response.data, '读取采购执行记录失败');
    const record = response.data?.data?.record as BitableRecordItem | undefined;
    if (!record)
      throw new BadGatewayException('读取采购执行记录失败：响应缺少 record');
    return mapExecutionRecord(record);
  }

  async getExecutionRecordAsApp(
    recordId: string,
  ): Promise<PurchaseWorkflowRecord> {
    return mapExecutionRecord(await this.readExecutionRecordAsApp(recordId));
  }

  async prepareManagerComparisonEvidence(expected: PurchaseWorkflowRecord): Promise<PurchaseComparisonCardEvidence> {
    if (expected.procurementForm !== '三方比价') throw new BadRequestException('非三方比价采购不读取比价附件');
    const config = this.config();
    const rawRecord = await this.readExecutionRecordAsApp(expected.recordId);
    return preparePurchaseComparisonCardEvidence({
      source: { appId: readEnv('FEISHU_APP_ID'), appToken: config.appToken, tableId: config.executionTableId, sourceUrl: readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL') },
      expected, actual: mapExecutionRecord(rawRecord), rawRecord, token: await this.getTenantAccessToken(),
      http: this.httpService, cache: this.comparisonCardAssets,
    });
  }

  async prepareManagerComparisonBatchEvidence(expected: PurchaseWorkflowRecord[]): Promise<PurchaseComparisonCardEvidence[]> {
    if (!expected.length || expected.length > 20 || expected.some(record => record.procurementForm !== '三方比价') || new Set(expected.map(record => record.recordId)).size !== expected.length) {
      throw new BadRequestException('采购比价附件批次范围无效');
    }
    const config = this.config(), token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef.post(`${recordsUrl(config.appToken, config.executionTableId)}/batch_get`,
      { record_ids: expected.map(record => record.recordId) }, { ...requestConfig(token, 10_000), maxRedirects: 0 });
    assertFeishuSuccess(response.data, '读取当前采购批次比价附件失败');
    const data = response.data?.data;
    if (!Array.isArray(data?.records) || data.records.length !== expected.length || data.absent_record_ids?.length || data.forbidden_record_ids?.length) throw new BadGatewayException('当前采购批次比价附件记录不完整');
    const actual = new Map<string, BitableRecordItem>();
    for (const raw of data.records) {
      const recordId = isPlainObject(raw) ? getRecordId(raw as BitableRecordItem) : '';
      if (!recordId || !expected.some(record => record.recordId === recordId) || actual.has(recordId) || !raw.fields) throw new BadGatewayException('当前采购批次比价附件记录不一致');
      actual.set(recordId, raw as BitableRecordItem);
    }
    const previewBudget = new Set<string>(), evidence: PurchaseComparisonCardEvidence[] = [];
    for (const record of expected) {
      const rawRecord = actual.get(record.recordId)!;
      evidence.push(await preparePurchaseComparisonCardEvidence({
        source: { appId: readEnv('FEISHU_APP_ID'), appToken: config.appToken, tableId: config.executionTableId, sourceUrl: readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL') },
        expected: record, actual: mapExecutionRecord(rawRecord), rawRecord, token, http: this.httpService, cache: this.comparisonCardAssets, previewBudget,
      }));
    }
    return evidence;
  }

  private async readExecutionRecordAsApp(recordId: string): Promise<BitableRecordItem> {
    const config = this.config();
    const token = await this.getTenantAccessToken();
    const response = await retryTransientExecutionRecordRead(
      (timeout) =>
        this.httpService.axiosRef.post(
          `${recordsUrl(config.appToken, config.executionTableId)}/batch_get`,
          { record_ids: [recordId] },
          requestConfig(token, Math.min(timeout, 10_000)),
        ),
      EXECUTION_RECORD_READ_TOTAL_TIMEOUT_MS,
    );
    assertFeishuSuccess(response.data, '读取采购执行记录失败');
    const data = response.data?.data;
    if (data?.absent_record_ids?.includes(recordId)) {
      throw new BadGatewayException('读取采购执行记录失败：目标记录不存在');
    }
    if (data?.forbidden_record_ids?.includes(recordId)) {
      throw new BadGatewayException('读取采购执行记录失败：无权读取目标记录');
    }
    const records = data?.records;
    if (!Array.isArray(records)) {
      throw new BadGatewayException('读取采购执行记录失败：响应缺少 records');
    }
    const matching = records.filter(
      (record: unknown): record is BitableRecordItem =>
        isPlainObject(record) &&
        getRecordId(record as BitableRecordItem) === recordId,
    );
    if (matching.length !== 1 || !matching[0]?.fields) {
      throw new BadGatewayException(
        '读取采购执行记录失败：响应缺少唯一目标记录',
      );
    }
    return matching[0];
  }

  async listExecutionRecords(
    userAccessToken: string,
    filter = '',
  ): Promise<PurchaseWorkflowRecord[]> {
    const config = this.config();
    const records = await this.listRecords(
      config.appToken,
      config.executionTableId,
      userAccessToken,
      filter,
    );
    return records.map(mapExecutionRecord).filter((record) => record.recordId);
  }

  async listExecutionRecordsAsApp(
    filter = '',
  ): Promise<PurchaseWorkflowRecord[]> {
    return this.listExecutionRecords(await this.getTenantAccessToken(), filter);
  }

  async listExecutionRecordsForRecoveryAsApp(
    filter = '',
  ): Promise<PurchaseWorkflowRecordRecoveryList> {
    const config = this.config();
    const rawRecords = await this.listRecords(
      config.appToken,
      config.executionTableId,
      await this.getTenantAccessToken(),
      filter,
    );
    const records: PurchaseWorkflowRecord[] = [];
    const errors: PurchaseWorkflowRecordRecoveryList['errors'] = [];
    for (const rawRecord of rawRecords) {
      try {
        const record = mapExecutionRecord(rawRecord);
        if (record.recordId) {
          records.push(record);
        } else {
          errors.push({
            recordId: 'unknown',
            message: '采购执行记录缺少 record_id',
          });
        }
      } catch (error) {
        errors.push({
          recordId: getRecordId(rawRecord) || 'unknown',
          message: errorMessage(error).slice(0, 500),
        });
      }
    }
    return { records, errors };
  }

  async ensureManagerApprovalFieldsAsApp(): Promise<void> {
    if (this.managerApprovalFieldsReady) return;
    if (this.managerApprovalFieldsPromise) {
      return this.managerApprovalFieldsPromise;
    }
    this.managerApprovalFieldsPromise = this.ensureManagerApprovalFields();
    try {
      await this.managerApprovalFieldsPromise;
      this.managerApprovalFieldsReady = true;
    } finally {
      this.managerApprovalFieldsPromise = null;
    }
  }

  async updateExecutionRecord(
    recordId: string,
    fields: Record<string, unknown>,
    userAccessToken: string,
  ): Promise<void> {
    await this.updateExecutionRecordWithTimeout(
      recordId,
      fields,
      userAccessToken,
      30_000,
    );
  }

  async updateManagerApprovalDecisionRecordAsApp(
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await this.updateExecutionRecordWithTimeout(
      recordId,
      fields,
      await this.getTenantAccessToken(),
      MANAGER_APPROVAL_DECISION_TIMEOUT_MS,
    );
  }

  private async updateExecutionRecordWithTimeout(
    recordId: string,
    fields: Record<string, unknown>,
    userAccessToken: string,
    timeoutMs: number,
  ): Promise<void> {
    const config = this.config();
    const resolvedFields = await this.resolveExecutionFieldNames(
      fields,
      userAccessToken,
    );
    const response = await this.httpService.axiosRef.put(
      `${recordsUrl(config.appToken, config.executionTableId)}/${encodeURIComponent(recordId)}`,
      { fields: resolvedFields },
      requestConfig(userAccessToken, timeoutMs),
    );
    assertFeishuSuccess(response.data, '更新采购执行记录失败');
    invalidateBitableRecordCache({
      appToken: config.appToken,
      tableId: config.executionTableId,
    });
  }

  private async resolveExecutionFieldNames(
    fields: Record<string, unknown>,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    if (!Object.prototype.hasOwnProperty.call(fields, '签收附件'))
      return fields;
    const actualFieldName =
      await this.resolveReceiptAttachmentFieldName(accessToken);
    const resolved = { ...fields };
    const value = resolved['签收附件'];
    delete resolved['签收附件'];
    resolved[actualFieldName] = value;
    return resolved;
  }

  private async resolveReceiptAttachmentFieldName(
    accessToken: string,
  ): Promise<string> {
    if (this.receiptAttachmentFieldName) {
      return this.receiptAttachmentFieldName;
    }
    if (this.receiptAttachmentFieldPromise) {
      return this.receiptAttachmentFieldPromise;
    }
    this.receiptAttachmentFieldPromise = (async () => {
      const config = this.config();
      const url = fieldsUrl(config.appToken, config.executionTableId);
      const fields: Array<Record<string, unknown>> = [];
      let pageToken = '';
      let hasMore = true;
      while (hasMore) {
        const response = await this.httpService.axiosRef.get(url, {
          ...requestConfig(accessToken),
          params: {
            page_size: 200,
            page_token: pageToken || undefined,
          },
        });
        assertFeishuSuccess(response.data, '读取采购签收附件字段失败');
        const data = response.data?.data || {};
        fields.push(...(Array.isArray(data.items) ? data.items : []));
        pageToken = clean(data.page_token);
        hasMore = Boolean(data.has_more);
      }
      const matches = fields.filter(
        (field) =>
          clean(field.field_name).startsWith('签收附件') &&
          Number(field.type) === 17,
      );
      if (matches.length === 0) {
        throw new BadGatewayException('采购执行表缺少签收附件字段');
      }
      if (matches.length > 1) {
        throw new ConflictException('采购执行表签收附件字段不唯一');
      }
      const fieldName = clean(matches[0]?.field_name);
      if (!fieldName) {
        throw new BadGatewayException('采购执行表签收附件字段无效');
      }
      this.receiptAttachmentFieldName = fieldName;
      return fieldName;
    })();
    try {
      return await this.receiptAttachmentFieldPromise;
    } finally {
      this.receiptAttachmentFieldPromise = null;
    }
  }

  async writePurchaseExecutorHandover(input: PurchaseExecutorHandover): Promise<void> {
    const appId = process.env.FEISHU_APP_ID?.trim();
    if (!appId || appId !== input.appId || !isOpenId(input.sourceOpenId) || !isOpenId(input.targetOpenId) || input.sourceOpenId === input.targetOpenId) throw new ConflictException('采购执行交接应用或人员身份已变化');
    const matches = (record: PurchaseWorkflowRecord, openId: string) => record.recordId === input.recordId &&
      resolvePurchaseStage(record.status) === 'ordering' && !record.purchaseCompleted && record.approvalCompleted &&
      record.purchaserOpenId === openId && normalizeMethod(record.purchaseMethod) === (input.choice === 'building_self' ? '需求自采' : '综合采购') && JSON.stringify(purchaseAuthorityTarget(record)) === JSON.stringify(input.scope);
    const before = await this.getExecutionRecordAsApp(input.recordId);
    if (matches(before, input.targetOpenId)) return;
    if (!matches(before, input.sourceOpenId) || process.env.FEISHU_APP_ID?.trim() !== appId) throw new ConflictException('采购明细已下单或负责人、楼栋专业已变化，不能转交');
    let writeFailed = false;
    try { await this.updateExecutionRecordAsApp(input.recordId, { 采购人: [{ id: input.targetOpenId }] }); }
    catch { writeFailed = true; }
    if (!matches(await this.getExecutionRecordAsApp(input.recordId), input.targetOpenId) || process.env.FEISHU_APP_ID?.trim() !== appId) throw new BadGatewayException(writeFailed ? '采购执行交接写入结果待核对，可恢复原任务' : '采购执行交接身份回读不一致，可恢复原任务');
  }

  async writeManagerPendingHandover(input: { recordId: string; sourceOpenId: string; targetOpenId: string; approvalBatchId: string }): Promise<void> {
    if (!input || !/^[A-Za-z0-9_-]{1,100}$/u.test(input.recordId) || !/^[A-Za-z0-9_-]{8,160}$/u.test(input.approvalBatchId) ||
      !isOpenId(input.sourceOpenId) || !isOpenId(input.targetOpenId) || input.sourceOpenId === input.targetOpenId) throw new BadRequestException('采购交接身份或批次无效');
    const read = async (): Promise<Record<string, unknown>> => {
      const config = this.config(), token = await this.getTenantAccessToken();
      const response = await this.httpService.axiosRef.post(`${recordsUrl(config.appToken, config.executionTableId)}/batch_get`,
        { record_ids: [input.recordId] }, { ...requestConfig(token), params: { user_id_type: 'open_id' } });
      assertFeishuSuccess(response.data, '读取采购交接状态失败');
      const data = response.data?.data, records = data?.records;
      if (!Array.isArray(records) || data?.absent_record_ids?.includes(input.recordId) || data?.forbidden_record_ids?.includes(input.recordId)) throw new BadGatewayException('采购交接目标记录不可读取');
      const matching = records.filter((value: unknown): value is BitableRecordItem => isPlainObject(value) && getRecordId(value as BitableRecordItem) === input.recordId);
      if (matching.length !== 1 || !isPlainObject(matching[0].fields)) throw new BadGatewayException('采购交接未返回唯一目标字段');
      return matching[0].fields;
    };
    const empty = (value: unknown) => value == null || value === '' || Array.isArray(value) && value.length === 0;
    const matches = (fields: Record<string, unknown>, openId: string) => {
      const record = mapExecutionRecord({ record_id: input.recordId, fields });
      const users = extractUsers(fields[PURCHASE_MANAGER_APPROVAL_FIELDS.currentApprover]).map(person => person.openId);
      return record.status === '未开始（待审批）' && !record.approvalCompleted && record.approvalSource === '程序卡片' &&
        record.approvalWorkflowStatus === '待经理审批' && record.approvalPolicyVersion === PURCHASE_MANAGER_APPROVAL_POLICY_VERSION &&
        record.approvalBatchId === input.approvalBatchId && !record.approvalActionId && users.length === 1 && users[0] === openId &&
        empty(fields[PURCHASE_MANAGER_APPROVAL_FIELDS.actualApprover]) && empty(fields[PURCHASE_MANAGER_APPROVAL_FIELDS.approvalTime]);
    };
    const before = await read(); if (matches(before, input.targetOpenId)) return;
    if (!matches(before, input.sourceOpenId)) throw new ConflictException('原采购待审批状态或负责人已变化，不能交接');
    let writeFailed = false;
    try { await this.updateExecutionRecordAsApp(input.recordId, { [PURCHASE_MANAGER_APPROVAL_FIELDS.currentApprover]: [{ id: input.targetOpenId }], [PURCHASE_MANAGER_APPROVAL_FIELDS.error]: '' }); }
    catch { writeFailed = true; }
    if (!matches(await read(), input.targetOpenId)) throw new BadGatewayException(writeFailed ? '采购交接写入和身份回读尚未确认，可安全重试' : '采购交接身份语义回读不一致，可安全重试');
  }

  async writeManagerHandoverDeliveryReceipt(input: { recordId: string; targetOpenId: string; approvalBatchId: string; messageId: string; deliveryUuid: string; deliveredAt: string; deliveryAttempts: number }): Promise<void> {
    const deliveredAt = Date.parse(input?.deliveredAt);
    if (!input || !/^[A-Za-z0-9_-]{1,100}$/u.test(input.recordId) || !isOpenId(input.targetOpenId) ||
      !/^[A-Za-z0-9_-]{8,160}$/u.test(input.approvalBatchId) || !/^om_[A-Za-z0-9_-]+$/u.test(input.messageId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.deliveryUuid) ||
      !Number.isFinite(deliveredAt) || !Number.isSafeInteger(input.deliveryAttempts) || input.deliveryAttempts < 1) throw new BadRequestException('采购交接投递回执无效');
    const read = async (): Promise<Record<string, unknown>> => {
      const config = this.config(), token = await this.getTenantAccessToken();
      const response = await this.httpService.axiosRef.post(`${recordsUrl(config.appToken, config.executionTableId)}/batch_get`,
        { record_ids: [input.recordId] }, { ...requestConfig(token), params: { user_id_type: 'open_id' } });
      assertFeishuSuccess(response.data, '读取采购投递回执失败');
      const data = response.data?.data, records = data?.records;
      if (!Array.isArray(records) || data?.absent_record_ids?.includes(input.recordId) || data?.forbidden_record_ids?.includes(input.recordId)) throw new BadGatewayException('采购投递回执目标记录不可读取');
      const matching = records.filter((value: unknown): value is BitableRecordItem => isPlainObject(value) && getRecordId(value as BitableRecordItem) === input.recordId);
      if (matching.length !== 1 || !isPlainObject(matching[0].fields)) throw new BadGatewayException('采购投递回执未返回唯一目标字段');
      return matching[0].fields;
    };
    const bound = (fields: Record<string, unknown>) => {
      const record = mapExecutionRecord({ record_id: input.recordId, fields });
      const current = extractUsers(fields[PURCHASE_MANAGER_APPROVAL_FIELDS.currentApprover]).map(person => person.openId);
      const actual = extractUsers(fields[PURCHASE_MANAGER_APPROVAL_FIELDS.actualApprover]).map(person => person.openId);
      return record.approvalSource === '程序卡片' && record.approvalPolicyVersion === PURCHASE_MANAGER_APPROVAL_POLICY_VERSION && record.approvalBatchId === input.approvalBatchId &&
        (current.length === 1 && current[0] === input.targetOpenId || current.length === 0 && actual.length === 1 && actual[0] === input.targetOpenId);
    };
    const fields = { [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryState]: '已送达', [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryTime]: deliveredAt,
      [PURCHASE_MANAGER_APPROVAL_FIELDS.messageId]: input.messageId, [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryUuid]: input.deliveryUuid,
      [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryAttempts]: input.deliveryAttempts };
    const confirmed = (record: Record<string, unknown>) => bound(record) && Object.entries(fields).every(([key, value]) =>
      key === PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryTime ? dateNumber(record[key]) === value :
        typeof value === 'number' ? extractNumberValue(record[key]) === value : extractDisplayText(record[key]) === value);
    const before = await read(); if (!bound(before)) throw new ConflictException('采购新卡回执与当前或实际审批身份不一致');
    if (confirmed(before)) return;
    try { await this.updateExecutionRecordAsApp(input.recordId, fields); } catch { /* The semantic readback below proves the write outcome. */ }
    if (!confirmed(await read())) throw new BadGatewayException('采购新卡投递语义回执尚未确认，可安全重试');
  }

  async updateExecutionRecordAsApp(
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await this.updateExecutionRecord(
      recordId,
      fields,
      await this.getTenantAccessToken(),
    );
  }

  async updateSubmissionRecord(
    recordId: string,
    fields: Record<string, unknown>,
    userAccessToken: string,
  ): Promise<void> {
    const config = this.config();
    const response = await this.httpService.axiosRef.put(
      `${recordsUrl(config.appToken, config.submissionTableId)}/${encodeURIComponent(recordId)}`,
      { fields },
      requestConfig(userAccessToken),
    );
    assertFeishuSuccess(response.data, '更新采购提交记录失败');
    invalidateBitableRecordCache({
      appToken: config.appToken,
      tableId: config.submissionTableId,
    });
  }

  async updateSubmissionRecordAsApp(
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    await this.updateSubmissionRecord(
      recordId,
      fields,
      await this.getTenantAccessToken(),
    );
  }

  async createExecutionRecord(
    fields: Record<string, unknown>,
    userAccessToken: string,
  ): Promise<string> {
    const config = this.config();
    return this.createRecord(
      config.appToken,
      config.executionTableId,
      fields,
      userAccessToken,
      '采购执行',
    );
  }

  async createSubmissionRecord(
    fields: Record<string, unknown>,
    userAccessToken: string,
  ): Promise<string> {
    const config = this.config();
    return this.createRecord(
      config.appToken,
      config.submissionTableId,
      fields,
      userAccessToken,
      '采购提交',
    );
  }

  async deleteExecutionRecord(
    recordId: string,
    userAccessToken: string,
  ): Promise<void> {
    const config = this.config();
    await this.deleteRecord(
      config.appToken,
      config.executionTableId,
      recordId,
      userAccessToken,
      '采购执行',
    );
  }

  async deleteSubmissionRecord(
    recordId: string,
    userAccessToken: string,
  ): Promise<void> {
    const config = this.config();
    await this.deleteRecord(
      config.appToken,
      config.submissionTableId,
      recordId,
      userAccessToken,
      '采购提交',
    );
  }

  async batchDeleteRecordsAsApp(input: {
    submissionRecordIds: string[];
    executionRecordIds: string[];
  }): Promise<void> {
    const config = this.config();
    const accessToken = await this.getTenantAccessToken();
    await Promise.all([
      this.batchDeleteRecords(
        config.appToken,
        config.submissionTableId,
        input.submissionRecordIds,
        accessToken,
        '采购提交',
      ),
      this.batchDeleteRecords(
        config.appToken,
        config.executionTableId,
        input.executionRecordIds,
        accessToken,
        '采购执行',
      ),
    ]);
  }

  async getTenantAccessTokenAsApp(): Promise<string> {
    return this.getTenantAccessToken();
  }

  async downloadMessageImage(
    messageIdValue: string,
    imageKeyValue: string,
  ): Promise<PurchaseWorkflowUploadFile> {
    const messageId = clean(messageIdValue);
    const imageKey = clean(imageKeyValue);
    if (
      !/^om_[A-Za-z0-9_-]{1,256}$/u.test(messageId) ||
      !/^[A-Za-z0-9_:-]{1,256}$/u.test(imageKey)
    ) {
      throw new BadRequestException('飞书签收图片资源标识无效');
    }
    const token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef
      .get(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { type: 'image' },
          responseType: 'arraybuffer',
          timeout: 60_000,
          maxContentLength: 20 * 1024 * 1024,
        },
      )
      .catch((error: unknown) =>
        rethrowFeishuResponseError(error, '下载飞书签收图片失败'),
      );
    const buffer = Buffer.from(response.data);
    const mimetype = clean(response.headers?.['content-type'])
      .split(';')[0]
      ?.toLowerCase();
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) {
      throw new BadGatewayException('飞书签收图片大小无效');
    }
    if (!mimetype?.startsWith('image/')) {
      throw new BadGatewayException('飞书签收图片类型无效');
    }
    return {
      originalname: `receipt-${imageKey}.${imageExtension(mimetype)}`,
      mimetype,
      size: buffer.length,
      buffer,
    };
  }

  async probeDeleteCapability(
    userAccessToken: string,
  ): Promise<{ allowed: boolean; reason: string }> {
    const config = this.config();
    const probeId = '__codex_purchase_delete_capability_probe__';
    try {
      const response = await this.httpService.axiosRef.delete(
        `${recordsUrl(config.appToken, config.executionTableId)}/${probeId}`,
        requestConfig(userAccessToken),
      );
      const code = Number(response.data?.code || 0);
      const message = clean(response.data?.msg);
      if (code === 0 || looksLikeNotFound(message))
        return { allowed: true, reason: '' };
      return { allowed: false, reason: message || `飞书错误码 ${code}` };
    } catch (error) {
      const status = Number(
        (error as { response?: { status?: number } })?.response?.status,
      );
      const payload = (
        error as { response?: { data?: { msg?: string; message?: string } } }
      )?.response?.data;
      const message = clean(
        payload?.msg || payload?.message || errorMessage(error),
      );
      if (status === 404 && looksLikeNotFound(message))
        return { allowed: true, reason: '' };
      return {
        allowed: false,
        reason: message || (status ? `HTTP ${status}` : '无法证明删除权限'),
      };
    }
  }

  async searchSelfTestRecordIds(
    marker: string,
    userAccessToken: string,
  ): Promise<string[]> {
    const config = this.config();
    const escapedMarker = marker.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const records = await this.listRecords(
      config.appToken,
      config.executionTableId,
      userAccessToken,
      `CurrentValue.[采购编码]="${escapedMarker}"`,
    );
    return records.map(getRecordId).filter(Boolean);
  }

  async resolveUser(
    openId: string,
    userAccessToken: string,
  ): Promise<PurchaseWorkflowUser> {
    const config = this.config();
    const organizationTableId = requireOrganizationTableId(config);
    const records = await this.listRecords(
      config.appToken,
      organizationTableId,
      userAccessToken,
    );
    const matches = records
      .flatMap(mapOrganizationRecordUsers)
      .filter((user) => user.openId === openId);
    if (!matches.length) {
      return { openId, name: '', positions: [], buildings: [] };
    }
    return matches.reduce<PurchaseWorkflowUser>(
      (result, user) => ({
        openId,
        name: result.name || user.name,
        positions: unique([...result.positions, ...user.positions]),
        buildings: unique([...result.buildings, ...user.buildings]),
      }),
      { openId, name: '', positions: [], buildings: [] },
    );
  }

  async resolveUserAsApp(openId: string): Promise<PurchaseWorkflowUser> {
    return this.resolveUser(openId, await this.getTenantAccessTokenAsApp());
  }

  async resolveConfiguredApproversAsApp(scope?:Pick<PurchaseWorkflowRecord,'building'|'specialty'>): Promise<PurchaseWorkflowUser[]> {
    const configured = readConfiguredCardMembers('purchase_approvers', scope?.building||null,scope?.specialty||undefined);
    if (configured) return configured.map(person => configuredWorkflowUser(person, '设施运维经理'));
    const configuredOpenIds = unique(
      readEnv('PURCHASE_WORKFLOW_APPROVER_OPEN_IDS').split(',').map(clean),
    );
    if (!configuredOpenIds.length) {
      throw new ServiceUnavailableException('采购审批人 open_id 配置缺失');
    }
    const usersByOpenId = new Map(
      (await this.listOrganizationUsersAsApp()).map((user) => [
        user.openId,
        user,
      ]),
    );
    return configuredOpenIds.map(
      (openId) =>
        usersByOpenId.get(openId) || {
          openId,
          name: '',
          positions: [],
          buildings: [],
        },
    );
  }

  async resolvePurchaseAdminAsApp(scope?:Pick<PurchaseWorkflowRecord,'building'|'specialty'>): Promise<PurchaseWorkflowUser> {
    const configured = readConfiguredCardMembers('purchase_executor', scope?.building||null,scope?.specialty||undefined);
    if (configured) return configuredWorkflowUser(configured[0], COMPREHENSIVE_PURCHASE_POSITION,scope?.building);
    const openId = readEnv('PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID');
    if (!isOpenId(openId)) {
      throw new ServiceUnavailableException(
        '采购管理员 open_id 配置缺失或无效',
      );
    }
    const match = (await this.listOrganizationUsersAsApp()).find(
      (user) =>
        user.openId === openId &&
        user.positions.includes(COMPREHENSIVE_PURCHASE_POSITION),
    );
    if (!match) {
      throw new ServiceUnavailableException(
        '综合采购人未在组织架构中配置为综合管理',
      );
    }
    return match;
  }

  async resolvePurchaseManagerApproverAsApp(): Promise<PurchaseWorkflowUser> {
    const configured = readPurchaseManagerApprover();
    const match = (await this.listOrganizationUsersAsApp()).find(
      (user) => user.openId === configured.openId,
    );
    return match
      ? { ...match, name: match.name || configured.name }
      : {
          openId: configured.openId,
          name: configured.name,
          positions: [],
          buildings: [],
        };
  }

  async resolveBuildingSupervisorAsApp(
    building: string,
    specialty?: string,
  ): Promise<PurchaseWorkflowUser> {
    const normalizedBuilding = normalizeBuilding(building);
    const configured = readConfiguredCardMembers('building_executor', normalizeConfiguredBuilding(building),specialty||undefined);
    if (configured) return configuredWorkflowUser(configured[0], '设施运维主管', building);
    if (!normalizedBuilding) {
      throw new BadRequestException('目标楼栋不能为空');
    }
    const records = await this.listOrganizationRecordsAsApp();
    const matchingOpenIds = new Set(
      records
        .flatMap(mapOrganizationRecordUsers)
        .filter(
          (user) =>
            user.openId &&
            user.positions.some((position) =>
              BUILDING_SUPERVISOR_POSITIONS.has(position),
            ) &&
            user.buildings.some(
              (candidate) =>
                normalizeBuilding(candidate) === normalizedBuilding,
            ),
        )
        .map((user) => user.openId),
    );
    const matches = groupOrganizationUsers(records).filter((user) =>
      matchingOpenIds.has(user.openId),
    );
    if (!matches.length) {
      throw new ServiceUnavailableException(
        `${clean(building) || '目标楼栋'}未配置唯一设施运维主管`,
      );
    }
    if (matches.length > 1) {
      throw new ConflictException(
        `${clean(building) || '目标楼栋'}配置了多个设施运维主管`,
      );
    }
    return matches[0];
  }

  async resolveWarehouseManagersAsApp(
    building: string,
  ): Promise<PurchaseWorkflowUser[]> {
    const normalizedBuilding = normalizeBuilding(building);
    const configured = readConfiguredCardMembers('warehouse_responsible', normalizeConfiguredBuilding(building));
    if (configured) return configured.map(person => configuredWorkflowUser(person, '库房管理', building));
    if (!normalizedBuilding) {
      throw new BadRequestException('目标楼栋不能为空');
    }
    const source = resolveWarehouseManagerSource();
    const { tableId, viewId } = source;
    if (!tableId) {
      throw new ServiceUnavailableException('库存楼栋管理员 Base 配置缺失');
    }
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken: source.appToken,
      wikiToken: source.wikiToken,
      tableName: '库存楼栋管理员',
    });
    if (!appToken) {
      throw new ServiceUnavailableException('库存楼栋管理员 Base 配置缺失');
    }
    const records = await this.listRecords(
      appToken,
      tableId,
      await this.getTenantAccessToken(),
      '',
      viewId,
    );
    const users = new Map<string, PurchaseWorkflowUser>();
    const roleAware = records.some((record) =>
      warehouseRecordRoles(record.fields || {}).some(Boolean),
    );
    for (const record of records) {
      const fields = record.fields || {};
      const buildings = warehouseRecordBuildings(fields);
      if (
        !buildings.some(
          (candidate) => normalizeBuilding(candidate) === normalizedBuilding,
        )
      ) {
        continue;
      }
      const positions = warehouseRecordRoles(fields);
      if (roleAware && !positions.some(isWarehouseManagerRole)) continue;
      for (const fieldName of [
        '主管',
        '库房管理人',
        '库房责任人员',
        '类别号管理人员（负责人最好为1人）',
      ]) {
        for (const candidate of extractUsers(fields[fieldName])) {
          const previous = users.get(candidate.openId);
          users.set(candidate.openId, {
            openId: candidate.openId,
            name: previous?.name || candidate.name,
            positions: unique([...(previous?.positions || []), ...positions]),
            buildings: unique([...(previous?.buildings || []), ...buildings]),
          });
        }
      }
    }
    if (!users.size) {
      throw new ServiceUnavailableException(
        `${clean(building) || '目标楼栋'}未配置库存楼栋管理员`,
      );
    }
    return [...users.values()];
  }

  async resolveInboundResponsibleUsersAsApp(
    building: string,
  ): Promise<PurchaseWorkflowUser[]> {
    const normalizedBuilding = normalizeBuilding(building);
    const configured = readConfiguredCardMembers('warehouse_responsible', normalizeConfiguredBuilding(building));
    if (configured) return configured.map(person => configuredWorkflowUser(person, '库房管理', building));
    if (!normalizedBuilding) {
      throw new BadRequestException('目标楼栋不能为空');
    }
    const assignment = (await this.warehouseRecipientsAsApp()).assignments.find(
      (candidate) => candidate.building === normalizedBuilding,
    );
    if (!assignment?.responsibleUsers.length) {
      throw new InboundResponsibleUsersNotConfiguredException(building);
    }
    return assignment.responsibleUsers;
  }

  async resolveInboundManagerNotificationUsersAsApp(
    building: string,
  ): Promise<PurchaseWorkflowUser[]> {
    const normalizedBuilding = normalizeBuilding(building);
    const configured = readConfiguredCardMembers('warehouse_notify', normalizeConfiguredBuilding(building));
    if (configured) return configured.map(person => configuredWorkflowUser(person, '设施运维主管', building));
    if (!normalizedBuilding) {
      throw new BadRequestException('目标楼栋不能为空');
    }
    const assignment = (await this.warehouseRecipientsAsApp()).assignments.find(
      (candidate) => candidate.building === normalizedBuilding,
    );
    return assignment?.managerUsers || [];
  }

  async getCachedInboundCompletionRecipients(
    building: string,
  ): Promise<string[] | null> {
    const normalizedBuilding = normalizeBuilding(building);
    if (!normalizedBuilding) return null;
    const configuredResponsible = readConfiguredCardMembers('warehouse_responsible', normalizeConfiguredBuilding(building));
    const configuredNotify = readConfiguredCardMembers('warehouse_notify', normalizeConfiguredBuilding(building));
    if (configuredResponsible !== null || configuredNotify !== null) {
      const [responsible, notify] = await Promise.all([this.resolveInboundResponsibleUsersAsApp(building), this.resolveInboundManagerNotificationUsersAsApp(building)]);
      return unique([...responsible, ...notify].map(person => person.openId));
    }
    const sourceFingerprint = warehouseRecipientSourceFingerprint(
      resolveWarehouseManagerSource(),
    );
    const snapshot = await this.readWarehouseRecipientSnapshot();
    if (!isFreshWarehouseRecipientSnapshot(snapshot, sourceFingerprint)) {
      return null;
    }
    const assignment = snapshot.assignments.find(
      (candidate) => candidate.building === normalizedBuilding,
    );
    if (!assignment?.responsibleUsers.length) return null;
    return unique([
      ...assignment.responsibleUsers.map((user) => user.openId),
      ...assignment.managerUsers.map((user) => user.openId),
    ]);
  }

  async refreshWarehouseRecipientCacheIfDue(): Promise<void> {
    if (!this.warehouseRecipientCachePath()) return;
    await this.warehouseRecipientsAsApp();
  }

  private async warehouseRecipientsAsApp(): Promise<WarehouseRecipientSnapshot> {
    const source = resolveWarehouseManagerSource();
    if (!source.tableId) {
      throw new ServiceUnavailableException('库存楼栋管理员 Base 配置缺失');
    }
    const sourceFingerprint = warehouseRecipientSourceFingerprint(source);
    const cached = await this.readWarehouseRecipientSnapshot();
    if (isFreshWarehouseRecipientSnapshot(cached, sourceFingerprint)) {
      return cached;
    }
    if (this.warehouseRecipientRefreshPromise) {
      return this.warehouseRecipientRefreshPromise;
    }
    this.warehouseRecipientRefreshPromise = (async () => {
      const appToken = await resolveBitableAppToken(this.httpService, {
        appToken: source.appToken,
        wikiToken: source.wikiToken,
        tableName: '库存楼栋管理员',
      });
      if (!appToken) {
        throw new ServiceUnavailableException('库存楼栋管理员 Base 配置缺失');
      }
      const records = await this.listRecords(
        appToken,
        source.tableId,
        await this.getTenantAccessToken(),
        '',
        source.viewId,
      );
      const assignments = mapWarehouseRecipientAssignments(records);
      if (!assignments.some((entry) => entry.responsibleUsers.length)) {
        throw new InboundResponsibleUsersNotConfiguredException('目标楼栋');
      }
      const snapshot: WarehouseRecipientSnapshot = {
        version: 1,
        sourceFingerprint,
        syncedAt: new Date().toISOString(),
        assignments,
      };
      this.warehouseRecipientSnapshot = snapshot;
      this.warehouseRecipientSnapshotLoaded = true;
      try {
        await this.writeWarehouseRecipientSnapshot(snapshot);
      } catch (error) {
        this.logger.warn(`库房收件人缓存写入失败：${String(error)}`);
      }
      return snapshot;
    })();
    try {
      return await this.warehouseRecipientRefreshPromise;
    } finally {
      this.warehouseRecipientRefreshPromise = null;
    }
  }

  private warehouseRecipientCachePath(): string {
    const configured = readEnv('FEISHU_WAREHOUSE_RECIPIENT_CACHE_PATH');
    if (process.env.NODE_ENV === 'test' && !configured) return '';
    return resolve(configured || '.runtime/warehouse-recipient-cache.json');
  }

  private async readWarehouseRecipientSnapshot(): Promise<WarehouseRecipientSnapshot | null> {
    if (this.warehouseRecipientSnapshotLoaded)
      return this.warehouseRecipientSnapshot;
    if (this.warehouseRecipientLoadPromise)
      return this.warehouseRecipientLoadPromise;
    this.warehouseRecipientLoadPromise = this.loadWarehouseRecipientSnapshot();
    try {
      this.warehouseRecipientSnapshot =
        await this.warehouseRecipientLoadPromise;
      this.warehouseRecipientSnapshotLoaded = true;
      return this.warehouseRecipientSnapshot;
    } finally {
      this.warehouseRecipientLoadPromise = null;
    }
  }

  private async loadWarehouseRecipientSnapshot(): Promise<WarehouseRecipientSnapshot | null> {
    const cachePath = this.warehouseRecipientCachePath();
    if (!cachePath) return null;
    try {
      const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf8'));
      const snapshot = sanitizeWarehouseRecipientSnapshot(parsed);
      if (!snapshot) this.logger.warn('库房收件人缓存无效，将重新同步');
      return snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('库房收件人缓存无效，将重新同步');
      }
      return null;
    }
  }

  private async writeWarehouseRecipientSnapshot(
    snapshot: WarehouseRecipientSnapshot,
  ): Promise<void> {
    const cachePath = this.warehouseRecipientCachePath();
    if (!cachePath) return;
    await mkdir(dirname(cachePath), { recursive: true });
    const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, 'utf8');
      await rename(temporaryPath, cachePath);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async findComprehensivePurchaser(
    userAccessToken: string,
    scope?:Pick<PurchaseWorkflowRecord,'building'|'specialty'>,
  ): Promise<PurchaseWorkflowUser> {
    const configured=readConfiguredCardMembers('purchase_executor',scope?.building||null,scope?.specialty||undefined);
    if(configured)return configuredWorkflowUser(configured[0],COMPREHENSIVE_PURCHASE_POSITION,scope?.building);
    const config = this.config();
    const organizationTableId = requireOrganizationTableId(config);
    const records = await this.listRecords(
      config.appToken,
      organizationTableId,
      userAccessToken,
    );
    const user = records
      .flatMap(mapOrganizationRecordUsers)
      .find((candidate) => candidate.positions.includes('综合管理'));
    if (!user?.openId) throw new Error('组织架构中未配置综合管理采购人');
    return user;
  }

  async sendTextNotification(
    recipientOpenIds: string[],
    text: string,
    suppressed = false,
  ): Promise<string[]> {
    if (suppressed) return [];
    const recipients = unique(recipientOpenIds.filter(isOpenId));
    if (!recipients.length) return [];
    const token = await this.getTenantAccessToken();
    const messageIds: string[] = [];
    for (const openId of recipients) {
      const response = await this.httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
        {
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
        requestConfig(token),
      );
      assertFeishuSuccess(response.data, '发送采购工作流通知失败');
      const messageId = clean(response.data?.data?.message_id);
      if (messageId) messageIds.push(messageId);
    }
    return messageIds;
  }

  async sendIdempotentTextNotification(
    recipientOpenId: string,
    text: string,
    uuid: string,
  ): Promise<string> {
    if (!isOpenId(recipientOpenId) || typeof uuid !== 'string' || !INTERACTIVE_MESSAGE_UUID_PATTERN.test(uuid) ||
      typeof text !== 'string' || !text.trim() || text.length > 10000) {
      throw new BadRequestException('采购下单通知收件人、内容或幂等键无效');
    }
    const token = await this.getTenantAccessToken();
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      { receive_id: recipientOpenId, msg_type: 'text', content: JSON.stringify({ text }), uuid },
      requestConfig(token),
    ).catch((error: unknown) => rethrowFeishuResponseError(error, '发送采购下单通知失败'));
    assertFeishuDeliverySuccess(response.data, '发送采购下单通知失败', response.status);
    const messageId = clean(response.data?.data?.message_id);
    if (!messageId) throw new BadGatewayException('发送采购下单通知失败：响应缺少 message_id');
    return messageId;
  }

  async sendInteractiveCard(
    recipientOpenId: string,
    card: Record<string, unknown>,
    uuid?: string,
  ): Promise<string> {
    if (!isOpenId(recipientOpenId)) {
      throw new BadRequestException('飞书互动卡收件人 open_id 无效');
    }
    if (uuid !== undefined && !INTERACTIVE_MESSAGE_UUID_PATTERN.test(uuid)) {
      throw new BadRequestException('飞书互动卡消息幂等键无效');
    }
    const content = serializeInteractiveCard(card);
    const token = await this.getTenantAccessToken();
    const response = await observedCardPost(this.httpService.axiosRef, 'purchase',
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
        {
          receive_id: recipientOpenId,
          msg_type: 'interactive',
          content,
          ...(uuid === undefined ? {} : { uuid }),
        },
        requestConfig(token),
      )
      .catch((error: unknown) =>
        rethrowFeishuResponseError(error, '发送采购审批互动卡失败'),
      );
    assertFeishuDeliverySuccess(
      response.data,
      '发送采购审批互动卡失败',
      response.status,
    );
    const messageId = clean(response.data?.data?.message_id);
    if (!messageId) {
      throw new BadGatewayException(
        '发送采购审批互动卡失败：响应缺少 message_id',
      );
    }
    return messageId;
  }

  async updateInteractiveCard(
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    if (!/^om_[A-Za-z0-9_-]+$/.test(messageId)) {
      throw new BadRequestException('飞书互动卡消息标识无效');
    }
    const content = serializeInteractiveCard(card);
    const token = await this.getTenantAccessToken();
    const response = await observedCardPatch(this.httpService.axiosRef, 'purchase',
        `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`,
        { content },
        requestConfig(token),
      )
      .catch((error: unknown) =>
        rethrowFeishuResponseError(error, '更新采购审批互动卡失败'),
      );
    assertFeishuSuccess(response.data, '更新采购审批互动卡失败');
  }

  async updateInteractiveCardAfterCallback(
    updateToken: string,
    card: Record<string, unknown>,
    sourceMessageId?: string,
  ): Promise<void> {
    if (!/^c-[A-Za-z0-9_-]{1,512}$/.test(updateToken)) {
      throw new BadRequestException('飞书卡片更新票据无效');
    }
    if (
      card.schema !== '2.0' ||
      !isPlainObject(card.config) ||
      card.config.update_multi !== true
    ) {
      throw new BadRequestException('延时更新需要共享 Card JSON 2.0');
    }
    serializeInteractiveCard(card);
    const token = await this.getTenantAccessToken();
    const response = await observedCardTokenUpdate(this.httpService.axiosRef, 'purchase',
        'https://open.feishu.cn/open-apis/interactive/v1/card/update',
        { token: updateToken, card },
        requestConfig(token),
        sourceMessageId,
      )
      .catch((error: unknown) =>
        rethrowFeishuResponseError(error, '延时更新采购互动卡失败'),
      );
    assertFeishuSuccess(response.data, '延时更新采购互动卡失败');
  }

  async uploadAttachment(
    file: PurchaseWorkflowUploadFile,
    userAccessToken: string,
  ): Promise<string> {
    if (!file?.buffer?.length || file.size <= 0)
      throw new Error('上传附件内容为空');
    const appToken = this.config().appToken;
    const fileName = safeFileName(file.originalname);
    const form = new FormData();
    form.append('file_name', fileName);
    form.append('parent_type', 'bitable_file');
    form.append('parent_node', appToken);
    form.append('size', String(file.size));
    form.append('file', file.buffer, {
      filename: fileName,
      contentType: clean(file.mimetype) || 'application/octet-stream',
    });
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
      form,
      {
        headers: {
          Authorization: `Bearer ${userAccessToken}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        timeout: 60_000,
      },
    );
    assertFeishuSuccess(response.data, '上传采购工作流附件失败');
    const fileToken = clean(response.data?.data?.file_token);
    if (!fileToken)
      throw new BadGatewayException(
        '上传采购工作流附件失败：响应缺少 file_token',
      );
    return fileToken;
  }

  private async listOrganizationUsersAsApp(): Promise<PurchaseWorkflowUser[]> {
    return groupOrganizationUsers(await this.listOrganizationRecordsAsApp());
  }

  private async listOrganizationRecordsAsApp(): Promise<BitableRecordItem[]> {
    const dayKey = shanghaiDayKey();
    if (this.organizationRecords?.dayKey === dayKey) {
      return this.organizationRecords.value;
    }
    if (this.organizationRecordsPromise) {
      return this.organizationRecordsPromise;
    }
    const config = this.config();
    const organizationTableId = requireOrganizationTableId(config);
    const stale = this.organizationRecords;
    this.organizationRecordsPromise = (async () => {
      const records = await this.listRecords(
        config.appToken,
        organizationTableId,
        await this.getTenantAccessToken(),
      );
      this.organizationRecords = {
        value: records,
        dayKey: shanghaiDayKey(),
      };
      return records;
    })();
    try {
      return await this.organizationRecordsPromise;
    } catch (error) {
      if (stale?.value.length) return stale.value;
      throw error;
    } finally {
      this.organizationRecordsPromise = null;
    }
  }

  private async listRecords(
    appToken: string,
    tableId: string,
    accessToken: string,
    filter = '',
    viewId = '',
  ): Promise<BitableRecordItem[]> {
    if (!appToken || !tableId) throw new Error('采购工作流数据表配置缺失');
    const records: BitableRecordItem[] = [];
    let pageToken = '';
    let hasMore = true;
    while (hasMore) {
      const response = await this.httpService.axiosRef.get(
        recordsUrl(appToken, tableId),
        {
          ...requestConfig(accessToken),
          params: {
            page_size: 500,
            page_token: pageToken || undefined,
            filter: filter || undefined,
            view_id: viewId || undefined,
          },
        },
      );
      assertFeishuSuccess(response.data, '读取采购工作流数据失败');
      const data = response.data?.data || {};
      records.push(...(Array.isArray(data.items) ? data.items : []));
      pageToken = clean(data.page_token);
      hasMore = Boolean(data.has_more);
    }
    return records;
  }

  private async ensureManagerApprovalFields(): Promise<void> {
    const config = this.config();
    const accessToken = await this.getTenantAccessToken();
    const url = fieldsUrl(config.appToken, config.executionTableId);
    const response = await this.httpService.axiosRef.get(url, {
      ...requestConfig(accessToken),
      params: { page_size: 200 },
    });
    assertFeishuSuccess(response.data, '读取采购程序审批字段失败');
    const existing = Array.isArray(response.data?.data?.items)
      ? (response.data.data.items as Array<Record<string, unknown>>)
      : [];
    for (const definition of PURCHASE_MANAGER_APPROVAL_FIELD_DEFINITIONS) {
      const current = existing.find(
        (field) => clean(field.field_name) === definition.name,
      );
      if (current) {
        assertManagerApprovalFieldCompatible(current, definition);
        continue;
      }
      const created = await this.httpService.axiosRef.post(
        url,
        definition.payload,
        requestConfig(accessToken),
      );
      assertFeishuSuccess(
        created.data,
        `创建采购程序审批字段失败：${definition.name}`,
      );
    }
  }

  private async createRecord(
    appToken: string,
    tableId: string,
    fields: Record<string, unknown>,
    accessToken: string,
    tableName: string,
  ): Promise<string> {
    if (!appToken || !tableId) throw new Error(`${tableName}表配置缺失`);
    const response = await this.httpService.axiosRef.post(
      recordsUrl(appToken, tableId),
      { fields },
      requestConfig(accessToken),
    );
    assertFeishuSuccess(response.data, `新增${tableName}记录失败`);
    const recordId = clean(
      response.data?.data?.record?.record_id || response.data?.data?.record_id,
    );
    if (!recordId)
      throw new BadGatewayException(
        `新增${tableName}记录失败：响应缺少 record_id`,
      );
    invalidateBitableRecordCache({ appToken, tableId });
    return recordId;
  }

  private async deleteRecord(
    appToken: string,
    tableId: string,
    recordId: string,
    accessToken: string,
    tableName: string,
  ): Promise<void> {
    if (!appToken || !tableId) throw new Error(`${tableName}表配置缺失`);
    const response = await this.httpService.axiosRef.delete(
      `${recordsUrl(appToken, tableId)}/${encodeURIComponent(recordId)}`,
      requestConfig(accessToken),
    );
    assertFeishuSuccess(response.data, `删除${tableName}记录失败`);
    invalidateBitableRecordCache({ appToken, tableId });
  }

  private async batchDeleteRecords(
    appToken: string,
    tableId: string,
    recordIds: string[],
    accessToken: string,
    tableName: string,
  ): Promise<void> {
    if (!recordIds.length) return;
    if (!appToken || !tableId) throw new Error(`${tableName}表配置缺失`);
    const response = await this.httpService.axiosRef.post(
      `${recordsUrl(appToken, tableId)}/batch_delete`,
      { records: recordIds },
      requestConfig(accessToken),
    );
    assertFeishuSuccess(response.data, `批量删除${tableName}记录失败`);
    invalidateBitableRecordCache({ appToken, tableId });
  }

  private config(): PurchaseWorkflowConfig {
    const source = parseFeishuBitableLink(
      readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL'),
    );
    const appToken =
      readEnv('FEISHU_PURCHASE_INVENTORY_APP_TOKEN') || source.appToken;
    if (!appToken) throw new Error('采购工作流 Base app token 未配置');
    return {
      appToken,
      executionTableId: readEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID'),
      submissionTableId: readEnv('FEISHU_PURCHASE_SUBMISSION_TABLE_ID'),
      organizationTableId: readEnv('FEISHU_PURCHASE_ORGANIZATION_TABLE_ID'),
    };
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
        { timeout: 30_000 },
      );
      assertFeishuSuccess(response.data, '获取飞书租户令牌失败');
      const value = clean(response.data?.tenant_access_token);
      if (!value)
        throw new BadGatewayException('获取飞书租户令牌失败：响应缺少令牌');
      const seconds = Number(response.data?.expire);
      this.tenantToken = {
        value,
        expiresAt:
          Date.now() +
          (Number.isFinite(seconds) ? Math.max(60, seconds - 300) : 5400) *
            1000,
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

export function mapExecutionRecord(
  record: BitableRecordItem,
): PurchaseWorkflowRecord {
  const fields = record.fields || {};
  const requester = firstUserFromFields(fields, [
    '需求人',
    '业务申请人',
    '申请人',
  ]);
  const purchaser = firstUser(fields['采购人']);
  const signer = firstUser(fields['签收人']);
  const unifiedReceiptAttachment = fieldValueByPrefix(fields, '签收附件');
  const comparisonSatisfied = text(fields, ['是否满足三家比价（线下）']);
  return {
    recordId: getRecordId(record),
    specialty: text(fields, ['专业']),
    requestCode: text(fields, ['采购编码']),
    status: workflowStatus(fields),
    itemName: text(fields, ['物品名称', '名称']),
    specification: text(fields, [
      '物品规格型号、设备序列号',
      '规格型号、设备序列号',
      '规格型号',
    ]),
    sku: text(fields, ['物品类别码', '物品类别号']),
    location: text(fields, ['入库存放位置', '存放位置']),
    building: text(fields, [
      '申请楼栋',
      '申请楼栋（多楼请选E楼，备注里填写详情）',
      '申请楼栋（多楼请选H楼，备注里填写详情）',
    ]),
    requesterOpenId: requester.openId,
    requesterName: requester.name,
    purchaserOpenId: purchaser.openId,
    purchaserName: purchaser.name,
    purchaseMethod: text(fields, [
      '1️⃣物品采购方式',
    ]) as PurchaseWorkflowRecord['purchaseMethod'],
    procurementForm:
      comparisonSatisfied === '是'
        ? '三方比价'
        : comparisonSatisfied === '否'
          ? '单一采购'
          : undefined,
    singleReason: freeText(fields, ['单一原因']),
    purchaseLinks: purchaseLinks(fields),
    rejectionReason: rawFreeText(fields, ['驳回原因']),
    requestedQuantity: number(fields, ['申请数量', '采购申请数量']) || 0,
    unit: text(fields, ['计数单位']),
    unitPrice: number(fields, ['单价']),
    createdAt: dateNumber(record.created_time),
    actualQuantity: number(fields, ['实际采购数量']),
    actualAmount: number(fields, ['实际付款金额']),
    paymentAttachmentTokens: attachmentTokens(
      fields['付款截屏（显示付款金额）'],
    ),
    amountDifference: number(fields, ['金额差异（负数为多补）', '金额差异']),
    quantityDifference: number(fields, ['数量差异']),
    approvalCompleted: checked(fields['2️⃣审批已完成（无需点击）']),
    warehouseConfirmed: checked(fields['库房确认']),
    purchaseCompleted: checked(fields['采购完成']),
    receiptConfirmed: checked(
      fields['到货签收确认（签收内容填写完成后点击）'] ||
        fields['到货签收确认'],
    ),
    signer: signer.name || text(fields, ['签收人']),
    signerOpenId: signer.openId,
    receiptTime: dateNumber(fields['签收时间']),
    receiptPhotoTokens: unifiedReceiptAttachment.found
      ? attachmentTokens(unifiedReceiptAttachment.value)
      : attachmentTokens(fields['签收照片']),
    invoiceTokens: unifiedReceiptAttachment.found
      ? []
      : attachmentTokens(
          fields['发票附件（自采必填项，非自采无需填写）'] ||
            fields['发票附件'],
        ),
    supplier: text(fields, ['供应商', '采购供应商']),
    requirementSummary: text(fields, [
      '需求简述（采购原因、目的等）',
      '需求简述',
      '申请原因及用途',
    ]),
    expectedDeliveryDate: dateNumber(fields['期望交付时间']),
    note: text(fields, ['采购备注', '其他备注']),
    approvalSource: text(fields, [PURCHASE_MANAGER_APPROVAL_FIELDS.source]),
    approvalWorkflowStatus: text(fields, [
      PURCHASE_MANAGER_APPROVAL_FIELDS.state,
    ]),
    approvalPolicyVersion: text(fields, [
      PURCHASE_MANAGER_APPROVAL_FIELDS.policyVersion,
    ]),
    approvalBatchId: text(fields, [PURCHASE_MANAGER_APPROVAL_FIELDS.batchId]),
    approvalActionId: text(fields, [PURCHASE_MANAGER_APPROVAL_FIELDS.actionId]),
    approvalWorkflowError: rawFreeText(fields, [
      PURCHASE_MANAGER_APPROVAL_FIELDS.error,
    ]),
    approvalCardDeliveryStatus: text(fields, [
      PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryState,
    ]),
    approvalCardDeliveredAt: dateNumber(
      fields[PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryTime],
    ),
    approvalCardMessageId: text(fields, [
      PURCHASE_MANAGER_APPROVAL_FIELDS.messageId,
    ]),
    approvalCardDeliveryUuid: text(fields, [
      PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryUuid,
    ]),
    approvalCardDeliveryAttempts:
      number(fields, [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryAttempts]) || 0,
    approvalCardLastAttemptAt: dateNumber(
      fields[PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryLastAttemptAt],
    ),
    receiptCardDeliveryStatus: text(fields, [
      PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryState,
    ]),
    receiptCardBatchId: text(fields, [
      PURCHASE_MANAGER_APPROVAL_FIELDS.receiptBatchId,
    ]),
    receiptCardDeliveredAt: dateNumber(
      fields[PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryTime],
    ),
    receiptCardMessageId: text(fields, [
      PURCHASE_MANAGER_APPROVAL_FIELDS.receiptMessageId,
    ]),
    receiptCardDeliveryUuid: text(fields, [
      PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryUuid,
    ]),
    receiptCardDeliveryAttempts:
      number(fields, [
        PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryAttempts,
      ]) || 0,
    receiptCardLastAttemptAt: dateNumber(
      fields[PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryLastAttemptAt],
    ),
    receiptCardDeliveryError: rawFreeText(fields, [
      PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryError,
    ]),
  };
}

function fieldValueByPrefix(
  fields: Record<string, unknown>,
  prefix: string,
): { found: boolean; value: unknown } {
  const matches = Object.keys(fields)
    .filter((name) => clean(name).startsWith(prefix))
    .sort((left, right) => {
      if (left === prefix) return -1;
      if (right === prefix) return 1;
      return left.localeCompare(right, 'zh-CN');
    });
  const fieldName = matches[0];
  return fieldName
    ? { found: true, value: fields[fieldName] }
    : { found: false, value: undefined };
}

function workflowStatus(fields: Record<string, unknown>): string {
  const purchaseStatus = text(fields, ['采购流程']);
  const programStatus = text(fields, ['程序采购状态']);
  const completedStatus = [programStatus, purchaseStatus].find((status) =>
    ['采购完成（已入库）', '物品签收已入库'].includes(status),
  );
  if (checked(fields['是否已入库']) || completedStatus) {
    return completedStatus || '采购完成（已入库）';
  }
  return purchaseStatus || programStatus;
}

function resolveWarehouseManagerSource(): {
  appToken: string;
  wikiToken: string;
  tableId: string;
  viewId: string;
} {
  const managerSourceUrl = readEnv('FEISHU_WAREHOUSE_MANAGER_SOURCE_URL');
  const managerSource = parseFeishuBitableLink(managerSourceUrl);
  const managerAppToken =
    readEnv('FEISHU_WAREHOUSE_MANAGER_APP_TOKEN') || managerSource.appToken;
  const managerWikiToken =
    readEnv('FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN') || managerSource.wikiToken;
  const usesDedicatedManagerSource = Boolean(
    managerSourceUrl || managerAppToken || managerWikiToken,
  );
  const warehouseSource = parseFeishuBitableLink(
    readEnv('FEISHU_WAREHOUSE_SOURCE_URL'),
  );
  const tableId =
    readEnv('FEISHU_WAREHOUSE_MANAGER_TABLE_ID') || managerSource.tableId;
  return {
    appToken: usesDedicatedManagerSource
      ? managerAppToken
      : readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || warehouseSource.appToken,
    wikiToken: usesDedicatedManagerSource
      ? managerWikiToken
      : warehouseSource.wikiToken,
    tableId,
    viewId:
      readEnv('FEISHU_WAREHOUSE_MANAGER_VIEW_ID') ||
      managerSource.viewId ||
      (tableId === 'tblWg8gr341c0HzF' ? 'vew0gRV4Jr' : ''),
  };
}

function normalizeConfiguredBuilding(value: string): string {
  const normalized = normalizeBuilding(value);
  return normalized ? `${normalized}楼` : value;
}
function configuredWorkflowUser(person: { openId: string; name: string }, position: string, building?: string): PurchaseWorkflowUser {
  return { ...person, positions: [position], buildings: building ? [building] : [] };
}

function mapOrganizationRecordUsers(
  record: BitableRecordItem,
): PurchaseWorkflowUser[] {
  const fields = record.fields || {};
  const people = ['主管', '人员', '姓名']
    .map((fieldName) => extractUsers(fields[fieldName]))
    .find((users) => users.length);
  const fallbackName = text(fields, ['主管（文本）', '姓名']);
  const positions = extractDisplayValues(fields['职位']);
  const buildings = extractDisplayValues(fields['楼栋/专业']);
  return (people || []).map((user) => ({
    openId: user.openId,
    name: user.name || (people?.length === 1 ? fallbackName : ''),
    positions,
    buildings,
  }));
}

function groupOrganizationUsers(
  records: BitableRecordItem[],
): PurchaseWorkflowUser[] {
  const users = new Map<string, PurchaseWorkflowUser>();
  for (const record of records) {
    for (const current of mapOrganizationRecordUsers(record)) {
      if (!current.openId) continue;
      const previous = users.get(current.openId);
      users.set(current.openId, {
        openId: current.openId,
        name: previous?.name || current.name,
        positions: unique([
          ...(previous?.positions || []),
          ...current.positions,
        ]),
        buildings: unique([
          ...(previous?.buildings || []),
          ...current.buildings,
        ]),
      });
    }
  }
  return [...users.values()];
}

function firstUser(value: unknown): { openId: string; name: string } {
  const stack: unknown[] = [value];
  const visited = new WeakSet<object>();
  const users = new Map<string, string>();
  while (stack.length) {
    const current = stack.shift();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      stack.unshift(...current);
      continue;
    }
    const item = current as Record<string, unknown>;
    const openId = clean(item.id || item.open_id || item.openId);
    if (isOpenId(openId)) {
      if (!users.has(openId)) {
        users.set(openId, clean(item.name || item.text));
      }
    }
    stack.unshift(...Object.values(item));
  }
  if (users.size > 1) {
    throw new ConflictException('采购人员字段包含多个不同人员');
  }
  const selected = [...users.entries()][0];
  return selected
    ? { openId: selected[0], name: selected[1] }
    : { openId: '', name: '' };
}

function firstUserFromFields(
  fields: Record<string, unknown>,
  names: readonly string[],
): { openId: string; name: string } {
  let selected = { openId: '', name: '' };
  for (const name of names) {
    const current = firstUser(fields[name]);
    if (!current.openId) continue;
    if (selected.openId && selected.openId !== current.openId) {
      throw new ConflictException(`采购申请人字段冲突：${names.join('、')}`);
    }
    if (!selected.openId) selected = current;
  }
  return selected;
}

function text(fields: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = extractDisplayText(fields[name]);
    if (value) return value;
  }
  return '';
}

function freeText(fields: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = extractFreeText(fields[name], new Set<object>());
    if (value) return value;
  }
  return '';
}

function rawFreeText(fields: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(fields, name)) continue;
    return extractRawFreeText(fields[name], new Set<object>());
  }
  return '';
}

function extractFreeText(value: unknown, seen: Set<object>): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => extractFreeText(item, seen))
      .join('')
      .trim();
  }
  const item = value as Record<string, unknown>;
  for (const key of ['text', 'value', 'name', 'label', 'title']) {
    const result = extractFreeText(item[key], seen);
    if (result) return result;
  }
  return '';
}

function extractRawFreeText(value: unknown, seen: Set<object>): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => extractRawFreeText(item, seen)).join('');
  }
  const item = value as Record<string, unknown>;
  for (const key of ['text', 'value', 'name', 'label', 'title']) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    return extractRawFreeText(item[key], seen);
  }
  return '';
}

function number(
  fields: Record<string, unknown>,
  names: string[],
): number | null {
  for (const name of names) {
    const value = extractNumberValue(fields[name]);
    if (value !== null) return value;
  }
  return null;
}

function checked(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const normalized = extractDisplayText(value).toLowerCase();
  return normalized === 'true' || normalized === '是' || normalized === '1';
}

function dateNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(extractDisplayText(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function attachmentTokens(value: unknown): string[] {
  const stack: unknown[] = [value];
  const tokens: string[] = [];
  while (stack.length) {
    const current = stack.shift();
    if (Array.isArray(current)) {
      stack.unshift(...current);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    const item = current as Record<string, unknown>;
    const token = clean(item.file_token || item.token);
    if (token) tokens.push(token);
    stack.unshift(...Object.values(item));
  }
  return unique(tokens);
}

function purchaseLinks(fields: Record<string, unknown>): string[] {
  const values = [
    fields['线上链接（仅线上需填写）'],
    fields['线上链接2'],
    fields['线上链接3'],
  ];
  const links: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const candidate of purchaseLinkCandidates(value)) {
      const normalized = candidate.trim();
      if (
        !/^https:\/\//iu.test(normalized) ||
        normalized.length > 600 ||
        seen.has(normalized)
      ) {
        continue;
      }
      seen.add(normalized);
      links.push(normalized);
      if (links.length === 3) return links;
    }
  }
  return links;
}

function purchaseLinkCandidates(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(purchaseLinkCandidates);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return ['link', 'url', 'href', 'value', 'text'].flatMap((key) =>
    purchaseLinkCandidates(record[key]),
  );
}

function recordsUrl(appToken: string, tableId: string): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;
}

function fieldsUrl(appToken: string, tableId: string): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`;
}

function assertManagerApprovalFieldCompatible(
  field: Record<string, unknown>,
  definition: PurchaseManagerApprovalFieldDefinition,
): void {
  const type = Number(field.type);
  const property = isPlainObject(field.property) ? field.property : {};
  const multiple = Boolean(field.multiple ?? property.multiple ?? false);
  if (
    type !== definition.type ||
    (definition.multiple !== undefined && multiple !== definition.multiple)
  ) {
    throw new ConflictException(
      `采购程序审批字段类型不匹配：${definition.name}`,
    );
  }
}

function requestConfig(
  accessToken: string,
  timeout = 30_000,
): {
  headers: { Authorization: string };
  timeout: number;
} {
  if (!accessToken) throw new Error('飞书访问令牌缺失');
  return {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout,
  };
}

function assertFeishuSuccess(payload: unknown, prefix: string): void {
  if (!isPlainObject(payload) || payload.code !== 0) {
    const error = new BadGatewayException(
      `${prefix}：${feishuFailureDetail(payload)}`,
    );
    const feishuCode = isPlainObject(payload)
      ? Number(payload.code)
      : Number.NaN;
    if (Number.isSafeInteger(feishuCode) && feishuCode !== 0) {
      Object.defineProperty(error, 'feishuCode', {
        value: feishuCode,
        enumerable: true,
      });
    }
    throw error;
  }
}

function assertFeishuDeliverySuccess(
  payload: unknown,
  prefix: string,
  httpStatus: unknown,
): void {
  try {
    assertFeishuSuccess(payload, prefix);
  } catch (error) {
    throw annotateDefinitiveFeishuDeliveryRejection(error, httpStatus);
  }
}

function annotateDefinitiveFeishuDeliveryRejection(
  error: unknown,
  httpStatus: unknown,
): never {
  if (error && typeof error === 'object') {
    const normalizedStatus = Number(httpStatus);
    if (Number.isInteger(normalizedStatus)) {
      Object.defineProperty(error, 'httpStatus', {
        value: normalizedStatus,
        enumerable: true,
      });
    }
    Object.defineProperty(error, 'deliveryOutcome', {
      value: 'rejected',
      enumerable: true,
    });
  }
  throw error;
}

function rethrowFeishuResponseError(error: unknown, prefix: string): never {
  const response =
    error && typeof error === 'object'
      ? (error as { response?: unknown }).response
      : undefined;
  if (!isPlainObject(response) || !isPlainObject(response.data)) {
    throw error;
  }
  const feishuCode = Number(response.data.code);
  if (!Number.isSafeInteger(feishuCode) || feishuCode === 0) {
    throw error;
  }
  try {
    assertFeishuSuccess(response.data, prefix);
  } catch (normalized) {
    throw annotateDefinitiveFeishuDeliveryRejection(
      normalized,
      response.status,
    );
  }
  throw error;
}

async function retryTransientExecutionRecordRead<T extends { data?: unknown }>(
  operation: (timeout: number) => Promise<T>,
  totalTimeoutMs = EXECUTION_RECORD_READ_TOTAL_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + totalTimeoutMs;
  let retryIndex = 0;
  let attempted = false;
  let lastResponse: T | undefined;
  let lastFailure: unknown;

  while (!attempted || Date.now() < deadline) {
    attempted = true;
    const remainingBeforeRequest = Math.max(1, deadline - Date.now());
    try {
      const response = await operation(
        Math.min(totalTimeoutMs, remainingBeforeRequest),
      );
      if (!isTransientExecutionRecordReadPayload(response.data)) {
        return response;
      }
      lastResponse = response;
      lastFailure = undefined;
    } catch (error) {
      if (!isTransientExecutionRecordReadError(error)) throw error;
      lastFailure = error;
      lastResponse = undefined;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const retryDelay = Math.min(
      EXECUTION_RECORD_READ_RETRY_DELAYS_MS[
        Math.min(retryIndex, EXECUTION_RECORD_READ_RETRY_DELAYS_MS.length - 1)
      ],
      remaining,
    );
    retryIndex += 1;
    await delay(retryDelay);
  }

  if (lastResponse) return lastResponse;
  throw normalizeExecutionRecordReadFailure(lastFailure);
}

function isTransientExecutionRecordReadPayload(payload: unknown): boolean {
  return (
    isPlainObject(payload) &&
    TRANSIENT_EXECUTION_RECORD_READ_FEISHU_CODES.has(Number(payload.code))
  );
}

function isTransientExecutionRecordReadError(error: unknown): boolean {
  const responsePayload = (error as { response?: { data?: unknown } } | null)
    ?.response?.data;
  if (isTransientExecutionRecordReadPayload(responsePayload)) return true;
  const responseStatus = executionRecordReadHttpStatus(error);
  if (
    responseStatus === 429 ||
    (responseStatus >= 500 && responseStatus <= 599)
  ) {
    return true;
  }
  const networkCode = clean(
    (error as { code?: unknown } | null)?.code,
  ).toUpperCase();
  return TRANSIENT_EXECUTION_RECORD_READ_NETWORK_CODES.has(networkCode);
}

function normalizeExecutionRecordReadFailure(
  error: unknown,
): BadGatewayException {
  const responsePayload = (error as { response?: { data?: unknown } } | null)
    ?.response?.data;
  if (isTransientExecutionRecordReadPayload(responsePayload)) {
    return new BadGatewayException(
      `读取采购执行记录失败：${feishuFailureDetail(responsePayload)}`,
    );
  }
  const responseStatus = executionRecordReadHttpStatus(error);
  if (responseStatus) {
    return new BadGatewayException(
      `读取采购执行记录失败：上游 HTTP ${responseStatus}`,
    );
  }
  const networkCode = clean(
    (error as { code?: unknown } | null)?.code,
  ).toUpperCase();
  return new BadGatewayException(
    networkCode
      ? `读取采购执行记录失败：网络异常（${networkCode}）`
      : '读取采购执行记录失败：瞬时错误重试已超时',
  );
}

function executionRecordReadHttpStatus(error: unknown): number {
  const status = Number(
    (error as { response?: { status?: unknown } } | null)?.response?.status,
  );
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : 0;
}

function feishuFailureDetail(payload: unknown): string {
  if (!isPlainObject(payload)) return '响应缺少有效 code';
  const message = clean(payload.msg);
  const rawCode = payload.code;
  const code =
    typeof rawCode === 'number' || typeof rawCode === 'string'
      ? clean(String(rawCode))
      : '';
  if (message && code) return `${message}（错误码 ${code}）`;
  if (message) return message;
  return code ? `错误码 ${code}` : '响应缺少有效 code';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isOpenId(value: string): boolean {
  return /^ou_[A-Za-z0-9_-]+$/.test(value);
}

function normalizeBuilding(value: unknown): string {
  return clean(value)
    .normalize('NFC')
    .replace(/[楼栋]$/u, '')
    .toUpperCase();
}

function warehouseRecordBuildings(fields: Record<string, unknown>): string[] {
  for (const fieldName of ['楼栋', '楼栋/专业', '机楼']) {
    const values = unique(extractDisplayValues(fields[fieldName]).map(clean));
    if (values.length) return values;
  }
  return [];
}

function warehouseRecipientSourceFingerprint(
  source: ReturnType<typeof resolveWarehouseManagerSource>,
): string {
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

function mapWarehouseRecipientAssignments(
  records: BitableRecordItem[],
): WarehouseRecipientAssignment[] {
  const assignments = new Map<
    string,
    {
      responsibleUsers: Map<string, PurchaseWorkflowUser>;
      managerUsers: Map<string, PurchaseWorkflowUser>;
    }
  >();
  for (const record of records) {
    const fields = record.fields || {};
    const buildings = warehouseRecordBuildings(fields);
    for (const building of buildings) {
      const key = normalizeBuilding(building);
      if (!key) continue;
      const assignment = assignments.get(key) || {
        responsibleUsers: new Map<string, PurchaseWorkflowUser>(),
        managerUsers: new Map<string, PurchaseWorkflowUser>(),
      };
      assignments.set(key, assignment);
      for (const [fieldName, users] of [
        ['库房责任人员', assignment.responsibleUsers],
        ['库房管理人', assignment.managerUsers],
      ] as const) {
        for (const candidate of extractUsers(fields[fieldName])) {
          const previous = users.get(candidate.openId);
          users.set(candidate.openId, {
            openId: candidate.openId,
            name: previous?.name || candidate.name,
            positions: [],
            buildings: unique([...(previous?.buildings || []), ...buildings]),
          });
        }
      }
    }
  }
  return [...assignments].map(([building, assignment]) => ({
    building,
    responsibleUsers: [...assignment.responsibleUsers.values()],
    managerUsers: [...assignment.managerUsers.values()],
  }));
}

function sanitizeWarehouseRecipientSnapshot(
  value: unknown,
): WarehouseRecipientSnapshot | null {
  if (
    !isPlainObject(value) ||
    value.version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(clean(value.sourceFingerprint)) ||
    !Number.isFinite(Date.parse(clean(value.syncedAt))) ||
    !Array.isArray(value.assignments) ||
    value.assignments.length > 20
  ) {
    return null;
  }
  const assignments: WarehouseRecipientAssignment[] = [];
  const seen = new Set<string>();
  for (const candidate of value.assignments) {
    if (!isPlainObject(candidate)) return null;
    const building = normalizeBuilding(candidate.building);
    if (
      !building ||
      seen.has(building) ||
      !Array.isArray(candidate.responsibleUsers) ||
      !Array.isArray(candidate.managerUsers) ||
      candidate.responsibleUsers.length > 50 ||
      candidate.managerUsers.length > 50
    ) {
      return null;
    }
    const responsibleUsers = candidate.responsibleUsers.map(
      sanitizeWarehouseRecipientUser,
    );
    const managerUsers = candidate.managerUsers.map(
      sanitizeWarehouseRecipientUser,
    );
    if (responsibleUsers.includes(null) || managerUsers.includes(null))
      return null;
    seen.add(building);
    assignments.push({
      building,
      responsibleUsers: responsibleUsers as PurchaseWorkflowUser[],
      managerUsers: managerUsers as PurchaseWorkflowUser[],
    });
  }
  if (!assignments.some((entry) => entry.responsibleUsers.length)) return null;
  return {
    version: 1,
    sourceFingerprint: clean(value.sourceFingerprint),
    syncedAt: clean(value.syncedAt),
    assignments,
  };
}

function sanitizeWarehouseRecipientUser(
  value: unknown,
): PurchaseWorkflowUser | null {
  if (!isPlainObject(value) || !isOpenId(clean(value.openId))) return null;
  return {
    openId: clean(value.openId),
    name: clean(value.name),
    positions: [],
    buildings: Array.isArray(value.buildings)
      ? unique(value.buildings.map(clean))
      : [],
  };
}

function isFreshWarehouseRecipientSnapshot(
  snapshot: WarehouseRecipientSnapshot | null,
  sourceFingerprint: string,
): snapshot is WarehouseRecipientSnapshot {
  if (!snapshot || snapshot.sourceFingerprint !== sourceFingerprint)
    return false;
  const age = Date.now() - Date.parse(snapshot.syncedAt);
  return age >= -5 * 60 * 1_000 && age < WAREHOUSE_RECIPIENT_SYNC_INTERVAL_MS;
}

function warehouseRecordRoles(fields: Record<string, unknown>): string[] {
  for (const fieldName of ['职位', '角色', '仓管角色']) {
    const values = unique(extractDisplayValues(fields[fieldName]).map(clean));
    if (values.length) return values;
  }
  return [];
}

function isWarehouseManagerRole(value: string): boolean {
  return /(仓管|库存|库房)/u.test(clean(value));
}

function extractUsers(value: unknown): Array<{ openId: string; name: string }> {
  const stack: unknown[] = [value];
  const users = new Map<string, { openId: string; name: string }>();
  const visited = new WeakSet<object>();
  while (stack.length) {
    const current = stack.shift();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      stack.unshift(...current);
      continue;
    }
    const item = current as Record<string, unknown>;
    const openId = clean(item.id || item.open_id || item.openId);
    if (isOpenId(openId)) {
      const previous = users.get(openId);
      users.set(openId, {
        openId,
        name: previous?.name || clean(item.name || item.text),
      });
    }
    stack.unshift(...Object.values(item));
  }
  return [...users.values()];
}

function looksLikeNotFound(message: string): boolean {
  return /not\s*found|does\s*not\s*exist|不存在|未找到|记录已删除/i.test(
    message,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error || '飞书请求失败');
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function shanghaiDayKey(timestamp = Date.now()): string {
  return new Date(timestamp + SHANGHAI_UTC_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

function safeFileName(value: string): string {
  const name = basename(clean(value)).replace(
    /[\u0000-\u001f<>:"/\\|?*]+/g,
    '_',
  );
  return name.slice(0, 180) || 'attachment';
}

function imageExtension(mimetype: string): string {
  if (mimetype === 'image/png') return 'png';
  if (mimetype === 'image/gif') return 'gif';
  if (mimetype === 'image/webp') return 'webp';
  if (mimetype === 'image/heic') return 'heic';
  return 'jpg';
}

function requireOrganizationTableId(config: PurchaseWorkflowConfig): string {
  if (!config.organizationTableId) {
    throw new ServiceUnavailableException('采购组织架构表配置缺失');
  }
  return config.organizationTableId;
}

export function serializeInteractiveCard(card: Record<string, unknown>): string {
  if (!isPlainObject(card)) {
    throw new BadRequestException('飞书互动卡内容必须是纯对象');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(card);
  } catch {
    throw new BadRequestException('飞书互动卡内容无法序列化');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new BadRequestException('飞书互动卡内容无法序列化');
  }
  if (!isPlainObject(parsed)) {
    throw new BadRequestException('飞书互动卡内容必须是纯对象');
  }
  if (Buffer.byteLength(serialized, 'utf8') > INTERACTIVE_CARD_MAX_BYTES) {
    throw new BadRequestException('飞书互动卡内容不能超过 30KB');
  }
  return serialized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
