import { HttpService } from '@nestjs/axios';
import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import FormData = require('form-data');
import { readEnv } from '../../common/config/external-services.config';
import { readPublicApplicationUrl } from '../../common/config/public-application-url';
import { getTenantAccessToken } from '../../common/feishu/bitable-direct-read';
import { readCachedActivePersonnel } from '../bitable-sync/active-personnel-directory';

const FEISHU = 'https://open.feishu.cn/open-apis';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_BATCH_BYTES = 50 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[\w-]{1,160}$/u;
const RECORD_ID = /^rec[\w-]{1,120}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,125}$/u;
const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,125}$/u;
const RESERVED_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);
const RECORD_MISSING_CODE = 1254043;
const RECORD_PAGE_SIZE = 50;
const RECORD_FIELD_ERRORS = new Set([1254015, 1254044, 1254045, 1254060, 1254061, 1254062, 1254063, 1254064, 1254065, 1254130]);
const deliveryRejections = new Map([
  [230001, '飞书拒绝了通知参数'],
  [230002, '机器人未加入目标群'],
  [230006, '飞书应用未启用机器人'],
  [230013, '此人员不在机器人的可用范围'],
  [230027, '机器人没有发送权限'],
  [230038, '飞书不允许向该跨租户单聊发送'],
  [230053, '该人员已停止接收机器人消息'],
  [230054, '该会话不支持此通知类型'],
  [230099, '飞书拒绝生成通知卡片'],
  [232009, '目标群已解散'],
]);

export class FilePublicationDeliveryRejected extends Error {}

export interface FilePublicationFile {
  name: string;
  size: number;
}

export interface FilePublicationGroup {
  id: string;
  name: string;
  kind?: 'person' | 'group';
}

export interface FilePublicationPreview {
  tableName: string;
  sourceUrl: string;
  fields: Array<{ key: string; name: string; value: string; maxLength: number; required?: true }>;
  title: string;
  code: string;
  attachmentField: { key: string; name: string };
  batchField?: { key: string; name: string };
  codeFieldKey?: string;
  schemaVersion: string;
}

export interface PreparedFilePublication {
  tableName: string;
  sourceUrl: string;
  title: string;
  code: string;
  appToken: string;
  tableId: string;
  batchField?: string;
  fields: Record<string, string | Array<{ file_token: string }>>;
}

export interface FilePublicationRecordTarget {
  appToken: string;
  tableId: string;
}

export interface FilePublicationRecordColumn {
  key: string;
  name: string;
  type: number;
  options?: Array<{ id: string; name: string }>;
}

export interface FilePublicationRecordSchema extends FilePublicationRecordTarget {
  tableName: string;
  sourceUrl: string;
  fields: FilePublicationRecordColumn[];
}

export interface FilePublicationTableRecord {
  id: string;
  fields: Record<string, unknown>;
}

interface TableLink {
  key: string;
  url: string;
  kind: 'base' | 'wiki';
  token: string;
  tableId: string;
}

interface ConfiguredTable extends TableLink {
  label: string;
  extraFields: string[];
}

interface TableField {
  id: string;
  name: string;
  type: number;
  primary: boolean;
  options?: FilePublicationRecordColumn['options'];
}

const METADATA_NAMES = {
  title: ['资料名称', '文件名称', '文档名称', '文件名', '发布名称', '名称', '标题'],
  code: ['文件编号', '资料编号', '文档编号', '文件编码', '编号'],
  notes: ['备注', '文件备注', '发布说明', '备注说明', '说明', '摘要'],
  batch: ['文件发布批次ID', '发布批次ID', '发布批次编号'],
  attachment: ['发布文件', '文件附件', '附件', '上传文件', '文件', '资料'],
} as const;

function object(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function label(input: unknown): string {
  return typeof input === 'string' && input.trim().length <= 120 && !CONTROL.test(input)
    ? input.trim()
    : '';
}

function configuration<T>(name: string, parse: (row: Record<string, unknown>) => T | null, defaultRows = ''): T[] {
  const raw = readEnv(name) || defaultRows;
  if (!raw) return [];
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 40) throw new Error();
    return rows.map(row => {
      const value = parse(object(row));
      if (!value) throw new Error();
      return value;
    });
  } catch {
    throw new ServiceUnavailableException('文件发布配置无效，请联系平台管理员');
  }
}

