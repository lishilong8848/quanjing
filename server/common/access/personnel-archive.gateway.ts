import { HttpService } from '@nestjs/axios';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { extractDisplayText, fetchBitableRecords, getTenantAccessToken, readLatestPersistedBitableRecordSnapshot, resolveBitableAppToken, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { readEmployeeOnboardingConfig } from '../../modules/bitable-sync/employee-onboarding.config';
import { DEFAULT_ACTIVE_PERSONNEL_VIEW_ID } from '../../modules/bitable-sync/active-personnel-directory';
import { maskOrganizationPersonIdCard } from '../../modules/bitable-sync/organization-person-profile.mapper';
import { withPersonnelDirectoryDeadline } from './personnel-directory-deadline';
import { EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE } from '../../../shared/employee-onboarding';

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
}
interface Target { appId: string; appToken: string; tableId: string; viewId: string; fields: string[]; checkbox: boolean; photoFields: string[] }
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
        checkbox: available.get('离职/异动情况') === 7, photoFields: PHOTO_FIELDS.filter(name => available.get(name) === 17) };
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
      snapshotAt: new Date(snapshot?.fetchedAt || Date.now()).toISOString() };
  }

  async photo(directory: PersonnelArchiveDirectory, record: BitableRecordItem): Promise<PersonalArchivePhoto | null> {
    const token = photoToken(record);
    if (!token) return null;
    const key = `${directory.appId}:${directory.appToken}:${directory.tableId}:${token}`;
    const cached = this.photos.get(key);
    if (cached && cached.expiresAt > Date.now()) return { contentType: cached.value.contentType, buffer: Buffer.from(cached.value.buffer) };
    const pending = this.pendingPhotos.get(key);
    if (pending) return pending;
    if (this.pendingPhotos.size >= 8) throw new ServiceUnavailableException('照片读取繁忙，请稍后重试');
    const promise = this.download(token).then(value => {
      this.photos.delete(key); this.photos.set(key, { value, expiresAt: Date.now() + CACHE_MS });
      while (this.photos.size > 8) this.photos.delete(this.photos.keys().next().value!);
      return value;
    }).finally(() => { this.pendingPhotos.delete(key); });
    this.pendingPhotos.set(key, promise);
    return promise;
  }

  private async download(fileToken: string): Promise<PersonalArchivePhoto> {
    try {
      const token = await getTenantAccessToken(this.http, undefined, { requestTimeoutMs: () => 8_000 });
      const response = await this.http.axiosRef.get<ArrayBuffer>(`${API}/drive/v1/medias/${encodeURIComponent(fileToken)}/download`, {
        headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer', timeout: 8_000,
        maxRedirects: 0, maxContentLength: PERSONAL_ARCHIVE_PHOTO_MAX_BYTES, maxBodyLength: PERSONAL_ARCHIVE_PHOTO_MAX_BYTES,
      });
      const buffer = Buffer.from(response.data);
      if (!buffer.length || buffer.length > PERSONAL_ARCHIVE_PHOTO_MAX_BYTES) throw unavailable();
      const contentType = imageType(buffer), raw = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!contentType || ![contentType, 'application/octet-stream'].includes(raw)) throw unavailable();
      return { buffer, contentType };
    } catch { throw new ServiceUnavailableException('个人照片读取失败，请稍后重试'); }
  }

  private async fields(appToken: string, tableId: string, token: string): Promise<{ field_name: string; type: number }[]> {
    const fields: { field_name: string; type: number }[] = [], tokens = new Set<string>(), names = new Set<string>();
    let pageToken: string | undefined;
    do {
      const response = await this.http.axiosRef.get(`${API}/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, {
        headers: { Authorization: `Bearer ${token}` }, params: { page_size: 100, page_token: pageToken }, timeout: 8_000, maxRedirects: 0,
      });
      const data = response.data?.data;
      if (response.data?.code !== 0 || !data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') throw unavailable();
      for (const field of data.items) {
        if (!field || typeof field.field_name !== 'string' || !Number.isInteger(field.type) || names.has(field.field_name)) throw unavailable();
        names.add(field.field_name); fields.push({ field_name: field.field_name, type: field.type });
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
