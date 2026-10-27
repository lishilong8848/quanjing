import { HttpService } from '@nestjs/axios';
import { readEmployeeOnboardingConfig } from '../bitable-sync/employee-onboarding.config';
import { BadGatewayException, Injectable } from '@nestjs/common';
import FormData = require('form-data');
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  fetchBitableRecords,
  getTenantAccessToken,
  invalidateBitableRecordCache,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import type {
  RawBitableField,
  RawBitableRecord,
  SystemMonthlyReportSourceInput,
} from './system-monthly-report.mapper';
import type { SystemMonthlyReportStagedFile } from './system-monthly-report-task.store';
import {
  buildFeishuDirectDownloadUrl,
  extractFeishuTmpDownloadUrl,
} from '../duty-schedule/construction-attachment-download';

const APP_TOKEN =
  process.env.SYSTEM_MONTHLY_REPORT_APP_TOKEN || 'FahubImpmaXWVGsRIYocZrHYnNc';

export const SYSTEM_MONTHLY_REPORT_SINGLE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const SYSTEM_MONTHLY_REPORT_UPLOAD_PART_INTERVAL_MS = 210;

export interface SystemMonthlyReportUploadPart {
  seq: number;
  start: number;
  end: number;
  size: number;
}

export function buildSystemMonthlyReportClientToken(value: string): string {
  const bytes = createHash('sha256')
    .update(`system-monthly-report-client-token\u001f${value}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const TABLES = {
  current: {
    id:
      process.env.SYSTEM_MONTHLY_REPORT_CURRENT_TABLE_ID || 'tblAPu5QzTfgzveu',
    name: '华东1部分机房月报（每月重置）',
  },
  collection: {
    id:
      process.env.SYSTEM_MONTHLY_REPORT_COLLECTION_TABLE_ID ||
      'tblLIBwoSBUiXxES',
    name: '华东1部分机房月报收集表',
  },
  schedule: {
    id:
      process.env.SYSTEM_MONTHLY_REPORT_SCHEDULE_TABLE_ID || 'tbljuVHHAnB633E8',
    name: '月报审核排班表（一维）',
  },
  personnel: {
    id:
      process.env.SYSTEM_MONTHLY_REPORT_PERSONNEL_TABLE_ID ||
      'tblxyWYcjC34qbyB',
    name: '人员矩阵',
  },
  standard: {
    id:
      process.env.SYSTEM_MONTHLY_REPORT_STANDARD_TABLE_ID || 'tbl24eruZB6URBFp',
    name: '月报审核标准及要求',
  },
} as const;

const CURRENT_FIELDS = [
  '月报编码',
  '机房',
  '可提报人员',
  '十夫长',
  '月报月份',
  '月报提醒日期',
  '初版提交日期',
  '初审人员',
  '初版月报提交的最新时间',
  '初审意见提交的最新时间',
  '初审问题统计',
  '复核需求提交日期',
  '二次复核人员',
  '复审月报提交最新日期',
  '复审意见提交最新日期',
  '复审问题统计',
  '最终版提交日期',
  '最终月报提交最新日期',
] as const;

const COLLECTION_FIELDS = [
  '机房',
  '月报月份',
  '创建时间',
  '初版月报',
  '复审月报',
  '终版月报',
  '初审确认提交',
  '初审审核',
  '复审确认提交',
  '初审意见',
  '复审意见',
  '初审问题截图',
  '复审问题截图',
  '提交人',
  '初审：事件模块',
  '初审：变更模块',
  '初审：维护模块',
  '初审：演练模块',
  '初审：其他问题项',
  '复审：事件模块',
  '复审：变更模块',
  '复审：维护模块',
  '复审：演练模块',
  '复审：其他问题项',
] as const;

export const SYSTEM_MONTHLY_REPORT_MAX_FINAL_ATTACHMENT_BYTES =
  256 * 1024 * 1024;
export const SYSTEM_MONTHLY_REPORT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 300_000;

const SCHEDULE_FIELDS = [
  '审核年份',
  '审核人',
  '所属机房',
  '审核月份',
  '审核轮次',
  '审核人所属机房',
  '审核机房',
] as const;

const PERSONNEL_FIELDS = ['机房', '负责人', '十夫长'] as const;

const STANDARD_FIELDS = [
  '板块',
  '占比',
  '评分细则',
  '区域补充评分细则',
] as const;

export class SystemMonthlyReportIndeterminateWriteError extends Error {
  constructor(
    readonly clientToken: string,
    cause: unknown,
  ) {
    super(
      `飞书写入结果暂时无法确认：${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'SystemMonthlyReportIndeterminateWriteError';
  }
}

@Injectable()
export class SystemMonthlyReportGateway {
  async loadLoginPersonnel() {
    const source = readEmployeeOnboardingConfig();
    const appToken = await resolveBitableAppToken(this.httpService, source);
    const records = await fetchBitableRecords(this.httpService, {
      appToken, tableId: source.tableId, tableName: source.tableName,
      fieldNames: ['姓名', '员工姓名', '离职/异动情况'], cacheTtlMs: 5 * 60_000,
      strict: true, allowStale: false,
    });
    return { appId: process.env.FEISHU_APP_ID?.trim() || '', appToken, tableId: source.tableId,
      records: records.filter(record => record.fields?.['离职/异动情况'] !== true) };
  }
  private readonly fieldCache = new Map<
    string,
    { expiresAt: number; fields: RawBitableField[] }
  >();

  constructor(private readonly httpService: HttpService) {}

  async loadSources(
    forceRefresh: boolean,
  ): Promise<Omit<SystemMonthlyReportSourceInput, 'now'>> {
    const [
      currentRecords,
      collectionRecords,
      scheduleRecords,
      personnelRecords,
      standardRecords,
      currentFields,
      scheduleFields,
    ] = await Promise.all([
      this.listRecords('current', CURRENT_FIELDS, forceRefresh),
      this.listRecords('collection', COLLECTION_FIELDS, forceRefresh),
      this.listRecords('schedule', SCHEDULE_FIELDS, forceRefresh),
      this.listRecords('personnel', PERSONNEL_FIELDS, forceRefresh),
      this.listRecords('standard', STANDARD_FIELDS, forceRefresh),
      this.listFields('current', forceRefresh),
      this.listFields('schedule', forceRefresh),
    ]);
    const sourceTimestamp = [
      ...currentRecords,
      ...collectionRecords,
      ...scheduleRecords,
      ...personnelRecords,
      ...standardRecords,
    ]
      .map((record) => Number(record.last_modified_time || 0))
      .filter(Number.isFinite)
      .sort((left, right) => right - left)[0];

    return {
      currentRecords: currentRecords as RawBitableRecord[],
      collectionRecords: collectionRecords as RawBitableRecord[],
      scheduleRecords: scheduleRecords as RawBitableRecord[],
      personnelRecords: personnelRecords as RawBitableRecord[],
      standardRecords: standardRecords as RawBitableRecord[],
      currentFields,
      scheduleFields,
      sourceUpdatedAt: sourceTimestamp
        ? new Date(normalizeTimestamp(sourceTimestamp)).toISOString()
        : new Date().toISOString(),
      stale: false,
    };
  }

  async uploadFile(file: SystemMonthlyReportStagedFile): Promise<string> {
    try {
      const [token, buffer] = await Promise.all([
        getTenantAccessToken(this.httpService),
        readFile(file.path),
      ]);
      if (!buffer.length || buffer.length !== file.size) {
        throw new BadGatewayException(`待上传文件已损坏：${file.originalName}`);
      }
      return buffer.length <= SYSTEM_MONTHLY_REPORT_SINGLE_UPLOAD_MAX_BYTES
        ? this.uploadFileInOneRequest(token, file, buffer)
        : this.uploadFileInParts(token, file, buffer);
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException(
        `上传体系月报附件失败：${describeSystemMonthlyReportFeishuError(error)}`,
      );
    }
  }

  private async uploadFileInOneRequest(
    token: string,
    file: SystemMonthlyReportStagedFile,
    buffer: Buffer,
  ): Promise<string> {
    const form = new FormData();
    form.append('file_name', safeFileName(file.originalName));
    form.append('parent_type', 'bitable_file');
    form.append('parent_node', APP_TOKEN);
    form.append('size', String(buffer.length));
    form.append('file', buffer, {
      filename: safeFileName(file.originalName),
      contentType: file.mimeType || 'application/octet-stream',
    });
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
      form,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        timeout: 60_000,
      },
    );
    assertFeishuSuccess(response.data, '上传体系月报附件失败');
    const fileToken = clean(
      response.data?.data?.file_token || response.data?.data?.media_token,
    );
    if (!fileToken) {
      throw new BadGatewayException(
        '上传体系月报附件失败：响应缺少 file_token',
      );
    }
    return fileToken;
  }

  private async uploadFileInParts(
    token: string,
    file: SystemMonthlyReportStagedFile,
    buffer: Buffer,
  ): Promise<string> {
    const fileName = safeFileName(file.originalName);
    const prepareResponse = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/drive/v1/medias/upload_prepare',
      {
        file_name: fileName,
        parent_type: 'bitable_file',
        parent_node: APP_TOKEN,
        size: buffer.length,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60_000,
      },
    );
    assertFeishuSuccess(prepareResponse.data, '准备分片上传体系月报附件失败');
    const uploadId = clean(prepareResponse.data?.data?.upload_id);
    const blockSize = Number(prepareResponse.data?.data?.block_size);
    const blockNum = Number(prepareResponse.data?.data?.block_num);
    if (!uploadId) {
      throw new BadGatewayException(
        '准备分片上传体系月报附件失败：响应缺少 upload_id',
      );
    }
    const parts = buildSystemMonthlyReportUploadParts(
      buffer.length,
      blockSize,
      blockNum,
    );

    for (const part of parts) {
      if (part.seq > 0) {
        await delay(SYSTEM_MONTHLY_REPORT_UPLOAD_PART_INTERVAL_MS);
      }
      const form = new FormData();
      form.append('upload_id', uploadId);
      form.append('seq', String(part.seq));
      form.append('size', String(part.size));
      form.append('file', buffer.subarray(part.start, part.end), {
        filename: fileName,
        contentType: file.mimeType || 'application/octet-stream',
      });
      const partResponse = await this.httpService.axiosRef.post(
        'https://open.feishu.cn/open-apis/drive/v1/medias/upload_part',
        form,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...form.getHeaders(),
          },
          maxBodyLength: Infinity,
          timeout: 60_000,
        },
      );
      assertFeishuSuccess(
        partResponse.data,
        `上传体系月报附件第 ${part.seq + 1} 个分片失败`,
      );
    }

    const finishResponse = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/drive/v1/medias/upload_finish',
      { upload_id: uploadId, block_num: blockNum },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60_000,
      },
    );
    assertFeishuSuccess(finishResponse.data, '完成分片上传体系月报附件失败');
    const fileToken = clean(
      finishResponse.data?.data?.file_token ||
        finishResponse.data?.data?.media_token,
    );
    if (!fileToken) {
      throw new BadGatewayException(
        '完成分片上传体系月报附件失败：响应缺少 file_token',
      );
    }
    return fileToken;
  }

  async downloadFinalAttachment(
    sourceRecordId: string,
    fileToken: string,
  ): Promise<{
    buffer: Buffer;
    contentType: string;
  }> {
    return this.downloadCollectionAttachment(
      sourceRecordId,
      fileToken,
      '终版月报',
    );
  }

  async downloadCollectionAttachment(
    sourceRecordId: string,
    fileToken: string,
    fieldName: '终版月报' | '初审问题截图' | '复审问题截图',
  ): Promise<{
    buffer: Buffer;
    contentType: string;
  }> {
    const normalizedToken = clean(fileToken);
    const normalizedRecordId = clean(sourceRecordId);
    if (
      !normalizedToken ||
      normalizedToken.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(normalizedToken)
    ) {
      throw new BadGatewayException('终版月报附件 token 无效');
    }
    if (!/^rec[a-zA-Z0-9_-]{4,128}$/u.test(normalizedRecordId)) {
      throw new BadGatewayException('终版月报附件关联记录无效');
    }
    const token = await getTenantAccessToken(this.httpService);
    const fieldId = await this.resolveCollectionFieldId(fieldName);
    let downloadUrl = '';
    try {
      const response = await this.httpService.axiosRef.get(
        buildSystemMonthlyReportFinalAttachmentDownloadUrl(
          normalizedToken,
          normalizedRecordId,
          fieldId,
        ),
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 20_000,
          maxRedirects: 0,
        },
      );
      assertFeishuSuccess(response.data, '读取终版月报附件地址失败');
      const candidate = extractFeishuTmpDownloadUrl(response.data);
      if (candidate && isTrustedFeishuAttachmentUrl(candidate)) {
        downloadUrl = candidate;
      }
    } catch {
      downloadUrl = '';
    }
    const directDownload = !downloadUrl;
    if (directDownload) {
      downloadUrl = buildFeishuDirectDownloadUrl(normalizedToken);
    }
    if (!isTrustedFeishuAttachmentUrl(downloadUrl)) {
      throw new BadGatewayException('终版月报附件下载地址无效');
    }
    const response = await this.httpService.axiosRef.get<ArrayBuffer>(
      downloadUrl,
      {
        ...(directDownload
          ? { headers: { Authorization: `Bearer ${token}` } }
          : {}),
        responseType: 'arraybuffer',
        timeout: SYSTEM_MONTHLY_REPORT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
        maxContentLength: SYSTEM_MONTHLY_REPORT_MAX_FINAL_ATTACHMENT_BYTES,
        maxBodyLength: SYSTEM_MONTHLY_REPORT_MAX_FINAL_ATTACHMENT_BYTES,
        maxRedirects: 0,
      },
    );
    const buffer = Buffer.from(
      new Uint8Array(response.data || new ArrayBuffer(0)),
    );
    if (
      !buffer.length ||
      buffer.length > SYSTEM_MONTHLY_REPORT_MAX_FINAL_ATTACHMENT_BYTES
    ) {
      throw new BadGatewayException('终版月报附件为空或超过 256 MB');
    }
    const contentType = clean(response.headers?.['content-type']).split(';')[0];
    return {
      buffer,
      contentType: contentType || 'application/octet-stream',
    };
  }

  async createCollectionRecord(
    fields: Record<string, unknown>,
    clientToken: string,
  ): Promise<string> {
    const token = await getTenantAccessToken(this.httpService);
    const request = () =>
      this.httpService.axiosRef.post(
        recordsUrl(TABLES.collection.id),
        { fields },
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            client_token: buildSystemMonthlyReportClientToken(clientToken),
            ignore_consistency_check: true,
            user_id_type: 'open_id',
          },
          timeout: 30_000,
        },
      );
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request();
    } catch (error) {
      if (hasFeishuHttpResponse(error)) {
        throw new BadGatewayException(
          `提交体系月报记录失败：${describeSystemMonthlyReportFeishuError(error)}`,
        );
      }
      try {
        response = await request();
      } catch (retryError) {
        if (hasFeishuHttpResponse(retryError)) {
          throw new BadGatewayException(
            `提交体系月报记录失败：${describeSystemMonthlyReportFeishuError(retryError)}`,
          );
        }
        throw new SystemMonthlyReportIndeterminateWriteError(
          clientToken,
          retryError,
        );
      }
    }
    assertFeishuSuccess(response.data, '提交体系月报记录失败');
    const recordId = clean(response.data?.data?.record?.record_id);
    if (!recordId) {
      throw new BadGatewayException('提交体系月报记录失败：响应缺少 record_id');
    }
    invalidateBitableRecordCache({
      appToken: APP_TOKEN,
      tableId: TABLES.collection.id,
      deletePersisted: true,
    });
    invalidateBitableRecordCache({
      appToken: APP_TOKEN,
      tableId: TABLES.current.id,
      deletePersisted: true,
    });
    return recordId;
  }

  async getCollectionRecord(recordId: string): Promise<RawBitableRecord> {
    const token = await getTenantAccessToken(this.httpService);
    const response = await this.httpService.axiosRef.get(
      `${recordsUrl(TABLES.collection.id)}/${encodeURIComponent(recordId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { user_id_type: 'open_id' },
        timeout: 30_000,
      },
    );
    assertFeishuSuccess(response.data, '回读体系月报记录失败');
    const record = response.data?.data?.record;
    if (!record || typeof record !== 'object') {
      throw new BadGatewayException('回读体系月报记录失败：响应缺少 record');
    }
    return record as RawBitableRecord;
  }

  async updateCollectionRecord(
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const token = await getTenantAccessToken(this.httpService);
    const response = await this.httpService.axiosRef.put(
      `${recordsUrl(TABLES.collection.id)}/${encodeURIComponent(recordId)}`,
      { fields },
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          ignore_consistency_check: true,
          user_id_type: 'open_id',
        },
        timeout: 30_000,
      },
    );
    assertFeishuSuccess(response.data, '更新体系月报附件失败');
    invalidateBitableRecordCache({
      appToken: APP_TOKEN,
      tableId: TABLES.collection.id,
      deletePersisted: true,
    });
    invalidateBitableRecordCache({
      appToken: APP_TOKEN,
      tableId: TABLES.current.id,
      deletePersisted: true,
    });
  }

  async deleteCollectionRecord(recordId: string): Promise<void> {
    const token = await getTenantAccessToken(this.httpService);
    const response = await this.httpService.axiosRef.delete(
      `${recordsUrl(TABLES.collection.id)}/${encodeURIComponent(recordId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { ignore_consistency_check: true },
        timeout: 30_000,
      },
    );
    assertFeishuSuccess(response.data, '清理体系月报测试记录失败');
    invalidateBitableRecordCache({
      appToken: APP_TOKEN,
      tableId: TABLES.collection.id,
      deletePersisted: true,
    });
  }

  async sendPackageLink(input: {
    recipientOpenId: string;
    url: string;
    year: number;
    month: number;
    fileName: string;
    complete: boolean;
    missingRooms: string[];
    clientToken: string;
  }): Promise<string> {
    if (!/^ou_[A-Za-z0-9]+$/u.test(input.recipientOpenId)) {
      throw new BadGatewayException('月报打包接收人 open_id 无效');
    }
    const token = await getTenantAccessToken(this.httpService);
    const suffix = input.complete
      ? '已包含全部机房终版附件。'
      : `当前缺少：${input.missingRooms.join('、')}。`;
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/im/v1/messages',
      {
        receive_id: input.recipientOpenId,
        msg_type: 'text',
        content: JSON.stringify({
          text: `${input.year}年${input.month}月体系月报终版汇总已生成。${suffix}\n${input.fileName}\n下载链接（1小时有效）：${input.url}`,
        }),
        uuid: `smrp-${createPackageMessageToken(input.clientToken)}`,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { receive_id_type: 'open_id' },
        timeout: 30_000,
      },
    );
    assertFeishuSuccess(response.data, '推送体系月报压缩包失败');
    const messageId = clean(response.data?.data?.message_id);
    if (!messageId)
      throw new BadGatewayException(
        '推送体系月报压缩包失败：响应缺少 message_id',
      );
    return messageId;
  }

  private listRecords(
    table: keyof typeof TABLES,
    fieldNames: readonly string[],
    forceRefresh: boolean,
  ): Promise<BitableRecordItem[]> {
    const config = TABLES[table];
    return fetchBitableRecords(this.httpService, {
      appToken: APP_TOKEN,
      tableId: config.id,
      tableName: config.name,
      fieldNames,
      automaticFields: true,
      forceRefresh,
      allowStale: !forceRefresh,
      strict: true,
      cacheTtlMs: 5 * 60 * 1000,
    });
  }

  private async listFields(
    table: 'current' | 'collection' | 'schedule',
    forceRefresh: boolean,
  ): Promise<RawBitableField[]> {
    const config = TABLES[table];
    const cached = this.fieldCache.get(config.id);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.fields;
    }
    const token = await getTenantAccessToken(this.httpService);
    const fields: RawBitableField[] = [];
    let pageToken: string | undefined;
    let hasMore = true;
    while (hasMore) {
      const response = await this.httpService.axiosRef.get(
        fieldsUrl(config.id),
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { page_size: 200, page_token: pageToken },
          timeout: 30_000,
        },
      );
      assertFeishuSuccess(response.data, `读取${config.name}字段失败`);
      const data = response.data?.data || {};
      fields.push(...(Array.isArray(data.items) ? data.items : []));
      hasMore = Boolean(data.has_more);
      pageToken = clean(data.page_token) || undefined;
    }
    this.fieldCache.set(config.id, {
      expiresAt: Date.now() + 60 * 60 * 1000,
      fields,
    });
    return fields;
  }

  private async resolveCollectionFieldId(fieldName: string): Promise<string> {
    const fields = await this.listFields('collection', false);
    const field = fields.find((item) => clean(item.field_name) === fieldName);
    const fieldId = clean(field?.field_id || field?.id);
    if (!fieldId) {
      throw new BadGatewayException(`月报收集表缺少字段：${fieldName}`);
    }
    return fieldId;
  }
}