function parseLink(raw: unknown): TableLink | null {
  if (typeof raw !== 'string' || raw.length > 1000 || CONTROL.test(raw) || raw.includes('\\')) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/^(?:[a-z0-9-]+\.)*feishu\.cn$/u.test(url.hostname)) return null;
    const match = /^\/(base|wiki|bitable)\/([A-Za-z0-9_-]{1,160})\/?$/u.exec(url.pathname);
    const tableIds = url.searchParams.getAll('table');
    if (!match || tableIds.length !== 1 || !/^tbl[A-Za-z0-9_-]{1,100}$/u.test(tableIds[0])) return null;
    const kind = match[1] === 'wiki' ? 'wiki' : 'base';
    const tableId = tableIds[0];
    const key = `${url.hostname}/${kind}/${match[2]}?table=${tableId}`;
    return { key, url: `https://${key}`, kind, token: match[2], tableId };
  } catch {
    return null;
  }
}

function configuredTables(): ConfiguredTable[] {
  const tables = configuration('FILE_PUBLICATION_TABLES_JSON', row => {
    const link = parseLink(row.url);
    const name = label(row.label);
    const extras = row.extraFields ?? [];
    if (!link || !name || !Array.isArray(extras) || extras.length > 12 || extras.some(value => !label(value))) return null;
    return { ...link, label: name, extraFields: extras.map(label) };
  }, JSON.stringify([{
    label: '文件发布台账',
    url: 'https://vnet.feishu.cn/base/MliKbC3fXa8PXrsndKscmxjdn1g?table=tblzKmM9oQrtJwIw',
  }]));
  if (new Set(tables.map(table => table.key)).size !== tables.length) {
    throw new ServiceUnavailableException('文件发布台账配置重复');
  }
  return tables;
}

function checkFiles(files: readonly FilePublicationFile[], allowEmpty: boolean): void {
  if (!Array.isArray(files) || (!allowEmpty && files.length === 0) || files.length > MAX_FILES) {
    throw new BadRequestException('请选择 1 至 10 个文件');
  }
  let bytes = 0;
  for (const file of files) {
    if (typeof file?.name !== 'string' || !file.name.trim() || Array.from(file.name).length > 180 ||
      CONTROL.test(file.name) || /[\\/]/u.test(file.name) ||
      !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_BYTES) {
      throw new BadRequestException('文件名或文件大小无效，每个文件最多 20 MB');
    }
    bytes += file.size;
  }
  if (bytes > MAX_BATCH_BYTES) throw new BadRequestException('每批文件合计最多 50 MB');
}

function inferMetadata(files: readonly FilePublicationFile[]) {
  if (!files.length) return { title: '', code: '', notes: '' };
  const stem = files[0].name.trim().replace(/\.[^.]+$/u, '');
  const prefix = /^(?<code>[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*[-_]\d{2,})(?=$|[\s_\-—·：:]|[\u3400-\u9fff])/u.exec(stem);
  const code = prefix?.groups?.code || `FP-${createHash('sha256').update(JSON.stringify(files.map(file => [file.name, file.size]))).digest('hex').slice(0, 10).toUpperCase()}`;
  const title = stem.slice(prefix?.[0].length || 0).replace(/^[\s_\-—·：:]+/u, '') || stem || files[0].name;
  const notes = `附件 ${files.length} 个：${files.map(file => file.name).join('、')}`;
  return { title, code, notes: Array.from(notes).slice(0, 2000).join('') };
}

function namedField(fields: TableField[], names: readonly string[], type: number): TableField | undefined {
  return names.map(name => fields.find(field => field.type === type && field.name === name)).find(Boolean);
}

function recordText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.map(item => object(item).text ?? '').join('') : '';
}

function recordsUrl(target: { appToken: string; tableId: string }): string {
  return `${FEISHU}/bitable/v1/apps/${target.appToken}/tables/${target.tableId}/records`;
}

function recordUrl(target: FilePublicationRecordTarget, id: string): string {
  if (!RECORD_ID.test(id)) throw new BadRequestException('台账记录编号无效');
  return `${recordsUrl(target)}/${id}`;
}

function isPageToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !CONTROL.test(value);
}

function recordApiError(label: string, code: unknown) {
  if (code === 1254302 || code === 1254304) {
    return new ForbiddenException(`${label}失败，请检查飞书应用对该表的权限`);
  }
  if (typeof code === 'number' && RECORD_FIELD_ERRORS.has(code)) {
    return new BadRequestException(`${label}失败，飞书拒绝了字段或其值，请刷新字段后检查内容`);
  }
  const detail = typeof code === 'number' ? `（飞书 ${code}）` : '';
  return new BadGatewayException(`${label}失败${detail}，请稍后核对结果`);
}

