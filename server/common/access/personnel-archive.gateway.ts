import { HttpService } from '@nestjs/axios';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { extractDisplayText, fetchBitableRecords, getTenantAccessToken, readLatestPersistedBitableRecordSnapshot, resolveBitableAppToken, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { readEmployeeOnboardingConfig } from '../../modules/bitable-sync/employee-onboarding.config';
import { DEFAULT_ACTIVE_PERSONNEL_VIEW_ID } from '../../modules/bitable-sync/active-personnel-directory';
import { maskOrganizationPersonIdCard } from '../../modules/bitable-sync/organization-person-profile.mapper';
import { withPersonnelDirectoryDeadline } from './personnel-directory-deadline';
import { EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE } from '../../../shared/employee-onboarding';
import { PERSONAL_PHOTO_MESSAGES, type PersonalPhotoErrorCode } from '../../../shared/personnel-photo-errors';
import { getBitableRecordCacheGeneration, getRecordId } from '../feishu/bitable-direct-read';

const API = 'https://open.feishu.cn/open-apis';
const CACHE_MS = 5 * 60_000;
export const PERSONAL_ARCHIVE_PHOTO_MAX_BYTES = EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE.maxBytesPerFile;
const PHOTO_FIELDS = ['照片', '证件照', '个人照片', '员工照片', '简历照片（一寸）', '简历照片'];

/** Explicit projection. Unknown columns, especially credentials, never become archive output. */
export const PERSONAL_ARCHIVE_FIELD_NAMES = [
  '姓名', '员工姓名', '员工', '人员', '飞书 open_id', 'open_id', 'Open ID',
  '员工工号', '工号', '编码', ...PHOTO_FIELDS, '离职/异动情况', '人员状态', '在职状态',
  '岗位', '楼岗位', '职位', '体系岗位', '岗位体系', '公司名称', '公司', '单位', '用工性质', '人员性质',
  '机楼/专业', '机楼专业', '楼栋/专业', '楼栋', '机楼', '班组', '组别', '班次', '班别', '主管', '直接主管',
  '联系方式', '电话', '手机号', '电子邮箱', '邮箱', '身份证号', '证件号码',
  '入职日期', '入司日期', '离职日期', '最后工作日', '异动日期', '离职原因', '异动原因',
  '学历', '最高学历', '毕业院校', '院校', '所学专业', '专业', '毕业时间', '毕业日期',
  '兴趣爱好', '爱好', '车牌号', '车辆牌照', '特长标签', '特长', '技能标签', 'MBTI', '16型人格', '人格类型',
  '责任心', '稳定性', '协作力', '协作能力', '成长潜力',
  '电气运维', '电气运维能力', '电气运维岗位基准', '岗位基准-电气运维',
  '暖通基础', '暖通基础能力', '暖通基础岗位基准', '岗位基准-暖通基础',
  '应急响应', '应急处置', '应急响应岗位基准', '岗位基准-应急响应',
  '安全规范', '安全合规', '安全规范岗位基准', '岗位基准-安全规范',
  '团队协作', '团队协作岗位基准', '岗位基准-团队协作',
  '演练实战', '演练能力', '演练实战岗位基准', '岗位基准-演练实战',
  '培训已完成课程', '已完成课程数', '培训课程总数', '课程总数', '培训完成率', '课程完成率',
  '培训平均分', '平均分', '培训签到率', '签到率', '最终考核成绩', '最终成绩',
  '年度演练次数', '演练次数', '最近演练评级', '演练评级', '最近演练主题', '演练主题', '最近演练日期', '演练日期',
  '入职说明', '岗位生效日期', '任职日期', '任职说明', '岗位说明', '异动说明', '离职说明',
  '高压电工证', '高压电工证状态', '高压电工证有效性', '高压电工证到期日期', '高压电工证有效期',
  '低压电工证', '低压电工证状态', '低压电工证有效性', '低压电工证到期日期', '低压电工证有效期',
  '高处作业证', '高处作业证状态', '高处作业证有效性', '高处作业证到期日期', '高处作业证有效期',
] as const;

export interface PersonnelArchiveDirectory {
  appId: string;
  appToken: string;
  tableId: string;
  records: BitableRecordItem[];
  snapshotAt: string;
  photoFieldIds?: Record<string, string>;
}
interface Target { appId: string; appToken: string; tableId: string; viewId: string; fields: string[]; checkbox: boolean; photoFields: string[]; photoFieldIds: Record<string, string> }
export interface PersonalArchivePhoto { contentType: 'image/png' | 'image/jpeg' | 'image/webp'; buffer: Buffer }

@Injectable()
export class PersonnelArchiveGateway {
  private metadata?: { key: string; target: Target; expiresAt: number };
  private pending?: { key: string; promise: Promise<PersonnelArchiveDirectory> };
  private readonly photos = new Map<string, { value: PersonalArchivePhoto; expiresAt: number }>();
  private readonly pendingPhotos = new Map<string, Promise<PersonalArchivePhoto>>();
  constructor(private readonly http: HttpService) {}

  read(): Promise<PersonnelArchiveDirectory> {
    const source = readEmployeeOnboardingConfig(), appId = process.env.FEISHU_APP_ID?.trim() || '';
    const viewId = process.env.FEISHU_ORG_VIEW_ID?.trim() || process.env.FEISHU_ORGANIZATION_VIEW_ID?.trim() || DEFAULT_ACTIVE_PERSONNEL_VIEW_ID;
    if (!appId || !/^vew[A-Za-z0-9]+$/.test(viewId)) return Promise.reject(unavailable());
    const key = JSON.stringify([appId, source, viewId]);
    if (this.pending?.key === key) return withPersonnelDirectoryDeadline(this.pending.promise);
    const promise = this.load(source, appId, viewId, key).catch(() => { throw unavailable(); });
    this.pending = { key, promise };
    void promise.finally(() => { if (this.pending?.promise === promise) this.pending = undefined; }).catch(() => undefined);
    return withPersonnelDirectoryDeadline(promise);
  }

  private async load(source: ReturnType<typeof readEmployeeOnboardingConfig>, appId: string, viewId: string, key: string): Promise<PersonnelArchiveDirectory> {
    let target = this.metadata?.key === key && this.metadata.expiresAt > Date.now() ? this.metadata.target : undefined;
    if (!target) {
      const appToken = await resolveBitableAppToken(this.http, { appToken: source.appToken, wikiToken: source.wikiToken, tableName: source.tableName, requestTimeoutMs: () => 8_000 });
      const token = await getTenantAccessToken(this.http, undefined, { requestTimeoutMs: () => 8_000 });
      const metas = await this.fields(appToken, source.tableId, token);
      const available = new Map(metas.map(field => [field.field_name, field.type]));
      if (!['姓名', '员工姓名', '员工', '人员'].some(name => available.has(name)) || !available.has('离职/异动情况')) throw unavailable();
      target = { appId, appToken, tableId: source.tableId, viewId, fields: PERSONAL_ARCHIVE_FIELD_NAMES.filter(name => available.has(name)),
        checkbox: available.get('离职/异动情况') === 7, photoFields: PHOTO_FIELDS.filter(name => available.get(name) === 17),
        photoFieldIds: Object.fromEntries(metas.filter(field => PHOTO_FIELDS.includes(field.field_name) && field.type === 17 && /^fld[A-Za-z0-9_-]+$/.test(field.field_id || '')).map(field => [field.field_name, field.field_id!])) };
      this.metadata = { key, target, expiresAt: Date.now() + CACHE_MS };
    }
    const options = { appToken: target.appToken, tableId: target.tableId, viewId: target.viewId, tableName: '本人档案资料',
      automaticFields: true, fieldNames: target.fields, strict: true, allowStale: false, cacheTtlMs: CACHE_MS } as const;
    const records = await fetchBitableRecords(this.http, { ...options,
      // Redact before the shared reader persists its projection, not only before returning JSON.
      validateRecords: rows => { for (const record of rows) record.fields = projectFields(record.fields, target!); },
    });
    const projected = records.map(record => ({ ...record, fields: projectFields(record.fields, target!) }));
    const snapshot = await readLatestPersistedBitableRecordSnapshot(options).catch(() => null);
    return { appId: target.appId, appToken: target.appToken, tableId: target.tableId, records: projected,
      snapshotAt: new Date(snapshot?.fetchedAt || Date.now()).toISOString(), photoFieldIds: { ...target.photoFieldIds } };
  }

  async photo(directory: PersonnelArchiveDirectory, record: BitableRecordItem): Promise<PersonalArchivePhoto | null> {
    const token = photoToken(record);
    if (!token) return null;
    const photoField = PHOTO_FIELDS.find(name => Array.isArray(record.fields?.[name]) && (record.fields![name] as Array<{ file_token?: string }>).some(value => value?.file_token === token));
    const fieldId = photoField ? directory.photoFieldIds?.[photoField] : undefined;
    const recordId = getRecordId(record);
    if (!fieldId || !/^fld[A-Za-z0-9_-]+$/.test(fieldId) || typeof recordId !== 'string' || !/^rec[A-Za-z0-9_-]+$/.test(recordId) || !/^tbl[A-Za-z0-9_-]+$/.test(directory.tableId)) throw photoFailure('PHOTO_SOURCE_NOT_READY');
    const extra = JSON.stringify({ bitablePerm: { tableId: directory.tableId, attachments: { [fieldId]: { [recordId]: [token] } } } });
    const generation = getBitableRecordCacheGeneration(directory.appToken, directory.tableId);
    const key = JSON.stringify([directory.appId, directory.appToken, directory.tableId, recordId, fieldId, token, generation]);
    const cached = this.photos.get(key);
    if (cached && cached.expiresAt > Date.now()) return { contentType: cached.value.contentType, buffer: Buffer.from(cached.value.buffer) };
    const pending = this.pendingPhotos.get(key);
    if (pending) return pending;
    if (this.pendingPhotos.size >= 8) throw new ServiceUnavailableException('照片读取繁忙，请稍后重试');
    const promise = this.download(token, extra).then(value => {
      if (generation !== getBitableRecordCacheGeneration(directory.appToken, directory.tableId)) throw photoFailure('PHOTO_SOURCE_CHANGED');
      this.photos.delete(key); this.photos.set(key, { value, expiresAt: Date.now() + CACHE_MS });
      while (this.photos.size > 8) this.photos.delete(this.photos.keys().next().value!);
      return value;
    }).finally(() => { this.pendingPhotos.delete(key); });
    this.pendingPhotos.set(key, promise);
    return promise;
  }

  private async download(fileToken: string, extra: string): Promise<PersonalArchivePhoto> {
    try {
      const token = await getTenantAccessToken(this.http, undefined, { requestTimeoutMs: () => 8_000 });
      const response = await this.http.axiosRef.get<ArrayBuffer>(`${API}/drive/v1/medias/${encodeURIComponent(fileToken)}/download`, {
        headers: { Authorization: `Bearer ${token}` }, params: { extra }, responseType: 'arraybuffer', timeout: 8_000,
        maxRedirects: 0, maxContentLength: PERSONAL_ARCHIVE_PHOTO_MAX_BYTES, maxBodyLength: PERSONAL_ARCHIVE_PHOTO_MAX_BYTES,
      });
      const buffer = Buffer.from(response.data);
      if (!buffer.length || buffer.length > PERSONAL_ARCHIVE_PHOTO_MAX_BYTES) throw photoFailure('PHOTO_INVALID_CONTENT');
      const contentType = imageType(buffer), raw = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!contentType || ![contentType, 'application/octet-stream'].includes(raw)) throw photoFailure('PHOTO_INVALID_CONTENT');
      return { buffer, contentType };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        const body = error.getResponse();
        if (typeof body === 'object' && 'code' in body && typeof body.code === 'string' && Object.hasOwn(PERSONAL_PHOTO_MESSAGES, body.code)) throw error;
      }
      const failure = error as { code?: string; response?: { status?: number } };
      if (failure?.response?.status === 401 || failure?.response?.status === 403) throw photoFailure('PHOTO_SOURCE_DENIED');
      if (failure?.response?.status === 404) throw photoFailure('PHOTO_SOURCE_MISSING');
      if (failure?.code === 'ETIMEDOUT' || failure?.code === 'ECONNABORTED') throw photoFailure('PHOTO_SOURCE_TIMEOUT');
      throw photoFailure('PHOTO_UNAVAILABLE');
    }
  }

  private async fields(appToken: string, tableId: string, token: string): Promise<{ field_name: string; type: number; field_id?: string }[]> {
    const fields: { field_name: string; type: number; field_id?: string }[] = [], tokens = new Set<string>(), names = new Set<string>();
    let pageToken: string | undefined;
    do {
      const response = await this.http.axiosRef.get(`${API}/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
        headers: { Authorization: `Bearer ${token}` }, params: { page_size: 100, page_token: pageToken }, timeout: 8_000, maxRedirects: 0,
      });
      const data = response.data?.data;
      if (response.data?.code !== 0 || !data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') throw unavailable();
      for (const field of data.items) {
        if (!field || typeof field.field_name !== 'string' || !Number.isInteger(field.type) || names.has(field.field_name)) throw unavailable();
        names.add(field.field_name); fields.push({ field_name: field.field_name, type: field.type, ...(typeof field.field_id === 'string' ? { field_id: field.field_id } : {}) });
      }
      if (fields.length > 500) throw unavailable();
      if (!data.has_more) break;
      if (typeof data.page_token !== 'string' || !data.page_token || tokens.has(data.page_token)) throw unavailable();
      tokens.add(data.page_token); pageToken = data.page_token;
    } while (pageToken);
    return fields;
  }
}

function projectFields(input: BitableRecordItem['fields'], target: Target): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw unavailable();
  for (const key of target.fields) if (Object.hasOwn(input, key)) fields[key] = input[key];
  for (const key of ['身份证号', '证件号码']) if (Object.hasOwn(fields, key)) fields[key] = maskOrganizationPersonIdCard(extractDisplayText(fields[key], ''));
  if (target.checkbox && fields['离职/异动情况'] === undefined) fields['离职/异动情况'] = false;
  // Retain tokens only; untrusted source URLs must never be used for proxy downloads.
  // Keep the original schema-validated attachment key so this projection stays
  // idempotent when the shared cache and this gateway both apply it.
  for (const key of PHOTO_FIELDS) {
    const attachment = fields[key];
    if (!target.photoFields.includes(key) || !Array.isArray(attachment)) { delete fields[key]; continue; }
    fields[key] = attachment.filter(value => value && typeof value === 'object' && validFileToken(value.file_token)).map(value => ({ file_token: value.file_token }));
  }
  return fields;
}
export function photoToken(record: BitableRecordItem): string | null {
  for (const key of PHOTO_FIELDS) {
    const values = record.fields?.[key];
    if (!Array.isArray(values)) continue;
    const token = values.find(value => value && validFileToken(value.file_token))?.file_token;
    if (typeof token === 'string') return token;
  }
  return null;
}
function validFileToken(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{6,256}$/.test(value); }
function imageType(buffer: Buffer): PersonalArchivePhoto['contentType'] | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
function unavailable() { return new ServiceUnavailableException('个人档案资料暂不可用，请稍后重试'); }
function photoFailure(code: PersonalPhotoErrorCode) { return new ServiceUnavailableException({ code, message: PERSONAL_PHOTO_MESSAGES[code] }); }