export function buildSystemMonthlyReportFinalAttachmentDownloadUrl(
  fileToken: string,
  recordId: string,
  fieldId: string,
): string {
  const extra = JSON.stringify({
    bitablePerm: {
      tableId: TABLES.collection.id,
      attachments: {
        [fieldId]: {
          [recordId]: [fileToken],
        },
      },
    },
  });
  const url = new URL(
    'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url',
  );
  url.searchParams.set('file_tokens', fileToken);
  url.searchParams.set('extra', extra);
  return url.toString();
}

function recordsUrl(tableId: string): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records`;
}

function fieldsUrl(tableId: string): string {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`;
}

function assertFeishuSuccess(payload: unknown, prefix: string): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BadGatewayException(`${prefix}：响应格式无效`);
  }
  const response = payload as { code?: unknown; msg?: unknown };
  if (response.code === 0) return;
  throw new BadGatewayException(
    `${prefix}：${clean(response.msg) || `错误码 ${String(response.code)}`}`,
  );
}

export function describeSystemMonthlyReportFeishuError(error: unknown): string {
  const candidate = error as {
    message?: unknown;
    response?: {
      status?: unknown;
      data?: unknown;
    };
  };
  const response = candidate?.response;
  const payload =
    response?.data &&
    typeof response.data === 'object' &&
    !Array.isArray(response.data)
      ? (response.data as { code?: unknown; msg?: unknown })
      : undefined;
  const status = Number(response?.status);
  const statusText =
    Number.isInteger(status) && status > 0 ? `HTTP ${status}` : '';
  const code =
    payload?.code !== undefined && payload.code !== null
      ? safeExternalErrorText(String(payload.code))
      : '';
  const message = safeExternalErrorText(payload?.msg);
  const responseParts = [
    statusText,
    code ? `错误码 ${code}` : '',
    message,
  ].filter(Boolean);
  if (responseParts.length) {
    return responseParts
      .map((part, index) =>
        index === 2 && responseParts.length > 1 ? `：${part}` : part,
      )
      .join(responseParts.length > 2 ? '，' : '，')
      .replace(/，：/u, '：');
  }
  return safeExternalErrorText(candidate?.message) || '未知错误';
}