function tableRecord(value: unknown, expectedId?: string): FilePublicationTableRecord {
  const { record_id: id, fields } = object(value);
  if (typeof id !== 'string' || !RECORD_ID.test(id) || (expectedId !== undefined && id !== expectedId) ||
      fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new BadGatewayException('台账记录回执无效');
  }
  return { id, fields: object(fields) };
}

function selectOptions(value: unknown): NonNullable<TableField['options']> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadGatewayException('台账选项回执无效');
  const options = value.map(item => {
    const { id, name } = object(item);
    if (typeof id !== 'string' || !TOKEN.test(id) || typeof name !== 'string' || !name.trim() || CONTROL.test(name)) {
      throw new BadGatewayException('台账选项回执无效');
    }
    return { id, name };
  });
  if (new Set(options.map(option => option.id)).size !== options.length ||
      new Set(options.map(option => option.name)).size !== options.length) {
    throw new BadGatewayException('台账选项无法唯一识别');
  }
  return options;
}

export function buildFilePublicationCard(batch: {
  title: string; code: string; files: readonly FilePublicationFile[];
}, pageUrl: string): Record<string, unknown> {
  const line = (content: string) => ({ tag: 'div', text: { tag: 'plain_text', content } });
  return {
    schema: '2.0',
    header: { template: 'blue', title: { tag: 'plain_text', content: '文件发布通知' } },
    body: { elements: [
      line(batch.title),
      ...(batch.code ? [line(`文件编号：${batch.code}`)] : []),
      line(`附件 ${batch.files.length} 个`),
      ...batch.files.map(file => line(`${file.name}（${file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}）`)),
      { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看并下载文件' },
        behaviors: [{ type: 'open_url', default_url: pageUrl }] },
    ] },
  };
}

@Injectable()
export class FilePublicationGateway {
  constructor(private readonly http: HttpService) {}

  groups(): FilePublicationGroup[] {
    const groups = configuration('FILE_PUBLICATION_GROUPS_JSON', row => {
      const id = typeof row.id === 'string' && /^oc_[\w-]{1,120}$/u.test(row.id) ? row.id : '';
      const name = label(row.name);
      return id && name ? { id, name } : null;
    });
    if (new Set(groups.map(group => group.id)).size !== groups.length) {
      throw new ServiceUnavailableException('文件发布接收群组配置重复');
    }
    return groups;
  }

  tables(): Array<{ key: string; label: string; link: string }> {
    return configuredTables().map(table => ({ key: table.key, label: table.label, link: table.url }));
  }

  async getRecordSchema(link: string): Promise<FilePublicationRecordSchema> {
    const target = await this.target(link);
    const auth = await this.tenantToken();
    const fields = await this.listFields(target, auth, true);
    return {
      tableName: target.label,
      sourceUrl: target.url,
      appToken: target.appToken,
      tableId: target.tableId,
      fields: fields.map(({ id, name, type, options }) => ({ key: id, name, type, ...(options ? { options } : {}) })),
    };
  }

  async listTableRecords(
    link: string, pageToken?: string, expectedTarget?: FilePublicationRecordTarget,
    search?: { keyword: string; fieldNames: readonly string[] },
  ): Promise<{
    records: FilePublicationTableRecord[];
    pageToken?: string;
    total?: number;
  }> {
    if (pageToken !== undefined && !isPageToken(pageToken)) throw new BadRequestException('台账分页参数无效');
    const target = await this.recordTarget(link, expectedTarget);
    const auth = await this.tenantToken();
    const config = {
      ...this.request(auth), params: { page_size: RECORD_PAGE_SIZE, ...(pageToken ? { page_token: pageToken } : {}) },
    };
    const url = recordsUrl(target);
    const data = search
      ? await this.api('搜索台账记录', () => this.http.axiosRef.post(`${url}/search`, {
        filter: { conjunction: 'or', conditions: search.fieldNames.map(field_name => ({
          field_name, operator: 'contains', value: [search.keyword],
        })) },
      }, config), 'table')
      : await this.api('读取台账记录', () => this.http.axiosRef.get(url, {
        ...config, params: { ...config.params, text_field_as_array: true },
      }), 'table');
    const explicitEmptyFirstPage = pageToken === undefined && !Object.hasOwn(data, 'items') &&
      data.has_more === false && data.total === 0 && (data.page_token === undefined || data.page_token === '');
    const items = explicitEmptyFirstPage ? [] : data.items;
    if (!Array.isArray(items) || items.length > RECORD_PAGE_SIZE ||
        (data.has_more !== undefined && typeof data.has_more !== 'boolean')) {
      throw new BadGatewayException('台账记录分页回执无效');
    }
    const records = items.map(item => tableRecord(item));
    if (new Set(records.map(record => record.id)).size !== records.length) {
      throw new BadGatewayException('台账记录无法唯一识别');
    }
    const total = typeof data.total === 'number' && Number.isSafeInteger(data.total) && data.total >= records.length
      ? data.total : undefined;
    const page = { records, ...(total !== undefined ? { total } : {}) };
    if (!data.has_more) return page;
    if (!isPageToken(data.page_token) || data.page_token === pageToken) {
      throw new BadGatewayException('台账记录分页回执无效');
    }
    return { ...page, pageToken: data.page_token };
  }

