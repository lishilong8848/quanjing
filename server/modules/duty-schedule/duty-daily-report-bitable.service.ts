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

const DEFAULT_DAILY_REPORT_APP_TOKEN = 'MliKbC3fXa8PXrsndKscmxjdn1g';
const DEFAULT_DAILY_REPORT_TABLE_ID = 'tblxfd0HA9kDZQ3w';
// The bitable gained a single-select 楼栋 field; one daily-report record is kept
// per building for each date+shift, so the same screenshot set is mirrored into
// all seven rows and readers can take any one of them.
const DEFAULT_DAILY_REPORT_BUILDINGS = [
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
];
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
    const shiftLabel = this.getShiftLabel(options.shift);
    // One record per building for this date+shift; create any missing building idempotently.
    // resolveBuildingRecords returns each record's current screenshot attachments (read from the
    // same listing), so no extra per-record fetch is needed.
    const buildingRecords = await this.resolveBuildingRecords(token, date, shiftLabel);
    const fileName = options.fileName || `nantong-duty-${date}-${shiftLabel}.png`;
    const screenshotField = this.getScreenshotFieldName();

    const states = buildingRecords.map((br) => ({
      building: br.building,
      recordId: br.recordId,
      created: br.created,
      attachments: br.attachments,
      hasFile: br.attachments.some((a) => a.name === fileName),
    }));

    const anyCreated = states.some((s) => s.created);
    const primary = states[0];
    const needsWrite = states.filter((s) => options.replaceExisting || !s.hasFile);
    if (!needsWrite.length) {
      this.logger.log(
        `日报截图已存在于全部 ${states.length} 条楼栋记录，跳过重复上传：date=${date}, shift=${shiftLabel}, file=${fileName}`,
      );
      return {
        date,
        shift: options.shift,
        shiftLabel,
        recordId: primary.recordId,
        created: anyCreated,
        fileToken: primary.attachments.find((a) => a.name === fileName)?.file_token || '',
        attachmentCount: primary.attachments.length,
        appended: false,
      };
    }

    // Upload the image once and mirror the same file_token into every building record.
    const fileToken = await this.uploadBitableAttachment(token, {
      image: options.image,
      fileName,
    });
    let attachmentCount = primary.attachments.length;
    for (const s of needsWrite) {
      const existing = s.attachments.find((a) => a.name === fileName);
      const nextAttachments = existing
        ? s.attachments.map((a) =>
            a.file_token === existing.file_token ? { file_token: fileToken } : a,
          )
        : this.appendAttachment(s.attachments, fileToken);
      await this.updateRecord(token, s.recordId, {
        [screenshotField]: nextAttachments.map((a) => ({ file_token: a.file_token })),
      });
      attachmentCount = nextAttachments.length;
    }

    this.logger.log(
      `日报截图已写入 ${needsWrite.length}/${states.length} 条楼栋记录：date=${date}, shift=${shiftLabel}, file=${fileName}, attachments=${attachmentCount}`,
    );
    return {
      date,
      shift: options.shift,
      shiftLabel,
      recordId: primary.recordId,
      created: anyCreated,
      fileToken,
      attachmentCount,
      appended: true,
    };
  }

  /**
   * Ensure one record per building (default 7) exists for the date+shift, creating
   * only the missing buildings (idempotent). Legacy records that predate the 楼栋
   * field (empty building) are adopted into missing buildings rather than left as
   * strays, so a date+shift never accumulates duplicate rows.
   */
  private async resolveBuildingRecords(
    token: string,
    date: string,
    shiftLabel: string,
  ): Promise<
    Array<{
      building: string;
      recordId: string;
      created: boolean;
      attachments: FeishuAttachmentValue[];
    }>
  > {
    const buildings = this.getBuildings();
    const buildingField = this.getBuildingFieldName();
    const screenshotField = this.getScreenshotFieldName();
    const records = await this.listDailyReportRecords(token);
    const matches = records.filter((record) => {
      const fields = record.fields || {};
      return (
        this.extractDateKey(fields[this.getDateFieldName()]) === date &&
        this.extractText(fields[this.getShiftFieldName()]) === shiftLabel
      );
    });
    const byBuilding = new Map<string, FeishuBitableRecord>();
    const legacy: FeishuBitableRecord[] = [];
    for (const record of matches) {
      if (!this.getRecordId(record)) continue;
      const building = this.extractText((record.fields || {})[buildingField]);
      if (building) {
        if (!byBuilding.has(building)) byBuilding.set(building, record);
      } else {
        legacy.push(record);
      }
    }
    const missing = buildings.filter((building) => !byBuilding.has(building));
    // Only inspect field types when a record actually needs to be created.
    let dateIsDateTime = false;
    if (missing.length > legacy.length) {
      const types = await this.getFieldTypes(token);
      dateIsDateTime = types.get(this.getDateFieldName()) === 5;
    }
    const attachmentsOf = (record: FeishuBitableRecord | undefined) =>
      record ? this.extractAttachmentValues(record.fields?.[screenshotField]) : [];
    const result: Array<{
      building: string;
      recordId: string;
      created: boolean;
      attachments: FeishuAttachmentValue[];
    }> = [];
    for (const building of buildings) {
      const existing = byBuilding.get(building);
      if (existing) {
        result.push({
          building,
          recordId: this.getRecordId(existing),
          created: false,
          attachments: attachmentsOf(existing),
        });
        continue;
      }
      const legacyRecord = legacy.shift();
      if (legacyRecord) {
        const legacyId = this.getRecordId(legacyRecord);
        await this.updateRecord(token, legacyId, { [buildingField]: building });
        result.push({
          building,
          recordId: legacyId,
          created: false,
          attachments: attachmentsOf(legacyRecord),
        });
        continue;
      }
      const recordId = await this.createDailyReportRecord(
        token,
        date,
        shiftLabel,
        building,
        dateIsDateTime,
      );
      result.push({ building, recordId, created: true, attachments: [] });
    }
    return result;
  }

  private async getFieldTypes(token: string): Promise<Map<string, number>> {
    const response = await this.httpService.axiosRef.get(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.getAppToken()}/tables/${this.getTableId()}/fields`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { page_size: 100 },
        timeout: 30_000,
      },
    );
    if (response.data?.code !== 0) {
      throw new Error(
        `读取日报多维表字段失败：${response.data?.msg || response.data?.code}`,
      );
    }
    const items = response.data?.data?.items || [];
    return new Map(
      items.map((field: { field_name?: string; type?: number }) => [
        field.field_name,
        field.type,
      ]),
    );
  }

  private async createDailyReportRecord(
    token: string,
    date: string,
    shiftLabel: string,
    building: string,
    dateIsDateTime: boolean,
  ): Promise<string> {
    const fields: Record<string, unknown> = {
      // Date fields (type 5) take epoch millis at China midnight, which round-trips
      // through extractDateKey; text date fields take the YYYY-MM-DD string.
      [this.getDateFieldName()]: dateIsDateTime
        ? Date.parse(`${date}T00:00:00+08:00`)
        : date,
      [this.getShiftFieldName()]: shiftLabel,
      [this.getBuildingFieldName()]: building,
    };
    const response = await this.httpService.axiosRef.post(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${this.getAppToken()}/tables/${this.getTableId()}/records`,
      { fields },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30_000,
      },
    );
    const recordId =
      response.data?.data?.record?.record_id || response.data?.data?.record?.id;
    if (response.data?.code !== 0 || typeof recordId !== 'string' || !recordId) {
      throw new Error(
        `创建日报楼栋记录失败（${building}）：${response.data?.msg || response.data?.code || '响应缺少 record_id'}`,
      );
    }
    return recordId;
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

    // Multiple records per date+shift are expected now (one per 楼栋); readers take
    // any one. Only flag genuine duplicates beyond the configured building count.
    if (matches.length > this.getBuildings().length) {
      this.logger.warn(`日报多维表存在超出楼栋数的重复条目：date=${date}, shift=${shiftLabel}, count=${matches.length}`);
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

  private getBuildingFieldName(): string {
    return readEnv('FEISHU_DAILY_REPORT_BUILDING_FIELD') || '楼栋';
  }

  private getBuildings(): string[] {
    const raw = readEnv('FEISHU_DAILY_REPORT_BUILDINGS');
    if (raw) {
      const list = raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (list.length) return list;
    }
    return [...DEFAULT_DAILY_REPORT_BUILDINGS];
  }

}