function hasFeishuHttpResponse(error: unknown): boolean {
  const status = Number(
    (error as { response?: { status?: unknown } })?.response?.status,
  );
  return Number.isInteger(status) && status > 0;
}

export function buildSystemMonthlyReportUploadParts(
  totalBytes: number,
  blockSize: number,
  blockNum: number,
): SystemMonthlyReportUploadPart[] {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isSafeInteger(blockSize) ||
    blockSize <= 0 ||
    !Number.isSafeInteger(blockNum) ||
    blockNum <= 0
  ) {
    throw new BadGatewayException('飞书返回的分片策略无效');
  }
  if (Math.ceil(totalBytes / blockSize) !== blockNum) {
    throw new BadGatewayException('飞书返回的分片数量与文件大小不一致');
  }
  return Array.from({ length: blockNum }, (_, seq) => {
    const start = seq * blockSize;
    const end = Math.min(start + blockSize, totalBytes);
    return { seq, start, end, size: end - start };
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function safeFileName(value: string): string {
  return (
    value
      .replace(/[\r\n\\/:*?"<>|\x00-\x1f]/g, '_')
      .trim()
      .slice(0, 200) || '体系月报附件'
  );
}

function safeExternalErrorText(value: unknown): string {
  return clean(value)
    .replace(/[\r\n\u0000-\u001f\u007f]/gu, ' ')
    .slice(0, 200);
}

function createPackageMessageToken(value: string): string {
  return Buffer.from(value).toString('base64url').slice(0, 42);
}

function normalizeTimestamp(value: number): number {
  return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const TRUSTED_FEISHU_DOWNLOAD_DOMAINS = [
  'feishu.cn',
  'feishucdn.com',
  'larksuite.com',
  'larksuitecdn.com',
  'byteimg.com',
  'bytefcdn.com',
  'volces.com',
  'volccdn.com',
];

function isTrustedFeishuAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    ) {
      return false;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    return TRUSTED_FEISHU_DOWNLOAD_DOMAINS.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}
