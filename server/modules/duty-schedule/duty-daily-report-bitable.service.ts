import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import FormData from 'form-data';
import {
  getFeishuAuthPayload,
  readEnv,
} from '@server/common/config/external-services.config';

export type DutyDailyReportShift = 'white' | 'night';

export const DUTY_DAILY_REPORT_RECORD_MISSING =
  'DUTY_DAILY_REPORT_RECORD_MISSING' as const;

export class DutyDailyReportRecordMissingError extends Error {
  readonly code = DUTY_DAILY_REPORT_RECORD_MISSING;

  constructor(
    readonly date: string,
    readonly shift: DutyDailyReportShift,
    readonly shiftLabel: string,
  ) {
    super(
      `[${DUTY_DAILY_REPORT_RECORD_MISSING}] 未找到 ${date} ${shiftLabel}交接班日报记录，截图将在下次调度重试`,
    );
    this.name = 'DutyDailyReportRecordMissingError';
  }
}

export interface DutyDailyReportRecordResult {
  date: string;
  shift: DutyDailyReportShift;
  shiftLabel: string;
  recordId: string;
  created: boolean;
}

export interface DutyDailyReportScreenshotResult extends DutyDailyReportRecordResult {
  fileToken: string;
  attachmentCount: number;
  appended: boolean;
}

interface FeishuBitableRecord {
  id?: string;
  record_id?: string;
  fields?: Record<string, unknown>;
}

interface FeishuAttachmentValue {
  file_token: string;
  name?: string;
}

const DEFAULT_DAILY_REPORT_APP_TOKEN = 'PUBLIC_EXAMPLE_FEISHU_DAILY_REPORT_APP_TOKEN';
const DEFAULT_DAILY_REPORT_TABLE_ID = 'PUBLIC_EXAMPLE_FEISHU_DAILY_REPORT_TABLE_ID';
const CHINA_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1000;
@Injectable()
export class DutyDailyReportBitableService {
  private readonly logger = new Logger(DutyDailyReportBitableService.name);

  constructor(private readonly httpService: HttpService) {}

  async appendScreenshot(options: {
    date?: string;
    shift: DutyDailyReportShift;
    image: Buffer;
    fileName?: string;
    replaceExisting?: boolean;
  }): Promise<DutyDailyReportScreenshotResult> {
    const date = this.normalizeDate(options.date) || this.formatDateKey(new Date());
    const token = await this.getTenantAccessToken();
    const record = await this.requireDailyReportRecordWithToken(
      token,
      date,
      options.shift,
    );
    const fileName = options.fileName || `nantong-duty-${date}-${record.shiftLabel}.png`;
    const latestRecord = await this.getRecordById(token, record.recordId);
    const previousAttachments = this.extractAttachmentValues(
      latestRecord.fields?.[this.getScreenshotFieldName()],
    );
    const existingAttachment = previousAttachments.find(
      (attachment) => attachment.name === fileName,
    );
    if (existingAttachment && !options.replaceExisting) {
      this.logger.log(
        `日报截图已存在，跳过重复上传：date=${date}, shift=${record.shiftLabel}, record=${record.recordId}, file=${fileName}`,
      );
      return {
        ...record,
        fileToken: existingAttachment.file_token,
        attachmentCount: previousAttachments.length,
        appended: false,
      };
    }

    const fileToken = await this.uploadBitableAttachment(token, {
      image: options.image,
      fileName,
    });
    const nextAttachments = existingAttachment
      ? previousAttachments.map((attachment) => (
          attachment.file_token === existingAttachment.file_token
            ? { file_token: fileToken }
            : attachment
        ))
      : this.appendAttachment(previousAttachments, fileToken);

    await this.updateRecord(token, record.recordId, {
      [this.getScreenshotFieldName()]: nextAttachments.map((attachment) => ({
        file_token: attachment.file_token,
      })),
    });

    this.logger.log(existingAttachment
      ? `日报截图已替换：date=${date}, shift=${record.shiftLabel}, record=${record.recordId}, file=${fileName}, attachments=${nextAttachments.length}`
      : `日报截图已追加到多维表：date=${date}, shift=${record.shiftLabel}, record=${record.recordId}, attachments=${nextAttachments.length}`,
    );

    return {
      ...record,
      fileToken,
      attachmentCount: nextAttachments.length,
      appended: true,
    };
  }