  async getTableRecord(link: string, id: string, expectedTarget?: FilePublicationRecordTarget): Promise<FilePublicationTableRecord | null> {
    const target = await this.recordTarget(link, expectedTarget);
    const url = recordUrl(target, id);
    const auth = await this.tenantToken();
    const data = await this.api('核对台账记录', () => this.http.axiosRef.get(url, {
      ...this.request(auth), params: { text_field_as_array: true },
    }), 'table-or-missing');
    return data === null ? null : tableRecord(data.record, id);
  }

  async createTableRecord(
    link: string, clientToken: string, fields: Record<string, unknown>, expectedTarget?: FilePublicationRecordTarget,
  ): Promise<FilePublicationTableRecord> {
    if (!UUID.test(clientToken)) throw new BadRequestException('台账新增请求编号无效');
    const target = await this.recordTarget(link, expectedTarget);
    const auth = await this.tenantToken();
    const data = await this.api('新增台账记录', () => this.http.axiosRef.post(recordsUrl(target), { fields }, {
      ...this.request(auth), params: { client_token: clientToken, ignore_consistency_check: false },
    }), 'table');
    return tableRecord(data.record);
  }

  async updateTableRecord(
    link: string, id: string, fields: Record<string, unknown>, expectedTarget?: FilePublicationRecordTarget,
  ): Promise<FilePublicationTableRecord> {
    const target = await this.recordTarget(link, expectedTarget);
    const url = recordUrl(target, id);
    const auth = await this.tenantToken();
    const data = await this.api('修改台账记录', () => this.http.axiosRef.put(url, { fields }, {
      ...this.request(auth), params: { ignore_consistency_check: false },
    }), 'table');
    return tableRecord(data.record, id);
  }

  async deleteTableRecord(link: string, id: string, expectedTarget?: FilePublicationRecordTarget): Promise<void> {
    const target = await this.recordTarget(link, expectedTarget);
    const url = recordUrl(target, id);
    const auth = await this.tenantToken();
    const data = await this.api('删除台账记录', () => this.http.axiosRef.delete(url, {
      ...this.request(auth), params: { ignore_consistency_check: false },
    }), 'table');
    if (data.deleted !== true || data.record_id !== id) throw new BadGatewayException('删除台账记录结果待核对');
  }

  async parse(link: string, files: readonly FilePublicationFile[]): Promise<FilePublicationPreview> {
    checkFiles(files, true);
    return (await this.inspect(link, files)).preview;
  }

  async prepareBatch(input: {
    batchId: string; link: string; metadata: Record<string, string>;
    files: readonly (FilePublicationFile & { path: string })[];
    schemaVersion?: string;
  }): Promise<PreparedFilePublication> {
    this.assertBatchId(input.batchId);
    checkFiles(input.files, false);
    const { target, preview, attachment, title, code, batch } = await this.inspect(input.link, input.files);
    if (input.schemaVersion && input.schemaVersion !== preview.schemaVersion) {
      throw new BadRequestException('多维表写入字段已变化，请重新解析后提交');
    }
    const metadata = object(input.metadata);
    const edits = Object.entries(metadata);
    const fieldLimits = new Map(preview.fields.map(field => [field.key, field.maxLength]));
    if (edits.some(([key, value]) => typeof value !== 'string' ||
      Array.from(value).length > (fieldLimits.get(key) ?? -1) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))) {
      throw new BadRequestException('资料字段或内容无效，请重新解析后编辑');
    }
    const fields: PreparedFilePublication['fields'] = Object.fromEntries(preview.fields.map(field => [
      field.name, Object.hasOwn(metadata, field.key) ? String(metadata[field.key]).trim() : field.value,
    ]));
    const selectedTitle = String(fields[title.name] || '');
    if (!selectedTitle) throw new BadRequestException('请填写资料名称');
    if (batch) fields[batch.name] = input.batchId;