  private async requireDailyReportRecordWithToken(
    token: string,
    date: string,
    shift: DutyDailyReportShift,
  ): Promise<DutyDailyReportRecordResult> {
    const shiftLabel = this.getShiftLabel(shift);
    const matched = await this.findDailyReportRecord(token, date, shiftLabel);

    if (!matched) {
      throw new DutyDailyReportRecordMissingError(date, shift, shiftLabel);
    }

    return {
      date,
      shift,
      shiftLabel,
      recordId: this.getRecordId(matched),
      created: false,
    };
  }

  private async findDailyReportRecord(
    token: string,
    date: string,
    shiftLabel: string,
  ): Promise<FeishuBitableRecord | null> {
    const records = await this.listDailyReportRecords(token);
    const matches = records.filter((record) => {
      const fields = record.fields || {};
      return (
        this.extractDateKey(fields[this.getDateFieldName()]) === date &&
        this.extractText(fields[this.getShiftFieldName()]) === shiftLabel
      );
    });

    if (matches.length > 1) {
      this.logger.warn(`日报多维表存在重复条目：date=${date}, shift=${shiftLabel}, count=${matches.length}`);
    }

    return matches[0] || null;
  }

  private async listDailyReportRecords(token: string): Promise<FeishuBitableRecord[]> {
    const records: FeishuBitableRecord[] = [];
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const response = await this.httpService.axiosRef.get(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.getAppToken()}/tables/${this.getTableId()}/records`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            page_size: 500,
            page_token: pageToken,
          },
          timeout: 30_000,
        },
      );

      if (response.data?.code !== 0) {
        throw new Error(`列出日报多维表记录失败：${response.data?.msg || response.data?.code}`);
      }

      const data = response.data?.data || {};
      records.push(...(data.items || []));
      pageToken = data.page_token;
      hasMore = Boolean(data.has_more);
    }

    return records;
  }

  private async getRecordById(token: string, recordId: string): Promise<FeishuBitableRecord> {
    const response = await this.httpService.axiosRef.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.getAppToken()}/tables/${this.getTableId()}/records/${recordId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30_000,
      },
    );

    if (response.data?.code !== 0) {
      throw new Error(`读取日报多维表记录失败：${response.data?.msg || response.data?.code}`);
    }

    const record = response.data?.data?.record || response.data?.data?.item;
    if (!record) {
      throw new Error(`读取日报多维表记录失败：响应中缺少记录 ${recordId}`);
    }
    return record;
  }

  private async updateRecord(
    token: string,
    recordId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.httpService.axiosRef.put(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.getAppToken()}/tables/${this.getTableId()}/records/${recordId}`,
      { fields },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30_000,
      },
    );

    if (response.data?.code !== 0) {
      throw new Error(`更新日报多维表记录失败：${response.data?.msg || response.data?.code}`);
    }
  }

  private async uploadBitableAttachment(
    token: string,
    options: { image: Buffer; fileName: string },
  ): Promise<string> {
    const form = new FormData();
    form.append('file_name', options.fileName);
    form.append('parent_type', readEnv('FEISHU_DAILY_REPORT_ATTACHMENT_PARENT_TYPE') || 'bitable_file');
    form.append('parent_node', readEnv('FEISHU_DAILY_REPORT_ATTACHMENT_PARENT_NODE') || this.getAppToken());
    form.append('size', String(options.image.byteLength));
    form.append('file', options.image, {
      filename: options.fileName,
      contentType: 'image/png',
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
        timeout: 30_000,
      },
    );

    if (response.data?.code !== 0) {
      throw new Error(`上传日报截图附件失败：${response.data?.msg || response.data?.code}`);
    }

    const fileToken = response.data?.data?.file_token || response.data?.data?.media_token;
    if (!fileToken) {
      throw new Error('上传日报截图附件失败：响应中缺少 file_token');
    }
    return fileToken;
  }

  private appendAttachment(
    attachments: FeishuAttachmentValue[],
    fileToken: string,
  ): FeishuAttachmentValue[] {
    const existingTokens = new Set(attachments.map((item) => item.file_token));
    if (existingTokens.has(fileToken)) {
      return attachments;
    }
    return [...attachments, { file_token: fileToken }];
  }

  private extractAttachmentValues(value: unknown): FeishuAttachmentValue[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => {
        if (typeof item === 'string') {
          return { file_token: item };
        }
        if (item && typeof item === 'object') {
          const attachment = item as Record<string, unknown>;
          const token = attachment.file_token;
          if (typeof token === 'string' && token) {
            const name = attachment.name;
            return {
              file_token: token,
              ...(typeof name === 'string' && name ? { name } : {}),
            };
          }
        }
        return null;
      })
      .filter((item): item is FeishuAttachmentValue => Boolean(item));
  }

  private async getTenantAccessToken(): Promise<string> {
    const response = await this.httpService.axiosRef.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      getFeishuAuthPayload(),
      { timeout: 30_000 },
    );

    if (response.data?.code !== 0) {
      throw new Error(`获取飞书 tenant_access_token 失败：${response.data?.msg || response.data?.code}`);
    }

    const token = response.data?.tenant_access_token;
    if (!token) {
      throw new Error('获取飞书 tenant_access_token 失败：响应中缺少 tenant_access_token');
    }
    return token;
  }

  private extractText(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }
    if (Array.isArray(value)) {
      return value
        .map((item) => this.extractText(item))
        .filter(Boolean)
        .join('');
    }
    if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>;
      if (typeof item.text === 'string') return item.text.trim();
      if (typeof item.name === 'string') return item.name.trim();
    }
    return '';
  }

  private extractDateKey(value: unknown): string {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value + CHINA_TIMEZONE_OFFSET_MS).toISOString().slice(0, 10);
    }
    if (typeof value === 'string') {
      const normalized = value.trim().replace(/\//g, '-');
      const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (match) {
        return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
      }
    }
    return '';
  }

  private getRecordId(record: FeishuBitableRecord): string {
    return record.record_id || record.id || '';
  }

  private normalizeDate(value?: string): string | null {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error('日报日期格式不正确，请使用 YYYY-MM-DD');
    }
    return value;
  }

  private getShiftLabel(shift: DutyDailyReportShift): string {
    return shift === 'white' ? '白班' : '夜班';
  }

  private formatDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  private getAppToken(): string {
    return readEnv('FEISHU_DAILY_REPORT_APP_TOKEN', ['FEISHU_REPORT_APP_TOKEN'])
      || DEFAULT_DAILY_REPORT_APP_TOKEN;
  }

  private getTableId(): string {
    return readEnv('FEISHU_DAILY_REPORT_TABLE_ID', ['FEISHU_REPORT_TABLE_ID'])
      || DEFAULT_DAILY_REPORT_TABLE_ID;
  }

  private getDateFieldName(): string {
    return readEnv('FEISHU_DAILY_REPORT_DATE_FIELD') || '日期';
  }

  private getShiftFieldName(): string {
    return readEnv('FEISHU_DAILY_REPORT_SHIFT_FIELD') || '班次';
  }

  private getScreenshotFieldName(): string {
    return readEnv('FEISHU_DAILY_REPORT_SCREENSHOT_FIELD') || '日报截图';
  }

}