    const configured = await this.target(input.link);
    if (target.appToken !== configured.appToken || target.tableId !== configured.tableId) {
      throw new ServiceUnavailableException('文件发布台账刚刚发生变化，请重新解析');
    }
    const token = await this.tenantToken();
    const attachments: Array<{ file_token: string }> = [];
    for (const file of input.files) {
      attachments.push({ file_token: await this.uploadAttachment(target.appToken, file, token) });
    }
    fields[attachment.name] = attachments;
    return {
      tableName: preview.tableName, sourceUrl: preview.sourceUrl, title: selectedTitle,
      code: code ? String(fields[code.name] || '') : preview.code,
      appToken: target.appToken, tableId: target.tableId,
      ...(batch ? { batchField: batch.name } : {}),
      fields,
    };
  }

  async commitBatch(prepared: PreparedFilePublication, batchId: string): Promise<string> {
    this.assertBatchId(batchId);
    const target = await this.assertPreparedTarget(prepared, batchId);
    const auth = await this.tenantToken();
    try {
      const data = await this.api('写入文件发布台账', () => this.http.axiosRef.post(
        recordsUrl(target), { fields: prepared.fields },
        { ...this.request(auth), params: { client_token: batchId, ignore_consistency_check: false } },
      ));
      const id = object(data.record).record_id;
      if (typeof id === 'string' && /^rec[\w-]{1,120}$/u.test(id)) return id;
    } catch (error) {
      const recovered = await this.findCommittedBatch(prepared, batchId).catch(() => null);
      if (recovered) return recovered;
      throw error;
    }
    const recovered = await this.findCommittedBatch(prepared, batchId);
    if (recovered) return recovered;
    throw new BadGatewayException('文件发布台账写入结果待核对，请保留原批次重试');
  }

  async findCommittedBatch(prepared: PreparedFilePublication, batchId: string): Promise<string | null> {
    this.assertBatchId(batchId);
    if (!prepared.batchField) return null;
    const target = await this.assertPreparedTarget(prepared, batchId);
    const auth = await this.tenantToken();
    const data = await this.api('核对文件发布台账', () => this.http.axiosRef.post(`${recordsUrl(target)}/search`, {
      field_names: Object.keys(prepared.fields),
      filter: { conjunction: 'and', conditions: [{ field_name: prepared.batchField, operator: 'is', value: [batchId] }] },
    }, { ...this.request(auth), params: { page_size: 10 } }));
    if (!Array.isArray(data.items) || data.has_more || data.items.length > 1) {
      throw new BadGatewayException('文件发布台账批次无法唯一核对');
    }
    if (!data.items.length) return null;
    const row = object(data.items[0]);
    const stored = object(row.fields);
    const matches = Object.entries(prepared.fields).every(([name, expected]) => {
      const actual = stored[name];
      if (typeof expected === 'string') return recordText(actual) === expected;
      return Array.isArray(actual) && actual.length === expected.length &&
        expected.every((file, index) => file.file_token === object(actual[index]).file_token);
    });
    if (!matches || recordText(stored[prepared.batchField]) !== batchId ||
      typeof row.record_id !== 'string' || !/^rec[\w-]{1,120}$/u.test(row.record_id)) {
      throw new BadGatewayException('文件发布台账批次回执无效');
    }
    return row.record_id;
  }

  async resolveManualRecipients(inputs: readonly string[]): Promise<FilePublicationGroup[]> {
    if (inputs.some(input => /^o[cu]_/iu.test(input) && !CHAT_ID.test(input) && !OPEN_ID.test(input))) {
      throw new BadRequestException('请核对通知对象中的飞书人员 Open ID 或群会话 ID');
    }
    const groups = new Map(this.groups().map(group => [group.id, group]));
    const peopleInputs = inputs.filter(input => !CHAT_ID.test(input));
    const people = new Map<string, FilePublicationGroup>();
    if (peopleInputs.length) {
      const directory = await readCachedActivePersonnel();
      if (!directory || directory.snapshot.stale) throw new ServiceUnavailableException('在职人员资料正在同步，请稍后重试');
      const roster = directory.selectablePersonnel ?? directory.personnel;
      for (const input of peopleInputs) {
        const directId = OPEN_ID.test(input);
        const matches = roster.filter(person => directId
          ? person.openId === input
          : person.name.trim().normalize('NFC') === input);
        const person = matches[0];
        if (!person) throw new BadRequestException(`未找到通知人员“${input}”，请核对姓名或本应用 Open ID`);
        if (!directId && matches.length > 1 && !matches.every(match => match.openId === person.openId && OPEN_ID.test(match.openId))) {
          throw new BadRequestException(`通知人员“${input}”重名，请填写对应的飞书 Open ID`);
        }
        if (!OPEN_ID.test(person.openId)) throw new BadRequestException(`“${person.name}”尚未绑定可接收通知的飞书账号`);
        people.set(input, { id: person.openId, name: person.name, kind: 'person' });
      }
    }
    const customChatIds = inputs.filter(input => CHAT_ID.test(input) && !groups.has(input));
    if (customChatIds.length) {
      const auth = await this.tenantToken();
      const chats = await Promise.all(customChatIds.map(async id => {
        const data = await this.api('核对文件发布通知群', () => this.http.axiosRef.get(
          `${FEISHU}/im/v1/chats/${id}`, this.request(auth),
        ));
        const name = label(data.name);
        if (!name || (data.chat_mode !== 'group' && data.chat_mode !== 'topic')) {
          throw new BadRequestException(`无法核对群“${id}”，请确认会话 ID 正确且机器人已加入该群`);
        }
        return { id, name, kind: 'group' as const };
      }));
      for (const chat of chats) groups.set(chat.id, chat);
    }
    return inputs.map(input => (CHAT_ID.test(input) ? groups.get(input) : people.get(input))!);
  }

  async notifyRecipient(batch: { id: string; title: string; code: string; files: readonly FilePublicationFile[] }, group: FilePublicationGroup): Promise<string> {
    this.assertBatchId(batch.id);
    checkFiles(batch.files, false);
    const idType = group.kind === 'person' ? 'open_id' : 'chat_id';
    if (idType === 'open_id' ? !OPEN_ID.test(group.id) : !CHAT_ID.test(group.id)) {
      throw new FilePublicationDeliveryRejected('文件发布通知对象编号无效');
    }
    if (!group.kind && !this.groups().some(configured => configured.id === group.id)) {
      throw new FilePublicationDeliveryRejected('文件发布接收群组未在允许名单中');
    }
    let page: URL;
    try {
      page = new URL(readPublicApplicationUrl(['FEISHU_PUBLIC_BASE_URL', 'APP_PUBLIC_URL']));
      if (page.protocol !== 'https:' || page.username || page.password || page.search || page.hash) throw new Error();
      page.pathname = `${page.pathname.replace(/\/+$/u, '')}/file-publication`;
      page.searchParams.set('batch', batch.id);
    } catch {
      throw new FilePublicationDeliveryRejected('文件发布通知链接未配置');
    }
    const content = JSON.stringify(buildFilePublicationCard(batch, page.toString()));
    if (Buffer.byteLength(content) > 30 * 1024) throw new FilePublicationDeliveryRejected('文件发布通知内容过长');
    const uuid = createHash('sha256').update(`file-publication:${batch.id}:${group.id}`).digest('hex').slice(0, 45);
    const auth = await this.tenantToken().catch(() => {
      throw new FilePublicationDeliveryRejected('文件发布飞书应用认证失败');
    });
    let reply: Record<string, unknown>;
    try {
      reply = object((await this.http.axiosRef.post(`${FEISHU}/im/v1/messages`, {
        receive_id: group.id, msg_type: 'interactive', content, uuid,
      }, { ...this.request(auth), params: { receive_id_type: idType } })).data);
    } catch (error) {
      const rejected = object(object(object(error).response).data).code;
      const reason = typeof rejected === 'number' ? deliveryRejections.get(rejected) : undefined;
      if (reason) throw new FilePublicationDeliveryRejected(reason);
      throw new BadGatewayException('文件发布通知结果待核对');
    }
    const rejected = typeof reply.code === 'number' ? deliveryRejections.get(reply.code) : undefined;
    if (rejected) throw new FilePublicationDeliveryRejected(rejected);
    if (reply.code !== 0) throw new BadGatewayException('文件发布通知结果待核对');
    const data = object(reply.data);
    if (typeof data.message_id !== 'string' || !/^om_[\w-]+$/u.test(data.message_id)) {
      throw new BadGatewayException('文件发布通知结果待核对');
    }
    return data.message_id;
  }

  private async inspect(link: string, files: readonly FilePublicationFile[]) {
    const target = await this.target(link);
    const auth = await this.tenantToken();
    const fields = await this.listFields(target, auth);
    const batch = namedField(fields, METADATA_NAMES.batch, 1);
    const code = namedField(fields, METADATA_NAMES.code, 1);
    const notes = namedField(fields, METADATA_NAMES.notes, 1);
    const title = namedField(fields, METADATA_NAMES.title, 1) ??
      fields.find(field => field.primary && field.type === 1 && field !== batch && field !== code && field !== notes);
    const attachments = fields.filter(field => field.type === 17);
    const attachment = namedField(attachments, METADATA_NAMES.attachment, 17) ??
      (attachments.length === 1 ? attachments[0] : undefined);
    if (!title || !attachment) throw new BadRequestException('台账需要资料名称文本列和可唯一识别的附件列');

    const inferred = inferMetadata(files);
    const displayField = (field: TableField, value: string): FilePublicationPreview['fields'][number] => ({
      key: field.id, name: field.name, value, maxLength: field === title || field === code ? 180 : 2000,
      ...(field === title ? { required: true } : {}),
    });
    const previewFields = [displayField(title, inferred.title)];
    if (code) previewFields.push(displayField(code, inferred.code));
    if (notes) previewFields.push(displayField(notes, inferred.notes));
    for (const name of new Set(target.extraFields)) {
      const field = fields.find(row => row.name === name && row.type === 1);
      if (field && field !== batch && !previewFields.some(row => row.key === field.id)) {
        previewFields.push(displayField(field, ''));
      }
    }
    const mapping = (field: TableField) => ({ key: field.id, name: field.name });
    const schemaVersion = createHash('sha256').update(JSON.stringify([
      target.appToken, target.tableId, mapping(title), code && mapping(code),
      mapping(attachment), batch && mapping(batch), previewFields.map(({ key, name }) => [key, name]),
    ])).digest('hex');
    return { target, attachment, title, code, batch, preview: {
      tableName: target.label, sourceUrl: target.url,
      title: inferred.title, code: inferred.code, fields: previewFields,
      attachmentField: mapping(attachment), schemaVersion,
      ...(code ? { codeFieldKey: code.id } : {}),
      ...(batch ? { batchField: mapping(batch) } : {}),
    } };
  }

  private async target(link: string): Promise<ConfiguredTable & { appToken: string }> {
    const parsed = parseLink(link);
    if (!parsed) throw new BadRequestException('请输入包含数据表的飞书多维表链接');
    const table = configuredTables().find(entry => entry.key === parsed.key);
    if (!table) throw new BadRequestException('该多维表尚未配置为文件发布台账');
    if (table.kind === 'base') return { ...table, appToken: table.token };
    const auth = await this.tenantToken();
    const data = await this.api('解析飞书知识库链接', () => this.http.axiosRef.get(`${FEISHU}/wiki/v2/spaces/get_node`, {
      ...this.request(auth), params: { token: table.token },
    }));
    const node = object(data.node);
    if (node.obj_type !== 'bitable' || typeof node.obj_token !== 'string' || !TOKEN.test(node.obj_token)) {
      throw new BadRequestException('选择的知识库链接不是有效多维表');
    }
    return { ...table, appToken: node.obj_token };
  }

  private async assertPreparedTarget(prepared: PreparedFilePublication, batchId: string) {
    const target = await this.target(prepared.sourceUrl);
    if (target.appToken !== prepared.appToken || target.tableId !== prepared.tableId ||
      (prepared.batchField && prepared.fields[prepared.batchField] !== batchId)) {
      throw new ServiceUnavailableException('已准备的文件发布批次与当前台账配置不一致');
    }
    return target;
  }

  private async recordTarget(link: string, expected?: FilePublicationRecordTarget) {
    const target = await this.target(link);
    if (expected && (target.appToken !== expected.appToken || target.tableId !== expected.tableId)) {
      throw new ConflictException('链接对应的多维表已变化，请重新加载');
    }
    return target;
  }

  private async listFields(target: FilePublicationRecordTarget, auth: string, recordSchema = false): Promise<TableField[]> {
    const fields: TableField[] = [];
    const seen = new Set<string>();
    let token = '';
    do {
      const data = await this.api('读取台账字段', () => this.http.axiosRef.get(
        `${FEISHU}/bitable/v1/apps/${target.appToken}/tables/${target.tableId}/fields`, {
          ...this.request(auth), params: { page_size: 100, ...(token ? { page_token: token } : {}) },
        },
      ), recordSchema ? 'table' : undefined);
      if (!Array.isArray(data.items)) throw new BadGatewayException('台账字段回执无效');
      for (const item of data.items) {
        const row = object(item);
        const name = row.field_name;
        const validName = typeof name === 'string' && !!name.trim() && !CONTROL.test(name) &&
          !RESERVED_FIELDS.has(name) && (recordSchema || name === label(name));
        if (typeof row.field_id === 'string' && /^fld[\w-]{1,100}$/u.test(row.field_id) && validName && typeof row.type === 'number' &&
          (!recordSchema || (Number.isSafeInteger(row.type) && row.type > 0))) {
          const field: TableField = { id: row.field_id, name, type: row.type, primary: row.is_primary === true };
          if (recordSchema && (row.type === 3 || row.type === 4)) field.options = selectOptions(object(row.property).options);
          fields.push(field);
        } else if (recordSchema) {
          throw new BadGatewayException('台账字段回执无效');
        }
      }
      if (!data.has_more) break;
      if (typeof data.page_token !== 'string' || !data.page_token || seen.has(data.page_token) || seen.size >= 20) {
        throw new BadGatewayException('台账字段分页结果异常');
      }
      seen.add(data.page_token);
      token = data.page_token;
    } while (token);
    if (new Set(fields.map(field => field.id)).size !== fields.length ||
      new Set(fields.map(field => field.name)).size !== fields.length) {
      throw new BadGatewayException('台账字段无法唯一识别，请重新配置');
    }
    return fields;
  }

  private async uploadAttachment(appToken: string, file: FilePublicationFile & { path: string }, auth: string): Promise<string> {
    const stat = await lstat(file.path);
    if (!stat.isFile() || stat.size !== file.size) throw new BadRequestException('批次附件已变化，请重新上传');
    const form = new FormData();
    form.append('file_name', file.name);
    form.append('parent_type', 'bitable_file');
    form.append('parent_node', appToken);
    form.append('size', String(file.size));
    const stream = createReadStream(file.path);
    form.append('file', stream, { filename: file.name, contentType: 'application/octet-stream', knownLength: file.size });
    try {
      const data = await this.api('上传文件发布附件', () => this.http.axiosRef.post(`${FEISHU}/drive/v1/medias/upload_all`, form, {
        ...this.request(auth), timeout: 60_000, maxBodyLength: MAX_FILE_BYTES + 1024 * 1024,
        headers: { ...form.getHeaders(), Authorization: `Bearer ${auth}` },
      }));
      if (typeof data.file_token !== 'string' || !/^[\w-]{1,256}$/u.test(data.file_token)) {
        throw new BadGatewayException('上传附件回执无效');
      }
      return data.file_token;
    } finally {
      stream.destroy();
    }
  }

  private assertBatchId(id: string): void {
    if (!UUID.test(id)) throw new BadRequestException('文件发布批次编号无效');
  }

  private request(token: string) {
    return { headers: { Authorization: `Bearer ${token}` }, timeout: 20_000, maxRedirects: 0 };
  }

  private async tenantToken(): Promise<string> {
    try {
      return await getTenantAccessToken(this.http);
    } catch {
      throw new ServiceUnavailableException('文件发布飞书应用认证失败');
    }
  }

  private api(label: string, request: () => Promise<{ data: unknown }>, mode?: 'table'): Promise<Record<string, unknown>>;
  private api(label: string, request: () => Promise<{ data: unknown }>, mode: 'table-or-missing'): Promise<Record<string, unknown> | null>;
  private async api(label: string, request: () => Promise<{ data: unknown }>, mode?: 'table' | 'table-or-missing'): Promise<Record<string, unknown> | null> {
    let response: Record<string, unknown>;
    try {
      response = object((await request()).data);
    } catch (error) {
      const rejected = object(object(error).response);
      const code = object(rejected.data).code;
      if (mode === 'table-or-missing' && code === RECORD_MISSING_CODE) return null;
      if (mode) throw recordApiError(label, code);
      throw new BadGatewayException(`${label}失败，请使用原批次重试`);
    }
    if (mode === 'table-or-missing' && response.code === RECORD_MISSING_CODE) return null;
    if (response.code !== 0) {
      if (mode) throw recordApiError(label, response.code);
      const code = typeof response.code === 'number' ? `（飞书 ${response.code}）` : '';
      throw new BadGatewayException(`${label}失败${code}`);
    }
    return object(response.data);
  }
}
